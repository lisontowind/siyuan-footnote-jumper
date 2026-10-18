import {confirm, fetchSyncPost, getActiveEditor, getAllEditor, getFrontend, IOperation, IProtyle, Menu, openMobileFileById, openTab, Plugin, showMessage} from "siyuan";
import {DefinitionCandidate, indexDefinitions, parseDefinition, readDocumentDefinitions, readOrderedDefinitions, StoredDefinition} from "./definitions";
import {FootnoteManager} from "./manager";
import {DEFAULT_PREFERENCES, FootnotePreferences} from "./document";
import {flushDocumentEdits, TABLE_SAVE_MESSAGE} from "./editing";
import {isSuperscript, markerIsSuperscript, readMarkers, replaceTextRun, visitInline, wrapTextRun} from "./inline";
import "./index.scss";

const STORAGE_NAME = "footnote-jumper-settings";
const ENHANCED_ATTR = "data-siyuan-footnote-enhanced";
const REF_CLASS = "siyuan-footnote-ref";
const DEF_CLASS = "siyuan-footnote-definition";
const HIGHLIGHT_CLASS = "siyuan-footnote-definition--highlight";
const MISSING_CLASS = "siyuan-footnote-ref--missing";
const CONFLICT_CLASS = "siyuan-footnote-ref--conflict";
const TOOLTIP_CLASS = "siyuan-footnote-tooltip";
const TOOLTIP_VISIBLE_CLASS = "siyuan-footnote-tooltip--visible";
const RETURN_BUTTON_CLASS = "siyuan-footnote-return";
const NATIVE_BLOCK_REF_TYPE = "block-ref";
const NATIVE_REF_CLASS = "siyuan-footnote-native-ref";
const ACTIVE_REFRESH_DELAY = 1000;
const INACTIVE_REFRESH_DELAY = 200;
const TOOLTIP_HIDE_DELAY = 300;
const TABLE_EDIT_MESSAGE = TABLE_SAVE_MESSAGE;

interface FootnoteSettings {
    enabled: boolean;
    liveRefreshEditingBlock: boolean;
    panelAutoRefresh: boolean;
    preferences?: FootnotePreferences;
}

interface FootnoteDefinition extends StoredDefinition {
    element?: HTMLElement;
}

interface DocumentDefinitions {
    definitions: Map<string, StoredDefinition>;
    expiresAt: number;
    loading?: Promise<void>;
}

interface SelectionBookmark {
    start: number;
    end: number;
}

interface NativeBlockRefUpdate {
    operation: IOperation;
    undoOperation: IOperation;
    referenceCount: number;
}

interface KernelOperation extends IOperation {
    rootID?: string;
}

interface KernelTransaction {
    rootID?: string;
    doOperations?: KernelOperation[];
}

interface FootnoteOrigin {
    rootId: string;
    blockId: string;
    footnoteId: string;
    referenceIndex: number;
}

export default class FootnoteJumperPlugin extends Plugin {
    private enabled = false;
    private jumpStyleEnabled = true;
    private preferences: FootnotePreferences = {...DEFAULT_PREFERENCES};
    private manualRefreshPending = false;
    private manualRefreshEditor?: IProtyle;
    private liveRefreshEditingBlock = true;
    private panelAutoRefresh = true;
    private observer?: MutationObserver;
    private refreshTimer = 0;
    private refreshTimerAt = 0;
    private activeRefreshAt = 0;
    private isRendering = false;
    private isComposing = false;
    private suppressSelectionSync = false;
    private editorProtyles = new WeakMap<HTMLElement, IProtyle>();
    private documentDefinitions = new Map<string, DocumentDefinitions>();
    private definitionRefreshAfter = new Map<string, number>();
    private blockRootIds = new Map<string, string>();
    private definitionDirtyRoots = new Set<string>();
    private unloaded = false;
    private definitionSignatures = new WeakMap<HTMLElement, string>();
    private orderedDefinitionBlocks = new WeakMap<HTMLElement, DefinitionCandidate>();
    private dirtyBlocks = new Set<HTMLElement>();
    private activeBlock?: HTMLElement;
    private activeBlockId?: string;
    private tooltipElement?: HTMLElement;
    private activeTooltipRef?: HTMLElement;
    private tooltipHideTimer = 0;
    private tooltipInteracting = false;
    private returnOrigin?: FootnoteOrigin;
    private returnButton?: HTMLButtonElement;
    private isAddingNativeBlockRefs = false;
    private footnoteManager?: FootnoteManager;

    private readonly handleDocumentClick = (event: MouseEvent) => {
        if (!this.enabled) {
            return;
        }

        const target = event.target as HTMLElement;
        if (this.isReturnButtonTarget(target)) {
            event.preventDefault();
            event.stopPropagation();
            void this.returnToReference();
            return;
        }
        const refElement = target?.closest?.(`.${REF_CLASS}`) as HTMLElement;
        if (!refElement) {
            return;
        }

        const id = refElement.dataset.footnoteId;
        if (!id) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        void this.jumpToDefinition(id, refElement);
    };

    private readonly handleProtyleLoaded = (event: CustomEvent<{protyle: IProtyle}>) => {
        const protyle = event.detail.protyle;
        if (protyle?.wysiwyg?.element?.closest("[data-footnote-sidebar]")) return;
        this.registerEditor(protyle);
        if (this.enabled && protyle.wysiwyg?.element) {
            this.markEditorDirty(protyle.wysiwyg.element);
            this.scheduleRefresh(50);
        }
    };

    private readonly handleKernelMessage = (event: CustomEvent<{cmd: string; data?: KernelTransaction | KernelTransaction[]}>) => {
        if (["transactions", "refresh", "syncFinish"].indexOf(event.detail.cmd) < 0) {
            return;
        }
        const data = event.detail.data;
        const transactions = Array.isArray(data) ? data : data ? [data] : [];
        const operations = transactions.reduce<KernelOperation[]>((all, transaction) =>
            all.concat(transaction.doOperations || []), []);
        const roots = new Set<string>();
        let unknown = !transactions.length;
        for (const transaction of transactions) {
            if (transaction.rootID && !transaction.doOperations?.length) {
                roots.add(transaction.rootID);
            }
            if (!transaction.rootID && !transaction.doOperations?.length) unknown = true;
            for (const operation of transaction.doOperations || []) {
                const rootId = operation.rootID || transaction.rootID
                    || this.blockRootIds.get(operation.id)
                    || this.blockRootIds.get(operation.parentID)
                    || this.blockRootIds.get(operation.previousID);
                if (!rootId) {
                    unknown = true;
                    continue;
                }
                // Ordinary text updates need no new SQL definition index.
                const state = this.documentDefinitions.get(rootId);
                const wasDefinition = Array.from(state?.definitions.values() || []).some((definition) =>
                    (definition.candidates || [definition]).some((candidate) => candidate.blockId === operation.id));
                if (operation.action !== "update" || wasDefinition || state?.loading
                    || (typeof operation.data === "string" && /\[\^[^\]\s:]+\]:|NodeList|custom-footnote-label/.test(operation.data))) {
                    roots.add(rootId);
                }
                this.markOperationDirty(rootId, operation.id);
            }
        }
        // Synchronization and unrecognized payloads retain the conservative fallback.
        if (event.detail.cmd !== "transactions" || unknown) {
            for (const rootId of this.documentDefinitions.keys()) {
                roots.add(rootId);
            }
            for (const editor of getAllEditor()) {
                const rootId = editor?.protyle?.block?.rootID;
                if (rootId) roots.add(rootId);
            }
        }
        for (const rootId of roots) {
            this.invalidateDocumentDefinitions(rootId);
        }
        if (this.enabled && (roots.size || operations.length)) {
            this.scheduleRefresh(ACTIVE_REFRESH_DELAY);
        }
    };

    private invalidateDocumentDefinitions(rootId: string) {
        this.documentDefinitions.delete(rootId);
        this.definitionRefreshAfter.set(rootId, Date.now() + ACTIVE_REFRESH_DELAY);
        this.definitionDirtyRoots.add(rootId);
    }

    private markOperationDirty(rootId: string, blockId?: string) {
        if (!this.enabled) return;
        for (const editor of getAllEditor()) {
            const protyle = editor?.protyle;
            if (protyle?.block?.rootID !== rootId || !protyle.wysiwyg?.element) continue;
            const block = Array.from(protyle.wysiwyg.element.querySelectorAll<HTMLElement>("[data-node-id]"))
                .find((item) => item.dataset.nodeId === blockId);
            if (block) this.markBlockDirty(block);
        }
    }

    private readonly handleBeforeEdit = (event: Event) => {
        if (!this.enabled || this.isRendering) {
            return;
        }

        const target = event.target as HTMLElement;
        if (!target?.closest?.(".protyle-wysiwyg")) {
            return;
        }

        const block = this.getSelectionBlock() || this.getBlockFromNode(target);
        if (block) {
            this.activateBlock(block);
            this.markBlockDirty(block);
        }
    };

    private readonly handleCompositionStart = (event: CompositionEvent) => {
        this.isComposing = true;
        this.handleBeforeEdit(event);
    };

    private readonly handleCompositionEnd = () => {
        this.isComposing = false;
        if (this.manualRefreshPending) void this.manualRefresh(this.manualRefreshEditor);
        const selectionBlock = this.getSelectionBlock();
        if (selectionBlock) {
            this.activateBlock(selectionBlock);
        }
        if (this.activeBlock) {
            this.markBlockDirty(this.activeBlock);
            if (this.liveRefreshEditingBlock) {
                this.activeRefreshAt = Date.now() + ACTIVE_REFRESH_DELAY;
                this.scheduleRefresh(ACTIVE_REFRESH_DELAY);
            }
        }
    };

    private readonly handlePointerDown = (event: PointerEvent) => {
        if (!this.enabled) {
            return;
        }

        if (this.isTooltipTarget(event.target)) {
            this.tooltipInteracting = true;
            this.cancelTooltipHide();
            return;
        }

        if (this.isReturnButtonTarget(event.target)) {
            return;
        }

        if (this.getReferenceElement(event.target)) {
            this.suppressSelectionSync = true;
            return;
        }

        const block = this.getBlockFromNode(event.target as Node);
        if (block) {
            this.activateBlock(block);
        } else if (this.activeBlock) {
            this.markBlockDirty(this.activeBlock);
            this.activeBlock = undefined;
            this.activeBlockId = undefined;
            this.activeRefreshAt = 0;
            this.scheduleRefresh(50);
        }
    };

    private readonly handlePointerUp = (event: PointerEvent) => {
        if (this.tooltipInteracting) {
            this.tooltipInteracting = false;
            if (!this.isTooltipTarget(event.target) && !this.getReferenceElement(event.target)) {
                this.scheduleTooltipHide();
            }
        }
        if (!this.suppressSelectionSync) {
            return;
        }

        window.setTimeout(() => {
            this.suppressSelectionSync = false;
            this.syncActiveBlock();
        }, 0);
    };

    private readonly handleSelectionChange = () => {
        if (!this.enabled || this.isRendering || this.isComposing || this.suppressSelectionSync
            || this.tooltipInteracting) {
            return;
        }

        this.syncActiveBlock();
    };

    private readonly handlePointerOver = (event: PointerEvent) => {
        if (!this.enabled) {
            return;
        }

        if (this.isTooltipTarget(event.target)) {
            this.cancelTooltipHide();
            return;
        }

        const refElement = this.getReferenceElement(event.target);
        if (!refElement) {
            return;
        }

        this.cancelTooltipHide();
        if (this.activeTooltipRef === refElement) {
            return;
        }
        this.activeTooltipRef = refElement;
        this.showTooltip(refElement);
    };

    private readonly handlePointerMove = (event: PointerEvent) => {
        if (!this.enabled || !this.activeTooltipRef || this.tooltipInteracting
            || this.isTooltipTarget(event.target)) {
            return;
        }

        this.positionTooltip(this.activeTooltipRef);
    };

    private readonly handlePointerOut = (event: PointerEvent) => {
        const refElement = this.getReferenceElement(event.target);
        const fromTooltip = this.isTooltipTarget(event.target);
        if (!refElement && !fromTooltip) {
            return;
        }

        const nextTarget = event.relatedTarget as HTMLElement | null;
        if (nextTarget && (refElement?.contains(nextTarget)
            || this.activeTooltipRef?.contains(nextTarget) || this.isTooltipTarget(nextTarget))) {
            this.cancelTooltipHide();
            return;
        }

        this.scheduleTooltipHide();
    };

    private readonly handleViewportChange = (event: Event) => {
        if (!this.enabled || !this.activeTooltipRef) {
            return;
        }

        if (this.isTooltipTarget(event.target)) {
            return;
        }

        if (!document.body.contains(this.activeTooltipRef)) {
            this.hideTooltip();
            return;
        }

        this.positionTooltip(this.activeTooltipRef);
    };

    onload() {
        this.addIcons(`
            <symbol id="iconFootnoteJumper" viewBox="0 0 32 32">
                <path d="M8 5h16v4H14v5h8v4h-8v9H8V5z"></path>
                <path d="M22 18h3v3h3v3h-3v3h-3v-3h-3v-3h3v-3z"></path>
            </symbol>
        `);
        this.footnoteManager = new FootnoteManager(this, {
            jumpEnabled: () => this.jumpStyleEnabled,
            preferences: () => this.preferences,
            setPreferences: (preferences) => this.setPreferences(preferences),
            liveRefresh: () => this.liveRefreshEditingBlock,
            setLiveRefresh: (enabled) => this.setLiveRefreshEditingBlock(enabled),
            panelAutoRefresh: () => this.panelAutoRefresh,
            setPanelAutoRefresh: (enabled) => {
                this.panelAutoRefresh = enabled;
                this.saveSettings();
            },
            manualRefresh: (editor) => this.manualRefresh(editor.protyle),
            checkDuplicates: (anchor, editor) => void this.checkDuplicateDefinitions(anchor, editor?.protyle),
            setJumpEnabled: (enabled) => this.setEnabled(enabled),
            navigate: async (blockId) => {
                for (const editor of getAllEditor()) {
                    const element = editor?.protyle?.wysiwyg?.element;
                    if (!element || element.closest("[data-footnote-sidebar]")) continue;
                    const block = Array.from(element.querySelectorAll<HTMLElement>("[data-node-id]"))
                        .find((item) => item.dataset.nodeId === blockId && !item.closest('[data-type="NodeBlockQueryEmbed"]'));
                    if (block?.isConnected && element.getClientRects().length) {
                        this.scrollToElement(block);
                        return;
                    }
                }
                await this.openBlock(blockId);
            },
            tablePending: (block) => this.isActiveBlock(block) || this.dirtyBlocks.has(block)
                || Boolean(window.getSelection()?.anchorNode && block.contains(window.getSelection().anchorNode)),
            changed: (rootId) => {
                this.invalidateDocumentDefinitions(rootId);
                for (const editor of getAllEditor()) {
                    if (editor?.protyle?.block?.rootID === rootId) this.markEditorDirty(editor.protyle.wysiwyg.element);
                }
                this.scheduleRefresh(ACTIVE_REFRESH_DELAY);
            },
        });
        this.footnoteManager.register();
    }

    async onLayoutReady() {
        await this.loadSettings();

        for (const editor of getAllEditor()) {
            this.registerEditor(editor?.protyle);
        }
        this.eventBus.on("loaded-protyle-static", this.handleProtyleLoaded);
        this.eventBus.on("loaded-protyle-dynamic", this.handleProtyleLoaded);
        this.eventBus.on("switch-protyle", this.handleProtyleLoaded);
        this.eventBus.on("ws-main", this.handleKernelMessage);

        document.addEventListener("click", this.handleDocumentClick, true);
        document.addEventListener("pointerdown", this.handlePointerDown, true);
        document.addEventListener("pointerup", this.handlePointerUp, true);
        document.addEventListener("pointercancel", this.handlePointerUp, true);
        document.addEventListener("pointerover", this.handlePointerOver, true);
        document.addEventListener("pointermove", this.handlePointerMove, true);
        document.addEventListener("pointerout", this.handlePointerOut, true);
        document.addEventListener("beforeinput", this.handleBeforeEdit, true);
        document.addEventListener("compositionstart", this.handleCompositionStart, true);
        document.addEventListener("compositionend", this.handleCompositionEnd, true);
        document.addEventListener("selectionchange", this.handleSelectionChange);
        document.addEventListener("scroll", this.handleViewportChange, true);
        window.addEventListener("resize", this.handleViewportChange);

        this.observer = new MutationObserver((records) => this.handleMutations(records));
        this.startObserving();

        if (this.enabled) {
            this.activeBlock = this.getSelectionBlock();
            this.activeBlockId = this.activeBlock?.dataset.nodeId;
            this.markAllBlocksDirty();
            this.scheduleRefresh(100);
        }
    }

    onunload() {
        this.unloaded = true;
        this.footnoteManager?.destroy();
        this.footnoteManager = undefined;
        this.documentDefinitions.clear();
        this.blockRootIds.clear();
        this.definitionRefreshAfter.clear();
        this.definitionDirtyRoots.clear();
        this.eventBus.off("loaded-protyle-static", this.handleProtyleLoaded);
        this.eventBus.off("loaded-protyle-dynamic", this.handleProtyleLoaded);
        this.eventBus.off("switch-protyle", this.handleProtyleLoaded);
        this.eventBus.off("ws-main", this.handleKernelMessage);
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = 0;
        this.refreshTimerAt = 0;
        this.observer?.disconnect();
        document.removeEventListener("click", this.handleDocumentClick, true);
        document.removeEventListener("pointerdown", this.handlePointerDown, true);
        document.removeEventListener("pointerup", this.handlePointerUp, true);
        document.removeEventListener("pointercancel", this.handlePointerUp, true);
        document.removeEventListener("pointerover", this.handlePointerOver, true);
        document.removeEventListener("pointermove", this.handlePointerMove, true);
        document.removeEventListener("pointerout", this.handlePointerOut, true);
        document.removeEventListener("beforeinput", this.handleBeforeEdit, true);
        document.removeEventListener("compositionstart", this.handleCompositionStart, true);
        document.removeEventListener("compositionend", this.handleCompositionEnd, true);
        document.removeEventListener("selectionchange", this.handleSelectionChange);
        document.removeEventListener("scroll", this.handleViewportChange, true);
        window.removeEventListener("resize", this.handleViewportChange);
        this.destroyTooltip();
        this.clearReturnOrigin();
        this.cleanupEnhancements();
    }

    private async loadSettings() {
        try {
            const settings = await this.loadData(STORAGE_NAME) as FootnoteSettings;
            if (typeof settings?.enabled === "boolean") {
                this.jumpStyleEnabled = settings.enabled;
            }
            const preferences = settings?.preferences;
            if (preferences) {
                for (const name of ["format", "definitionFormat", "blockLabel"] as const) {
                    const allowed = {format: ["block", "text"], definitionFormat: ["list", "literal"], blockLabel: ["caret", "brackets"]};
                    if (allowed[name].indexOf(preferences[name]) >= 0) (this.preferences as Record<string, unknown>)[name] = preferences[name];
                }
                for (const name of ["renumber", "superscript"] as const) {
                    if (typeof preferences[name] === "boolean") this.preferences[name] = preferences[name];
                }
            }
            if (typeof settings?.liveRefreshEditingBlock === "boolean") {
                this.liveRefreshEditingBlock = settings.liveRefreshEditingBlock;
            }
            if (typeof settings?.panelAutoRefresh === "boolean") {
                this.panelAutoRefresh = settings.panelAutoRefresh;
            }
        } catch (error) {
            console.warn(`[${this.name}] load settings failed`, error);
        }
        this.applyEnabled(this.preferences.format === "text" && this.jumpStyleEnabled);
        this.footnoteManager?.updateJumpStyle(this.jumpStyleEnabled);
        this.footnoteManager?.updatePreferences();
    }

    private saveSettings() {
        const settings: FootnoteSettings = {
            enabled: this.jumpStyleEnabled,
            liveRefreshEditingBlock: this.liveRefreshEditingBlock,
            panelAutoRefresh: this.panelAutoRefresh,
            preferences: {...this.preferences},
        };
        this.saveData(STORAGE_NAME, settings).catch((error) => {
            console.warn(`[${this.name}] save settings failed`, error);
        });
    }

    private setPreferences(preferences: FootnotePreferences) {
        this.preferences = {...preferences};
        this.applyEnabled(preferences.format === "text" && this.jumpStyleEnabled);
        this.saveSettings(); this.footnoteManager?.updatePreferences();
    }

    private setEnabled(enabled: boolean) {
        this.jumpStyleEnabled = enabled;
        this.applyEnabled(this.preferences.format === "text" && enabled);
        this.footnoteManager?.updateJumpStyle(enabled); this.saveSettings();
    }

    private applyEnabled(enabled: boolean) {
        if (this.enabled === enabled) {
            return;
        }

        this.enabled = enabled;

        if (this.enabled) {
            this.documentDefinitions.clear();
            this.startObserving();
            this.activeBlock = this.getSelectionBlock();
            this.activeBlockId = this.activeBlock?.dataset.nodeId;
            this.markAllBlocksDirty();
            this.scheduleRefresh(50);
        } else {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = 0;
            this.refreshTimerAt = 0;
            this.activeRefreshAt = 0;
            this.observer?.disconnect();
            this.dirtyBlocks.clear();
            this.activeBlock = undefined;
            this.activeBlockId = undefined;
            this.hideTooltip();
            this.clearReturnOrigin();
            this.cleanupEnhancements();
        }
    }

    private setLiveRefreshEditingBlock(enabled: boolean) {
        if (this.liveRefreshEditingBlock === enabled) {
            return;
        }

        this.liveRefreshEditingBlock = enabled;
        this.saveSettings();
        this.footnoteManager?.updatePreferences();

        if (!this.activeBlock
            || !Array.from(this.dirtyBlocks).some((block) => block.isConnected && this.isActiveBlock(block))) {
            return;
        }

        if (enabled) {
            this.activeRefreshAt = Date.now() + ACTIVE_REFRESH_DELAY;
            this.scheduleRefresh(ACTIVE_REFRESH_DELAY);
        } else {
            this.activeRefreshAt = 0;
        }
    }

    private async confirmAddNativeBlockRefs() {
        if (this.isAddingNativeBlockRefs || this.unloaded) return;
        const editor = getActiveEditor();
        const wysiwyg = editor?.protyle?.wysiwyg?.element;
        const rootId = editor?.protyle?.block?.rootID;
        if (!wysiwyg || !rootId) {
            showMessage("请先打开需要处理的文档", 3000, "error");
            return;
        }

        this.registerEditor(editor.protyle);
        this.isAddingNativeBlockRefs = true;
        let updates: NativeBlockRefUpdate[];
        try {
            const blocks = await this.readDocumentBlocks(rootId, wysiwyg);
            if (this.unloaded || getActiveEditor()?.protyle !== editor.protyle || this.isComposing) return;
            updates = this.prepareNativeBlockRefUpdates(wysiwyg, blocks);
        } catch (error) {
            console.warn(`[${this.name}] prepare native block refs failed`, error);
            showMessage(error instanceof Error && error.message === TABLE_EDIT_MESSAGE
                ? TABLE_EDIT_MESSAGE : "读取全文失败，请重试", 4000, "error");
            return;
        } finally {
            this.isAddingNativeBlockRefs = false;
        }
        const referenceCount = updates.reduce((count, update) => count + update.referenceCount, 0);
        if (referenceCount === 0) {
            showMessage("全文没有可转换的脚注标记；缺失定义或重复编号的标记会跳过");
            return;
        }

        confirm(
            "为脚注标记添加块引",
            `将在全文（包括尚未加载的正文）中把 ${referenceCount} 个脚注标记替换为静态块引用。`
                + "缺失定义或重复编号的标记会跳过。<br><br>此操作会修改笔记内容，但可以使用撤销恢复。是否继续？",
            () => {
                void this.addNativeBlockRefs(rootId, updates);
            },
        );
    }

    private async addNativeBlockRefs(expectedRootId: string, reviewedUpdates: NativeBlockRefUpdate[]) {
        if (this.isAddingNativeBlockRefs || this.unloaded) {
            return;
        }

        const editor = getActiveEditor();
        const wysiwyg = editor?.protyle?.wysiwyg?.element;
        if (!wysiwyg || editor.protyle.block.rootID !== expectedRootId) {
            showMessage("当前文档已切换，请重新执行该操作", 4000, "error");
            return;
        }

        this.isAddingNativeBlockRefs = true;
        try {
            const blocks = await this.readDocumentBlocks(expectedRootId, wysiwyg);
            if (this.unloaded || this.isComposing || getActiveEditor()?.protyle !== editor.protyle) {
                showMessage("编辑状态已改变，请重新执行该操作", 4000, "error");
                return;
            }
            const updates = this.prepareNativeBlockRefUpdates(wysiwyg, blocks);
            if (JSON.stringify(updates) !== JSON.stringify(reviewedUpdates)) {
                showMessage("脚注或正文已改变，请重新执行并确认转换数量", 4000, "error");
                return;
            }
            editor.transaction(updates.map((update) => update.operation),
                updates.map((update) => update.undoOperation));
            showMessage(`已提交 ${updates.reduce((count, update) => count + update.referenceCount, 0)} 个脚注标记的块引转换`);
        } catch (error) {
            console.error(`[${this.name}] add native block refs failed`, error);
            showMessage(error instanceof Error && error.message === TABLE_EDIT_MESSAGE
                ? TABLE_EDIT_MESSAGE : "添加脚注块引失败，请查看日志", 5000, "error");
        } finally {
            this.isAddingNativeBlockRefs = false;
        }
    }

    private async readDocumentBlocks(rootId: string, wysiwyg: HTMLElement) {
        const editor = getAllEditor().find((item) => item.protyle?.wysiwyg?.element === wysiwyg);
        if (editor && Array.from(wysiwyg.querySelectorAll<HTMLElement>('[data-type="NodeTable"]'))
            .some((block) => block.dataset.type === "NodeTable")) await flushDocumentEdits([editor], () => {
            if (this.unloaded || this.isComposing) throw new Error("请结束输入法组合输入后重试");
            if (editor.protyle.block.rootID !== rootId) throw new Error("当前文档已切换，请重新执行");
        }, (block) => this.isActiveBlock(block) || this.dirtyBlocks.has(block)
            || Boolean(window.getSelection()?.anchorNode && block.contains(window.getSelection().anchorNode)));
        const response = await fetchSyncPost("/api/block/getBlockDOM", {id: rootId});
        if (response.code !== 0 || typeof response.data?.dom !== "string" || !response.data.dom.trim()) {
            throw new Error(response.msg || "Unable to read document DOM");
        }
        const template = document.createElement("template");
        template.innerHTML = response.data.dom;
        const blocks = new Map(Array.from(template.content.querySelectorAll<HTMLElement>("[data-node-id]"))
            .filter((block) => this.isConvertibleBlock(block))
            .map((block) => [block.dataset.nodeId, block] as const));
        // Use the latest editor text, including edits not yet persisted. Tables
        // use the complete kernel DOM because the editor may virtualize rows.
        for (const block of Array.from(wysiwyg.querySelectorAll<HTMLElement>("[data-node-id]"))) {
            if (!this.isConvertibleBlock(block)) continue;
            if (block.dataset.type === "NodeTable") {
                continue;
            }
            const original = blocks.get(block.dataset.nodeId);
            if (original) {
                const clone = block.cloneNode(true) as HTMLElement;
                original.replaceWith(clone);
                blocks.set(block.dataset.nodeId, clone);
            } else blocks.set(block.dataset.nodeId, block);
        }
        return Array.from(blocks.values()).sort((a, b) => a.dataset.nodeId.localeCompare(b.dataset.nodeId));
    }

    private isConvertibleBlock(block: HTMLElement) {
        return !block.closest('[data-type="NodeBlockQueryEmbed"]')
            && ["NodeParagraph", "NodeHeading", "NodeTable"].indexOf(block.dataset.type) >= 0;
    }

    private prepareNativeBlockRefUpdates(wysiwyg: HTMLElement, sourceBlocks?: HTMLElement[]) {
        const blocks = sourceBlocks || Array.from(wysiwyg.querySelectorAll<HTMLElement>("[data-node-id]"));
        const definitions = sourceBlocks ? this.indexBlockDefinitions(blocks) : this.collectDefinitions(wysiwyg);
        const updates: NativeBlockRefUpdate[] = [];

        for (const block of blocks) {
            const blockId = block.dataset.nodeId;
            if (!blockId || this.parseBlockDefinition(block)) {
                continue;
            }

            const clone = block.cloneNode(true) as HTMLElement;
            this.cleanupBlock(clone);
            const oldHTML = clone.outerHTML;
            const referenceCount = this.convertFootnoteMarkersToNativeRefs(clone, definitions);
            if (referenceCount === 0) {
                continue;
            }

            updates.push({
                operation: {
                    action: "update",
                    id: blockId,
                    data: clone.outerHTML,
                },
                undoOperation: {action: "update", id: blockId, data: oldHTML},
                referenceCount,
            });
        }

        return updates;
    }

    private convertFootnoteMarkersToNativeRefs(block: HTMLElement, definitions: Map<string, FootnoteDefinition>) {
        // Undo the transient wrappers first; a split rich marker is still one ref.
        this.cleanupBlock(block);
        let referenceCount = 0;
        visitInline(block, (nodes) => {
            const matches = readMarkers(nodes);
            for (const match of matches.reverse()) {
                const definition = definitions.get(match[1]);
                if (!definition?.blockId || definition.candidates) continue;
                replaceTextRun(nodes, match.index, match.index + match[0].length,
                    this.createNativeBlockRef(match[1], definition.blockId));
                referenceCount++;
            }
        });
        return referenceCount;
    }

    private createNativeBlockRef(id: string, definitionBlockId: string) {
        const reference = document.createElement("span");
        reference.dataset.type = NATIVE_BLOCK_REF_TYPE;
        reference.dataset.subtype = "s";
        reference.dataset.id = definitionBlockId;
        reference.textContent = `[^${id}]`;
        return reference;
    }

    private startObserving() {
        if (!this.enabled || !this.observer) {
            return;
        }

        this.observer.observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true,
        });
    }

    private handleMutations(records: MutationRecord[]) {
        if (!this.enabled || this.isRendering) {
            return;
        }

        let changed = false;
        let activeBlockChanged = false;
        let inactiveBlockChanged = false;
        const recordDirtyBlock = (block: HTMLElement) => {
            if (block.closest("[data-footnote-sidebar]")) return;
            this.markBlockDirty(block);
            changed = true;
            if (this.isActiveBlock(block)) {
                activeBlockChanged = true;
            } else {
                inactiveBlockChanged = true;
            }
        };

        for (const record of records) {
            const targetBlock = this.getBlockFromNode(record.target);
            if (targetBlock) {
                recordDirtyBlock(targetBlock);
            }

            if (record.type !== "childList") {
                continue;
            }

            for (const node of Array.from(record.addedNodes)) {
                const addedBlock = this.getBlockFromNode(node);
                if (addedBlock) {
                    recordDirtyBlock(addedBlock);
                }

                if (node instanceof HTMLElement) {
                    const nestedBlocks = Array.from(node.querySelectorAll<HTMLElement>("[data-node-id]"));
                    for (const block of nestedBlocks) {
                        if (block.closest(".protyle-wysiwyg")) {
                            recordDirtyBlock(block);
                        }
                    }
                }
            }

            if (record.removedNodes.length > 0 && !targetBlock) {
                const removedActiveBlock = Array.from(record.removedNodes).some((node) => {
                    if (!(node instanceof HTMLElement)) {
                        return false;
                    }
                    if (node.matches("[data-node-id]") && this.isActiveBlock(node)) {
                        return true;
                    }
                    return Array.from(node.querySelectorAll<HTMLElement>("[data-node-id]"))
                        .some((block) => this.isActiveBlock(block));
                });
                if (removedActiveBlock) {
                    activeBlockChanged = true;
                    changed = true;
                    continue;
                }

                const target = record.target instanceof HTMLElement
                    ? record.target
                    : record.target.parentElement;
                const editor = target?.closest<HTMLElement>(".protyle-wysiwyg");
                if (editor) {
                    this.markEditorDirty(editor);
                    changed = true;
                    inactiveBlockChanged = true;
                }
            }
        }

        if (changed) {
            if (activeBlockChanged && this.liveRefreshEditingBlock) {
                this.activeRefreshAt = Date.now() + ACTIVE_REFRESH_DELAY;
            }
            if (inactiveBlockChanged) {
                this.scheduleRefresh(INACTIVE_REFRESH_DELAY);
            } else if (activeBlockChanged && this.liveRefreshEditingBlock) {
                this.scheduleRefresh(ACTIVE_REFRESH_DELAY);
            }
        }
    }

    private mutateSilently(callback: () => void) {
        this.observer?.disconnect();
        const previousRenderingState = this.isRendering;
        this.isRendering = true;
        try {
            callback();
        } finally {
            this.observer?.takeRecords();
            this.isRendering = previousRenderingState;
            this.startObserving();
        }
    }

    private markBlockDirty(block: HTMLElement) {
        if (block.closest('[data-type="NodeBlockQueryEmbed"], [data-footnote-sidebar]')) return;
        const editor = block.closest<HTMLElement>(".protyle-wysiwyg");
        if (editor) {
            this.dirtyBlocks.add(block);
            const rootId = this.editorProtyles.get(editor)?.block?.rootID;
            if (rootId && block.dataset.nodeId) this.blockRootIds.set(block.dataset.nodeId, rootId);
        }
    }

    private markEditorDirty(editor: HTMLElement) {
        for (const block of Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]"))) {
            this.markBlockDirty(block);
        }
    }

    private markAllBlocksDirty() {
        for (const editor of Array.from(document.querySelectorAll<HTMLElement>(".protyle-wysiwyg"))) {
            this.markEditorDirty(editor);
        }
    }

    private getBlockFromNode(node: Node | null) {
        if (!node) {
            return undefined;
        }

        const element = node instanceof HTMLElement ? node : node.parentElement;
        if (element?.closest("[data-footnote-sidebar]")) return undefined;
        const block = element?.closest<HTMLElement>("[data-node-id]");
        return block?.closest(".protyle-wysiwyg") ? block : undefined;
    }

    private getSelectionBlock() {
        const selection = window.getSelection();
        return this.getBlockFromNode(selection?.anchorNode || null);
    }

    private isActiveBlock(block: HTMLElement) {
        if (block === this.activeBlock) {
            return true;
        }

        const blockId = block.dataset.nodeId;
        return Boolean(blockId && this.activeBlockId && blockId === this.activeBlockId);
    }

    private syncActiveBlock() {
        const block = this.getSelectionBlock();
        if (block && this.isActiveBlock(block)) {
            this.activeBlock = block;
            return;
        }

        if (block) {
            this.activateBlock(block);
            return;
        }

        if (this.activeBlock) {
            this.markBlockDirty(this.activeBlock);
            this.activeBlock = undefined;
            this.activeBlockId = undefined;
            this.activeRefreshAt = 0;
            this.scheduleRefresh(50);
        }
    }

    private activateBlock(block: HTMLElement) {
        if (this.isActiveBlock(block)) {
            this.activeBlock = block;
            this.activeBlockId = block.dataset.nodeId;
            return;
        }

        const previousBlock = this.activeBlock;
        if (previousBlock) {
            this.markBlockDirty(previousBlock);
        }

        this.activeBlock = block;
        this.activeBlockId = block.dataset.nodeId;
        this.activeRefreshAt = 0;

        if (previousBlock) {
            this.scheduleRefresh(50);
        }
    }

    private captureSelection(block: HTMLElement): SelectionBookmark | undefined {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return undefined;
        }

        const range = selection.getRangeAt(0);
        if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) {
            return undefined;
        }

        try {
            const startRange = document.createRange();
            startRange.selectNodeContents(block);
            startRange.setEnd(range.startContainer, range.startOffset);

            const endRange = document.createRange();
            endRange.selectNodeContents(block);
            endRange.setEnd(range.endContainer, range.endOffset);

            return {
                start: startRange.toString().length,
                end: endRange.toString().length,
            };
        } catch {
            return undefined;
        }
    }

    private restoreSelection(block: HTMLElement, bookmark: SelectionBookmark) {
        const locate = (offset: number): {node: Node; offset: number} => {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let remaining = offset;
            let lastTextNode: Text | undefined;

            while (walker.nextNode()) {
                const textNode = walker.currentNode as Text;
                lastTextNode = textNode;
                if (remaining <= textNode.length) {
                    return {node: textNode, offset: remaining};
                }
                remaining -= textNode.length;
            }

            if (lastTextNode) {
                return {node: lastTextNode, offset: lastTextNode.length};
            }
            return {node: block, offset: 0};
        };

        const avoidNonEditableReference = (point: {node: Node; offset: number}) => {
            const element = point.node instanceof HTMLElement ? point.node : point.node.parentElement;
            const reference = element?.closest<HTMLElement>(`.${REF_CLASS}[contenteditable="false"]`);
            const parent = reference?.parentNode;
            if (!reference || !parent) {
                return point;
            }

            const index = Array.prototype.indexOf.call(parent.childNodes, reference) as number;
            return {
                node: parent,
                offset: index + (point.offset > 0 ? 1 : 0),
            };
        };

        try {
            const start = avoidNonEditableReference(locate(bookmark.start));
            const end = avoidNonEditableReference(locate(bookmark.end));
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);

            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        } catch {
            // SiYuan may have replaced the block while the selection was being restored.
        }
    }

    private scheduleRefresh(delay = 120) {
        const safeDelay = Math.max(0, delay);
        const nextRunAt = Date.now() + safeDelay;
        if (this.refreshTimer) {
            if (nextRunAt >= this.refreshTimerAt) {
                return;
            }
            window.clearTimeout(this.refreshTimer);
        }

        this.refreshTimerAt = nextRunAt;
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = 0;
            this.refreshTimerAt = 0;
            this.refresh();
        }, safeDelay);
    }

    private async manualRefresh(managed?: IProtyle) {
        if (!this.enabled || this.unloaded) return;
        if (this.isComposing) {this.manualRefreshPending = true; this.manualRefreshEditor = managed; return;}
        this.manualRefreshPending = false; this.manualRefreshEditor = undefined;
        const editor = managed || getActiveEditor()?.protyle;
        // Clicking the sidebar must not change the managed document.
        const rootId = editor?.block?.rootID;
        if (!rootId || editor.wysiwyg.element.closest("[data-footnote-sidebar]")) return;
        this.invalidateDocumentDefinitions(rootId);
        this.registerEditor(editor); this.markEditorDirty(editor.wysiwyg.element);
        await this.ensureDocumentDefinitions(rootId);
        if (!this.unloaded && this.enabled && getActiveEditor()?.protyle?.block?.rootID === rootId) {
            if (this.isComposing) {this.manualRefreshPending = true; this.manualRefreshEditor = editor; return;}
            const selectionBlock = this.getSelectionBlock();
            if (selectionBlock?.closest(".protyle-wysiwyg") === editor.wysiwyg.element) this.activateBlock(selectionBlock);
            this.refresh(true);
        }
    }

    private refresh(forceActive = false) {
        if (!this.enabled || this.isComposing) {
            return;
        }

        if (this.activeTooltipRef && !this.activeTooltipRef.isConnected) {
            this.hideTooltip();
        }

        if (this.activeBlock && !this.activeBlock.isConnected) {
            const selectionBlock = this.getSelectionBlock();
            const replacement = selectionBlock && this.isActiveBlock(selectionBlock)
                ? selectionBlock
                : Array.from(this.dirtyBlocks).find((block) => block.isConnected && this.isActiveBlock(block));

            if (replacement) {
                this.activeBlock = replacement;
            } else {
                this.activeBlock = undefined;
                this.activeBlockId = undefined;
                this.activeRefreshAt = 0;
            }
        }

        for (const block of Array.from(this.dirtyBlocks)) {
            if (!block.isConnected) {
                this.dirtyBlocks.delete(block);
            }
        }

        const editors = Array.from(document.querySelectorAll<HTMLElement>(".protyle-wysiwyg"))
            .filter((editor) => !editor.closest("[data-footnote-sidebar]"));
        const definitionsByEditor = new Map<HTMLElement, Map<string, FootnoteDefinition>>();
        for (const editor of getAllEditor()) {
            this.registerEditor(editor?.protyle);
        }

        const dirtyEditors = new Set(Array.from(this.dirtyBlocks)
            .map((block) => block.closest<HTMLElement>(".protyle-wysiwyg")));
        for (const editor of editors) {
            const rootId = this.editorProtyles.get(editor)?.block?.rootID;
            if (!dirtyEditors.has(editor) && !this.definitionDirtyRoots.has(rootId)) continue;
            if (rootId) {
                void this.ensureDocumentDefinitions(rootId);
            }
            const definitions = this.collectDefinitions(editor);
            definitionsByEditor.set(editor, definitions);

            const signature = Array.from(definitions.values())
                .map((definition) => JSON.stringify(definition.candidates || [
                    {id: definition.id, blockId: definition.blockId, content: definition.content}]))
                .sort()
                .join("\u0001");
            const definitionChanged = this.definitionSignatures.get(editor) !== signature;
            if (definitionChanged) {
                this.markEditorDirty(editor);
                this.definitionSignatures.set(editor, signature);
            }
        }
        for (const rootId of this.definitionDirtyRoots) {
            const remaining = (this.definitionRefreshAfter.get(rootId) || 0) - Date.now();
            if (remaining > 0) {
                this.scheduleRefresh(remaining);
            } else {
                this.definitionDirtyRoots.delete(rootId);
            }
        }

        const now = Date.now();
        const blocks = Array.from(this.dirtyBlocks).filter((block) => {
            return block.isConnected
                && (forceActive || !this.isActiveBlock(block)
                    || (this.liveRefreshEditingBlock && now >= this.activeRefreshAt));
        });
        if (blocks.length === 0) {
            this.schedulePendingActiveRefresh();
            return;
        }

        this.mutateSilently(() => {
            for (const block of blocks) {
                const editor = block.closest<HTMLElement>(".protyle-wysiwyg");
                const definitions = editor ? definitionsByEditor.get(editor) : undefined;
                const needsEnhancement = block.classList.contains(DEF_CLASS)
                    || Boolean(block.querySelector(`.${REF_CLASS}[${ENHANCED_ATTR}]`))
                    || Boolean(block.querySelector('[data-type~="block-ref"]'))
                    || this.getVisibleText(block).includes("[^");

                if (!needsEnhancement) {
                    this.dirtyBlocks.delete(block);
                    continue;
                }

                const bookmark = this.isActiveBlock(block) ? this.captureSelection(block) : undefined;
                const tooltipId = this.activeTooltipRef && block.contains(this.activeTooltipRef)
                    ? this.activeTooltipRef.dataset.footnoteId : undefined;
                const tooltipIndex = tooltipId ? Array.from(block.querySelectorAll<HTMLElement>(`.${REF_CLASS}`))
                    .filter((ref) => ref.dataset.footnoteId === tooltipId).indexOf(this.activeTooltipRef) : -1;
                this.cleanupBlock(block);

                if (definitions) {
                    const parsed = this.parseBlockDefinition(block);
                    if (parsed) {
                        block.classList.add(DEF_CLASS);
                        block.dataset.footnoteId = parsed.id;
                    }
                    this.wrapReferences(block, definitions);
                    this.styleNativeFootnotes(block, definitions);
                }

                if (tooltipId) {
                    // Rendering replaces marker nodes. Keep the current preview
                    // and scroll position attached to the replacement marker.
                    const replacement = Array.from(block.querySelectorAll<HTMLElement>(`.${REF_CLASS}`))
                        .filter((ref) => ref.dataset.footnoteId === tooltipId)[tooltipIndex];
                    if (replacement) {
                        this.activeTooltipRef = replacement;
                        this.updateTooltipContent(replacement.dataset.preview || "未找到对应脚注定义");
                        this.positionTooltip(replacement);
                    } else {
                        this.hideTooltip();
                    }
                }

                if (bookmark) {
                    this.restoreSelection(block, bookmark);
                }

                this.dirtyBlocks.delete(block);
            }
        });

        this.schedulePendingActiveRefresh();
    }

    private schedulePendingActiveRefresh() {
        if (!this.liveRefreshEditingBlock
            || !this.activeBlock
            || !Array.from(this.dirtyBlocks).some((block) => block.isConnected && this.isActiveBlock(block))) {
            return;
        }

        const remaining = Math.max(0, this.activeRefreshAt - Date.now());
        this.scheduleRefresh(remaining);
    }

    private collectDefinitions(root: HTMLElement) {
        const rootId = this.editorProtyles.get(root)?.block?.rootID;
        const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))
            .filter((block) => !block.closest('[data-type="NodeBlockQueryEmbed"]'));
        const loadedIds = new Set(blocks.map((block) => block.dataset.nodeId));
        // Visible content is newer than the SQL index, including deleted/renamed definitions.
        const candidates: DefinitionCandidate[] = [];
        for (const definition of this.documentDefinitions.get(rootId)?.definitions.values() || []) {
            candidates.push(...(definition.candidates || [definition])
                .filter((candidate) => !loadedIds.has(candidate.blockId)));
        }
        return this.indexBlockDefinitions(blocks, candidates);
    }

    private parseBlockDefinition(block: HTMLElement) {
        if (block.closest('[data-type="NodeBlockQueryEmbed"]')) return undefined;
        if (block.dataset.type && ["NodeParagraph", "NodeHeading"].indexOf(block.dataset.type) < 0) return undefined;
        return parseDefinition(this.getVisibleText(block)) || this.orderedDefinitionBlocks.get(block);
    }

    private indexBlockDefinitions(blocks: HTMLElement[], candidates: DefinitionCandidate[] = []) {
        for (const block of blocks) this.orderedDefinitionBlocks.delete(block);
        const literals = blocks.map((block) => ({block, parsed: this.parseBlockDefinition(block)})).filter((item) => item.parsed);
        if (!literals.length && !candidates.some((candidate) => !candidate.listId)) {
            const first = blocks[0];
            const editor = first?.closest<HTMLElement>(".protyle-wysiwyg");
            const rootId = editor ? this.editorProtyles.get(editor)?.block?.rootID : undefined;
            const cache = this.documentDefinitions.get(rootId)?.definitions;
            const byId = new Map(blocks.map((block) => [block.dataset.nodeId, block]));
            // Complete cached structure decides which list is terminal in a
            // paged editor. Full-document conversion has a complete fragment.
            const ordered = editor && cache ? Array.from(cache.values()).reduce<DefinitionCandidate[]>((all, note) =>
                all.concat((note.candidates || [note]).filter((candidate) => candidate.listId)), [])
                : first ? readOrderedDefinitions(editor || first.getRootNode() as DocumentFragment, rootId) : [];
            for (const note of ordered) {
                const block = byId.get(note.blockId);
                if (!block) continue;
                this.orderedDefinitionBlocks.set(block, {...note,
                    id: block.getAttribute("custom-footnote-label") || note.id,
                    content: this.getVisibleText(block).trim() || "空脚注"});
            }
        } else candidates = candidates.filter((candidate) => !candidate.listId);
        for (const block of blocks) {
            const parsed = this.parseBlockDefinition(block);
            if (!parsed) {
                continue;
            }

            candidates.push({...parsed, blockId: block.dataset.nodeId});
        }
        const definitions = new Map<string, FootnoteDefinition>(indexDefinitions(candidates));
        const elements = new Map(blocks.map((block) => [block.dataset.nodeId, block]));
        for (const definition of definitions.values()) definition.element = elements.get(definition.blockId);
        return definitions;
    }

    private definitionPreview(definition?: FootnoteDefinition) {
        return definition?.candidates
            ? `脚注编号 [^${definition.id}] 重复（${definition.candidates.length} 处）。点击标记可选择定义，或通过侧栏检查重复编号。`
            : definition?.content || "未找到对应脚注定义";
    }

    private async checkDuplicateDefinitions(anchor?: HTMLElement, managed?: IProtyle) {
        const editor = managed || getActiveEditor()?.protyle;
        const rootId = editor?.block?.rootID;
        if (!rootId || !editor.wysiwyg?.element) {
            showMessage("请先打开需要检查的文档", 3000, "error");
            return;
        }
        this.registerEditor(editor);
        try {
            const blocks = await this.readDocumentBlocks(rootId, editor.wysiwyg.element);
            if (this.unloaded || !editor.wysiwyg.element.isConnected
                || getActiveEditor()?.protyle?.block?.rootID !== rootId) return;
            const duplicates = Array.from(this.indexBlockDefinitions(blocks).values())
                .filter((definition) => definition.candidates);
            if (!duplicates.length) {
                showMessage("全文未发现重复脚注编号");
                return;
            }
            this.openDuplicateMenu(duplicates, anchor);
        } catch (error) {
            console.warn(`[${this.name}] check duplicates failed`, error);
            showMessage(error instanceof Error && error.message === TABLE_EDIT_MESSAGE
                ? TABLE_EDIT_MESSAGE : "读取全文失败，请重试", 4000, "error");
        }
    }

    private openDuplicateMenu(definitions: FootnoteDefinition[], anchor?: HTMLElement) {
        const menu = new Menu("siyuan-footnote-duplicates");
        const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        for (const definition of definitions) {
            for (const candidate of definition.candidates || []) {
                menu.addItem({
                    label: escape(`[^${definition.id}] · ${candidate.content.slice(0, 60)}`),
                    icon: "iconLink",
                    click: () => {
                        if (this.unloaded) return;
                        this.hideTooltip();
                        void this.openBlock(candidate.blockId).catch(() =>
                            showMessage("定位脚注失败，请重试", 3000, "error"));
                    },
                });
            }
        }
        const rect = anchor?.getBoundingClientRect();
        menu.open({x: rect?.left || 0, y: rect?.bottom || 0});
    }

    private wrapReferences(root: HTMLElement, definitions: Map<string, FootnoteDefinition>) {
        if (root.classList.contains(DEF_CLASS) || !root.closest(".protyle-wysiwyg")) return;
        visitInline(root, (nodes) => {
            const matches = readMarkers(nodes);
            for (const match of matches.reverse()) {
                const definition = definitions.get(match[1]);
                const reference = document.createElement("span");
                reference.className = definition?.candidates ? REF_CLASS + " " + CONFLICT_CLASS
                    : definition ? REF_CLASS : REF_CLASS + " " + MISSING_CLASS;
                if (markerIsSuperscript(nodes, match.index, match.index + match[0].length)) {
                    reference.classList.add("siyuan-footnote-ref--native-sup");
                }
                reference.dataset.footnoteId = match[1];
                reference.dataset.preview = this.definitionPreview(definition);
                reference.setAttribute(ENHANCED_ATTR, "true");
                reference.setAttribute("contenteditable", "false");
                wrapTextRun(nodes, match.index, match.index + match[0].length, reference);
            }
        });
    }

    private cleanupEnhancements() {
        this.hideTooltip();
        const previousRenderingState = this.isRendering;
        this.isRendering = true;
        try {
            const refs = Array.from(document.querySelectorAll<HTMLElement>(`.${REF_CLASS}[${ENHANCED_ATTR}]`));
            for (const ref of refs) {
                const parent = ref.parentNode;
                if (!parent) {
                    continue;
                }
                ref.replaceWith(...Array.from(ref.childNodes));
                parent.normalize();
            }

            const definitions = Array.from(document.querySelectorAll<HTMLElement>(`.${DEF_CLASS}`));
            for (const definition of definitions) {
                definition.classList.remove(DEF_CLASS, HIGHLIGHT_CLASS);
                delete definition.dataset.footnoteId;
            }
            for (const native of Array.from(document.querySelectorAll<HTMLElement>(`.${NATIVE_REF_CLASS}`))) {
                native.classList.remove(NATIVE_REF_CLASS);
                if (!native.className) native.removeAttribute("class");
            }
        } finally {
            this.isRendering = previousRenderingState;
        }
    }

    private cleanupBlock(block: HTMLElement) {
        for (const native of Array.from(block.querySelectorAll<HTMLElement>(`.${NATIVE_REF_CLASS}`))) {
            native.classList.remove(NATIVE_REF_CLASS);
            if (!native.className) native.removeAttribute("class");
        }
        const refs = Array.from(block.querySelectorAll<HTMLElement>(`.${REF_CLASS}[${ENHANCED_ATTR}]`))
            .filter((ref) => ref.closest("[data-node-id]") === block);

        for (const ref of refs) {
            const parent = ref.parentNode;
            if (!parent) {
                continue;
            }
            ref.replaceWith(...Array.from(ref.childNodes));
            parent.normalize();
        }

        block.classList.remove(DEF_CLASS, HIGHLIGHT_CLASS);
        delete block.dataset.footnoteId;
    }

    private findDefinition(id: string, refElement: HTMLElement) {
        const editor = refElement.closest<HTMLElement>(".protyle-wysiwyg");
        return editor ? this.collectDefinitions(editor).get(id) : undefined;
    }

    private registerEditor(protyle: IProtyle) {
        if (protyle?.wysiwyg?.element?.closest("[data-footnote-sidebar]")) return;
        if (protyle?.wysiwyg?.element) {
            const element = protyle.wysiwyg.element;
            if (!this.editorProtyles.has(element)) {
                const rootId = protyle.block?.rootID;
                if (rootId) {
                    this.blockRootIds.set(rootId, rootId);
                    for (const block of Array.from(element.querySelectorAll<HTMLElement>("[data-node-id]"))) {
                        this.blockRootIds.set(block.dataset.nodeId, rootId);
                    }
                }
            }
            this.editorProtyles.set(protyle.wysiwyg.element, protyle);
        }
    }

    private styleNativeFootnotes(block: HTMLElement, definitions: Map<string, FootnoteDefinition>) {
        const targetIds = new Set<string>();
        for (const definition of definitions.values()) {
            for (const candidate of definition.candidates || [definition]) {
                targetIds.add(candidate.blockId);
                if (candidate.itemId) targetIds.add(candidate.itemId);
            }
        }
        for (const native of Array.from(block.querySelectorAll<HTMLElement>('[data-type~="block-ref"]'))) {
            if (native.closest("[data-node-id]") !== block
                || native.closest('[data-type="NodeBlockQueryEmbed"], [data-type~="code"], code, pre')) continue;
            if (targetIds.has(native.dataset.id) && !isSuperscript(native)) native.classList.add(NATIVE_REF_CLASS);
        }
    }

    private ensureDocumentDefinitions(rootId: string) {
        let state = this.documentDefinitions.get(rootId);
        if (state?.loading) {
            return state.loading;
        }
        if (state && Date.now() < state.expiresAt) {
            return Promise.resolve();
        }
        state = {definitions: state?.definitions || new Map(), expiresAt: 0};
        this.documentDefinitions.set(rootId, state);
        const current = state;
        current.loading = readDocumentDefinitions(rootId, async (stmt) => {
            const response = await fetchSyncPost("/api/query/sql", {stmt});
            if (response.code !== 0 || !Array.isArray(response.data)) {
                throw new Error(response.msg || "Unable to read footnote definitions");
            }
            return response.data;
        }, async () => {
            const response = await fetchSyncPost("/api/block/getBlockDOM", {id: rootId});
            if (response.code !== 0 || typeof response.data?.dom !== "string") return [];
            const template = document.createElement("template");
            template.innerHTML = response.data.dom;
            const blocks = new Map(Array.from(template.content.querySelectorAll<HTMLElement>("[data-node-id]"))
                .map((block) => [block.dataset.nodeId, block]));
            return readOrderedDefinitions(template.content, rootId).map((note) => {
                const block = blocks.get(note.blockId);
                return {...note, id: block.getAttribute("custom-footnote-label") || note.id};
            });
        }).then((definitions) => {
            if (this.unloaded || this.documentDefinitions.get(rootId) !== current) {
                return;
            }
            current.definitions = definitions;
            for (const definition of definitions.values()) {
                for (const candidate of definition.candidates || [definition]) {
                    this.blockRootIds.set(candidate.blockId, rootId);
                    if (candidate.itemId) this.blockRootIds.set(candidate.itemId, rootId);
                }
            }
            // An interaction may query before the asynchronous SQL index catches
            // up. Let the scheduled post-edit refresh replace that early result.
            const now = Date.now();
            const refreshAfter = this.definitionRefreshAfter.get(rootId) || 0;
            current.expiresAt = now < refreshAfter
                ? refreshAfter
                : now + 30000;
            if (this.enabled) {
                this.definitionDirtyRoots.add(rootId);
                this.scheduleRefresh(0);
            }
        }).catch((error) => {
            current.expiresAt = Date.now() + 5000;
            console.warn(`[${this.name}] read footnote definitions failed`, error);
        }).then(() => {
            current.loading = undefined;
        });
        return current.loading;
    }

    private async resolveDefinition(id: string, refElement: HTMLElement) {
        const editor = refElement.closest<HTMLElement>(".protyle-wysiwyg");
        const rootId = editor && this.editorProtyles.get(editor)?.block?.rootID;
        if (rootId) {
            await this.ensureDocumentDefinitions(rootId);
        }
        if (this.unloaded || !this.enabled || !refElement.isConnected
            || (rootId && this.editorProtyles.get(editor)?.block?.rootID !== rootId)) {
            return undefined;
        }
        return this.findDefinition(id, refElement);
    }

    private async jumpToDefinition(id: string, refElement: HTMLElement) {
        const editor = refElement.closest<HTMLElement>(".protyle-wysiwyg");
        const rootId = editor && this.editorProtyles.get(editor)?.block?.rootID;
        const block = refElement.closest<HTMLElement>("[data-node-id]");
        const origin: FootnoteOrigin | undefined = rootId && block?.dataset.nodeId ? {
            rootId,
            blockId: block.dataset.nodeId,
            footnoteId: id,
            referenceIndex: this.getBlockReferences(block, id).indexOf(refElement),
        } : undefined;
        const definition = await this.resolveDefinition(id, refElement);
        if (rootId && this.editorProtyles.get(editor)?.block?.rootID !== rootId) {
            return;
        }
        if (!definition) {
            if (!this.unloaded && this.enabled && refElement.isConnected) {
                showMessage(`未找到脚注 [^${id}] 的定义`);
            }
            return;
        }
        if (definition.candidates) {
            this.openDuplicateMenu([definition], refElement);
            return;
        }
        this.hideTooltip();
        if (definition.element?.isConnected) {
            this.scrollToElement(definition.element);
            this.rememberReturnOrigin(origin);
            return;
        }
        try {
            await this.openBlock(definition.blockId);
            this.rememberReturnOrigin(origin);
        } catch (error) {
            console.warn(`[${this.name}] jump to footnote failed`, error);
            showMessage("脚注跳转失败，请重试", 3000, "error");
        }
    }

    private getBlockReferences(block: HTMLElement, id: string) {
        return Array.from(block.querySelectorAll<HTMLElement>(`.${REF_CLASS}`))
            .filter((ref) => ref.dataset.footnoteId === id && ref.closest("[data-node-id]") === block);
    }

    private scrollToElement(element: HTMLElement) {
        element.scrollIntoView({behavior: "smooth", block: "center"});
        element.classList.remove(HIGHLIGHT_CLASS);
        window.setTimeout(() => element.classList.add(HIGHLIGHT_CLASS), 30);
        window.setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 1800);
    }

    private async openBlock(blockId: string) {
        const frontend = getFrontend();
        if (frontend === "mobile" || frontend === "browser-mobile") {
            openMobileFileById(this.app, blockId, ["cb-get-hl", "cb-get-context"]);
        } else {
            await openTab({app: this.app, doc: {id: blockId, action: ["cb-get-hl", "cb-get-context"]}});
        }
    }

    private rememberReturnOrigin(origin?: FootnoteOrigin) {
        if (!origin || !this.enabled || this.unloaded) {
            return;
        }
        this.returnOrigin = origin;
        if (!this.returnButton) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = RETURN_BUTTON_CLASS;
            document.body.append(button);
            this.returnButton = button;
        }
        this.returnButton.textContent = `↩ 返回正文 [^${origin.footnoteId}]`;
    }

    private isReturnButtonTarget(target: EventTarget | null) {
        return target instanceof Node && Boolean(this.returnButton?.contains(target));
    }

    private async returnToReference() {
        const origin = this.returnOrigin;
        if (!origin || !this.enabled || this.unloaded || this.returnButton?.disabled) {
            return;
        }
        if (this.returnButton) {
            this.returnButton.disabled = true;
        }
        this.hideTooltip();
        try {
            const protyle = getActiveEditor()?.protyle;
            const editor = protyle?.block?.rootID === origin.rootId ? protyle.wysiwyg?.element : undefined;
            const block = editor && Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]"))
                .find((item) => item.dataset.nodeId === origin.blockId);
            if (block?.isConnected) {
                const ref = this.getBlockReferences(block, origin.footnoteId)[origin.referenceIndex];
                this.scrollToElement(ref || block);
            } else {
                await this.openBlock(origin.blockId);
            }
            if (this.returnOrigin === origin) {
                this.clearReturnOrigin();
            }
        } catch (error) {
            console.warn(`[${this.name}] return to footnote reference failed`, error);
            showMessage("返回正文失败，请重试", 3000, "error");
        } finally {
            if (this.returnButton) {
                this.returnButton.disabled = false;
            }
        }
    }

    private clearReturnOrigin() {
        this.returnOrigin = undefined;
        this.returnButton?.remove();
        this.returnButton = undefined;
    }

    private getVisibleText(element: HTMLElement) {
        return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ");
    }

    private getReferenceElement(target: EventTarget | null) {
        if (!(target instanceof HTMLElement)) {
            return undefined;
        }

        return target.closest(`.${REF_CLASS}`) as HTMLElement | null || undefined;
    }

    private isTooltipTarget(target: EventTarget | null) {
        return target instanceof Node && Boolean(this.tooltipElement?.contains(target));
    }

    private showTooltip(refElement: HTMLElement) {
        const text = refElement.dataset.preview;
        if (!text) {
            this.hideTooltip();
            return;
        }

        refElement.removeAttribute("title");
        refElement.removeAttribute("aria-label");
        const tooltip = this.ensureTooltip();
        this.updateTooltipContent(text);
        tooltip.scrollTop = 0;
        tooltip.scrollLeft = 0;
        tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
        this.positionTooltip(refElement);
        const id = refElement.dataset.footnoteId;
        if (id) {
            void this.resolveDefinition(id, refElement).then((definition) => {
                if (this.activeTooltipRef !== refElement || !definition) {
                    return;
                }
                refElement.dataset.preview = this.definitionPreview(definition);
                refElement.classList.remove(MISSING_CLASS);
                refElement.classList[definition.candidates ? "add" : "remove"](CONFLICT_CLASS);
                this.updateTooltipContent(refElement.dataset.preview);
                this.positionTooltip(refElement);
            });
        }
    }

    private ensureTooltip() {
        if (this.tooltipElement) {
            return this.tooltipElement;
        }

        const tooltip = document.createElement("div");
        tooltip.className = TOOLTIP_CLASS;
        tooltip.setAttribute("role", "tooltip");
        document.body.append(tooltip);
        this.tooltipElement = tooltip;
        return tooltip;
    }

    private updateTooltipContent(text: string) {
        // Do not rebuild unchanged text while a user scrolls or selects it.
        if (this.tooltipElement && this.tooltipElement.textContent !== text) {
            this.tooltipElement.textContent = text;
        }
    }

    private positionTooltip(refElement: HTMLElement) {
        const tooltip = this.tooltipElement;
        if (!tooltip) {
            return;
        }

        const margin = 12;
        const gap = 10;
        const refRect = refElement.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
        const preferredLeft = refRect.left + refRect.width / 2 - tooltipRect.width / 2;
        const left = Math.min(Math.max(preferredLeft, margin), maxLeft);

        let top = refRect.top - tooltipRect.height - gap;
        if (top < margin) {
            top = refRect.bottom + gap;
        }

        const maxTop = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
        top = Math.min(Math.max(top, margin), maxTop);

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
    }

    private cancelTooltipHide() {
        window.clearTimeout(this.tooltipHideTimer);
        this.tooltipHideTimer = 0;
    }

    private scheduleTooltipHide() {
        if (!this.activeTooltipRef || this.tooltipInteracting) {
            return;
        }
        this.cancelTooltipHide();
        this.tooltipHideTimer = window.setTimeout(() => this.hideTooltip(), TOOLTIP_HIDE_DELAY);
    }

    private hideTooltip() {
        this.cancelTooltipHide();
        this.tooltipInteracting = false;
        this.activeTooltipRef = undefined;
        this.tooltipElement?.classList.remove(TOOLTIP_VISIBLE_CLASS);
    }

    private destroyTooltip() {
        this.hideTooltip();
        this.tooltipElement?.remove();
        this.tooltipElement = undefined;
        this.activeTooltipRef = undefined;
    }
}
