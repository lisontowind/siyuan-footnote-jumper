import {Menu, Plugin, showMessage} from "siyuan";
import "./index.scss";

const STORAGE_NAME = "footnote-jumper-settings";
const ENHANCED_ATTR = "data-siyuan-footnote-enhanced";
const REF_CLASS = "siyuan-footnote-ref";
const DEF_CLASS = "siyuan-footnote-definition";
const HIGHLIGHT_CLASS = "siyuan-footnote-definition--highlight";
const MISSING_CLASS = "siyuan-footnote-ref--missing";
const TOOLTIP_CLASS = "siyuan-footnote-tooltip";
const TOOLTIP_VISIBLE_CLASS = "siyuan-footnote-tooltip--visible";
const ACTIVE_REFRESH_DELAY = 1000;
const INACTIVE_REFRESH_DELAY = 200;

interface FootnoteSettings {
    enabled: boolean;
    liveRefreshEditingBlock: boolean;
}

interface FootnoteDefinition {
    id: string;
    content: string;
    element: HTMLElement;
}

interface SelectionBookmark {
    start: number;
    end: number;
}

export default class FootnoteJumperPlugin extends Plugin {
    private enabled = true;
    private liveRefreshEditingBlock = true;
    private topBarElement?: HTMLElement;
    private observer?: MutationObserver;
    private refreshTimer = 0;
    private refreshTimerAt = 0;
    private activeRefreshAt = 0;
    private isRendering = false;
    private isComposing = false;
    private suppressSelectionSync = false;
    private definitions = new Map<string, FootnoteDefinition>();
    private definitionSignatures = new WeakMap<HTMLElement, string>();
    private dirtyBlocks = new Set<HTMLElement>();
    private activeBlock?: HTMLElement;
    private activeBlockId?: string;
    private tooltipElement?: HTMLElement;
    private activeTooltipRef?: HTMLElement;

    private readonly handleDocumentClick = (event: MouseEvent) => {
        if (!this.enabled) {
            return;
        }

        const target = event.target as HTMLElement;
        const refElement = target?.closest?.(`.${REF_CLASS}`) as HTMLElement;
        if (!refElement) {
            return;
        }

        const id = refElement.dataset.footnoteId;
        if (!id) {
            return;
        }

        const definition = this.findDefinition(id, refElement);
        if (!definition) {
            showMessage(`未找到脚注 [^${id}] 的定义`);
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        definition.element.scrollIntoView({
            behavior: "smooth",
            block: "center",
        });
        definition.element.classList.remove(HIGHLIGHT_CLASS);
        window.setTimeout(() => definition.element.classList.add(HIGHLIGHT_CLASS), 30);
        window.setTimeout(() => definition.element.classList.remove(HIGHLIGHT_CLASS), 1800);
    };

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

    private readonly handlePointerUp = () => {
        if (!this.suppressSelectionSync) {
            return;
        }

        window.setTimeout(() => {
            this.suppressSelectionSync = false;
            this.syncActiveBlock();
        }, 0);
    };

    private readonly handleSelectionChange = () => {
        if (!this.enabled || this.isRendering || this.isComposing || this.suppressSelectionSync) {
            return;
        }

        this.syncActiveBlock();
    };

    private readonly handlePointerOver = (event: PointerEvent) => {
        if (!this.enabled) {
            return;
        }

        const refElement = this.getReferenceElement(event.target);
        if (!refElement) {
            return;
        }

        this.activeTooltipRef = refElement;
        this.showTooltip(refElement);
    };

    private readonly handlePointerMove = () => {
        if (!this.enabled || !this.activeTooltipRef) {
            return;
        }

        this.positionTooltip(this.activeTooltipRef);
    };

    private readonly handlePointerOut = (event: PointerEvent) => {
        const refElement = this.getReferenceElement(event.target);
        if (!refElement) {
            return;
        }

        const nextTarget = event.relatedTarget as HTMLElement | null;
        if (nextTarget && refElement.contains(nextTarget)) {
            return;
        }

        this.hideTooltip();
    };

    private readonly handleViewportChange = () => {
        if (!this.enabled || !this.activeTooltipRef) {
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
    }

    async onLayoutReady() {
        await this.loadSettings();
        this.topBarElement = this.addTopBar({
            icon: "iconFootnoteJumper",
            title: "脚注跳转",
            position: "right",
            callback: (event) => this.openTopBarMenu(event),
        });
        this.updateTopBarState();

        document.addEventListener("click", this.handleDocumentClick, true);
        document.addEventListener("pointerdown", this.handlePointerDown, true);
        document.addEventListener("pointerup", this.handlePointerUp, true);
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
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = 0;
        this.refreshTimerAt = 0;
        this.observer?.disconnect();
        document.removeEventListener("click", this.handleDocumentClick, true);
        document.removeEventListener("pointerdown", this.handlePointerDown, true);
        document.removeEventListener("pointerup", this.handlePointerUp, true);
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
        this.cleanupEnhancements();
    }

    private async loadSettings() {
        try {
            const settings = await this.loadData(STORAGE_NAME) as FootnoteSettings;
            if (typeof settings?.enabled === "boolean") {
                this.enabled = settings.enabled;
            }
            if (typeof settings?.liveRefreshEditingBlock === "boolean") {
                this.liveRefreshEditingBlock = settings.liveRefreshEditingBlock;
            }
        } catch (error) {
            console.warn(`[${this.name}] load settings failed`, error);
        }
    }

    private saveSettings() {
        const settings: FootnoteSettings = {
            enabled: this.enabled,
            liveRefreshEditingBlock: this.liveRefreshEditingBlock,
        };
        this.saveData(STORAGE_NAME, settings).catch((error) => {
            console.warn(`[${this.name}] save settings failed`, error);
        });
    }

    private openTopBarMenu(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();

        const menu = new Menu("siyuan-footnote-jumper-menu");
        menu.addItem({
            label: "脚注跳转",
            icon: "iconFootnoteJumper",
            checked: this.enabled,
            click: () => {
                this.setEnabled(!this.enabled);
            },
        });
        menu.addItem({
            label: "编辑块实时刷新",
            icon: "iconRefresh",
            checked: this.liveRefreshEditingBlock,
            click: () => {
                this.setLiveRefreshEditingBlock(!this.liveRefreshEditingBlock);
            },
        });

        const rect = this.topBarElement?.getBoundingClientRect();
        menu.open({
            x: rect ? rect.left : event.clientX,
            y: rect ? rect.bottom : event.clientY,
        });
    }

    private setEnabled(enabled: boolean) {
        if (this.enabled === enabled) {
            return;
        }

        this.enabled = enabled;
        this.updateTopBarState();
        this.saveSettings();

        if (this.enabled) {
            this.startObserving();
            this.activeBlock = this.getSelectionBlock();
            this.activeBlockId = this.activeBlock?.dataset.nodeId;
            this.markAllBlocksDirty();
            this.scheduleRefresh(50);
            showMessage("脚注跳转已开启");
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
            this.cleanupEnhancements();
            showMessage("脚注跳转已关闭");
        }
    }

    private setLiveRefreshEditingBlock(enabled: boolean) {
        if (this.liveRefreshEditingBlock === enabled) {
            return;
        }

        this.liveRefreshEditingBlock = enabled;
        this.saveSettings();

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

    private updateTopBarState() {
        if (!this.topBarElement) {
            return;
        }

        this.topBarElement.classList.toggle("siyuan-footnote-topbar--enabled", this.enabled);
        this.topBarElement.setAttribute("aria-pressed", String(this.enabled));
        this.topBarElement.setAttribute("aria-label", "脚注跳转");
        this.topBarElement.removeAttribute("title");
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
        if (block.closest(".protyle-wysiwyg")) {
            this.dirtyBlocks.add(block);
        }
    }

    private markEditorDirty(editor: HTMLElement) {
        for (const block of Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]"))) {
            this.dirtyBlocks.add(block);
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

    private refresh() {
        if (!this.enabled || this.isComposing) {
            return;
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

        const editors = Array.from(document.querySelectorAll<HTMLElement>(".protyle-wysiwyg"));
        const definitionsByEditor = new Map<HTMLElement, Map<string, FootnoteDefinition>>();
        this.definitions.clear();

        for (const editor of editors) {
            const definitions = this.collectDefinitions(editor);
            definitionsByEditor.set(editor, definitions);
            for (const [id, definition] of definitions) {
                this.definitions.set(id, definition);
            }

            const signature = Array.from(definitions.values())
                .map((definition) => `${definition.id}\u0000${definition.content}`)
                .join("\u0001");
            const definitionChanged = this.definitionSignatures.get(editor) !== signature;
            if (definitionChanged) {
                this.markEditorDirty(editor);
                this.definitionSignatures.set(editor, signature);
            }
        }

        const now = Date.now();
        const blocks = Array.from(this.dirtyBlocks).filter((block) => {
            return block.isConnected
                && (!this.isActiveBlock(block)
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
                    || this.getVisibleText(block).includes("[^");

                if (!needsEnhancement) {
                    this.dirtyBlocks.delete(block);
                    continue;
                }

                const bookmark = this.isActiveBlock(block) ? this.captureSelection(block) : undefined;
                this.cleanupBlock(block);

                if (definitions) {
                    const definition = Array.from(definitions.values()).find((item) => item.element === block);
                    if (definition) {
                        block.classList.add(DEF_CLASS);
                        block.dataset.footnoteId = definition.id;
                    }
                    this.wrapReferences(block, definitions);
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
        const definitions = new Map<string, FootnoteDefinition>();
        const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"));

        for (const block of blocks) {
            const text = this.getVisibleText(block).trim();
            const match = text.match(/^\[\^([^\]\s:]+)\]:\s*([\s\S]*)$/);
            if (!match) {
                continue;
            }

            const definition: FootnoteDefinition = {
                id: match[1],
                content: match[2].trim() || "空脚注",
                element: block,
            };
            definitions.set(definition.id, definition);
        }

        return definitions;
    }

    private wrapReferences(root: HTMLElement, definitions: Map<string, FootnoteDefinition>) {
        const textNodes: Text[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => this.acceptReferenceTextNode(node, root),
        });

        while (walker.nextNode()) {
            textNodes.push(walker.currentNode as Text);
        }

        for (const textNode of textNodes) {
            this.wrapReferenceTextNode(textNode, definitions);
        }
    }

    private acceptReferenceTextNode(node: Node, block: HTMLElement) {
        const text = node.textContent || "";
        if (!text.includes("[^")) {
            return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent) {
            return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest(`.${REF_CLASS}, .${DEF_CLASS}, [${ENHANCED_ATTR}], style, script, textarea, input`)) {
            return NodeFilter.FILTER_REJECT;
        }

        if (!parent.closest(".protyle-wysiwyg")) {
            return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest("[data-node-id]") !== block) {
            return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
    }

    private wrapReferenceTextNode(textNode: Text, definitions: Map<string, FootnoteDefinition>) {
        const text = textNode.nodeValue || "";
        const regex = /\[\^([^\]\s:]+)\]/g;
        let match: RegExpExecArray | null;
        let lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let changed = false;

        while ((match = regex.exec(text)) !== null) {
            changed = true;
            const [raw, id] = match;
            if (match.index > lastIndex) {
                fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const definition = definitions.get(id);
            const refElement = document.createElement("span");
            refElement.className = definition ? REF_CLASS : `${REF_CLASS} ${MISSING_CLASS}`;
            refElement.textContent = raw;
            refElement.dataset.footnoteId = id;
            refElement.dataset.preview = definition ? definition.content : "未找到对应脚注定义";
            refElement.setAttribute(ENHANCED_ATTR, "true");
            refElement.setAttribute("contenteditable", "false");
            fragment.append(refElement);

            lastIndex = match.index + raw.length;
        }

        if (!changed) {
            return;
        }

        if (lastIndex < text.length) {
            fragment.append(document.createTextNode(text.slice(lastIndex)));
        }
        textNode.parentNode?.replaceChild(fragment, textNode);
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
                parent.replaceChild(document.createTextNode(ref.textContent || ""), ref);
                parent.normalize();
            }

            const definitions = Array.from(document.querySelectorAll<HTMLElement>(`.${DEF_CLASS}`));
            for (const definition of definitions) {
                definition.classList.remove(DEF_CLASS, HIGHLIGHT_CLASS);
                delete definition.dataset.footnoteId;
            }
        } finally {
            this.isRendering = previousRenderingState;
        }
    }

    private cleanupBlock(block: HTMLElement) {
        this.hideTooltip();
        const refs = Array.from(block.querySelectorAll<HTMLElement>(`.${REF_CLASS}[${ENHANCED_ATTR}]`))
            .filter((ref) => ref.closest("[data-node-id]") === block);

        for (const ref of refs) {
            const parent = ref.parentNode;
            if (!parent) {
                continue;
            }
            parent.replaceChild(document.createTextNode(ref.textContent || ""), ref);
            parent.normalize();
        }

        block.classList.remove(DEF_CLASS, HIGHLIGHT_CLASS);
        delete block.dataset.footnoteId;
    }

    private findDefinition(id: string, refElement: HTMLElement) {
        const editor = refElement.closest(".protyle-wysiwyg");
        const localDefinition = editor
            ? Array.from(editor.querySelectorAll<HTMLElement>(`.${DEF_CLASS}`)).find((item) => item.dataset.footnoteId === id)
            : undefined;

        if (localDefinition) {
            return {
                id,
                content: this.getVisibleText(localDefinition).trim(),
                element: localDefinition,
            };
        }

        return this.definitions.get(id);
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

    private showTooltip(refElement: HTMLElement) {
        const text = refElement.dataset.preview;
        if (!text) {
            this.hideTooltip();
            return;
        }

        refElement.removeAttribute("title");
        refElement.removeAttribute("aria-label");
        const tooltip = this.ensureTooltip();
        tooltip.textContent = text;
        tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
        this.positionTooltip(refElement);
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

    private hideTooltip() {
        this.activeTooltipRef = undefined;
        this.tooltipElement?.classList.remove(TOOLTIP_VISIBLE_CLASS);
    }

    private destroyTooltip() {
        this.tooltipElement?.remove();
        this.tooltipElement = undefined;
        this.activeTooltipRef = undefined;
    }
}
