import {Dialog, confirm, fetchSyncPost, getActiveEditor, getAllEditor, getFrontend, IOperation, IProtyle, Plugin, Protyle, showMessage} from "siyuan";
import {applyInsertionToEditor, applyNormalizationToEditor, auditFootnoteFormat, buildDocumentSnapshot, documentContentSignature, DEFAULT_PREFERENCES, DocumentSnapshot, FootnotePreferences, includeQueuedBlocks, NormalizationOptions, prepareInsertion, prepareNormalization, resolveNormalizationOptions} from "./document";
import {FootnoteSidebar, IncrementalList} from "./sidebar";
import {flushDocumentEdits} from "./editing";

const DOCK_TYPE = "footnotes";
let pickerSequence = 0;
const escapeHTML = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const transactionSignature = (transaction: ReturnType<typeof prepareNormalization>) => JSON.stringify(transaction,
    (key, value) => key === "data" && typeof value === "string" ? documentContentSignature(value) : value);

interface ManagerHost {
    navigate(blockId: string): Promise<void>;
    tablePending(block: HTMLElement): boolean;
    changed(rootId: string): void;
    jumpEnabled(): boolean;
    setJumpEnabled(enabled: boolean): void;
    preferences?(): FootnotePreferences;
    setPreferences?(preferences: FootnotePreferences): void;
    liveRefresh?(): boolean;
    setLiveRefresh?(enabled: boolean): void;
    manualRefresh?(editor: Protyle): void | Promise<void>;
    checkDuplicates?(anchor: HTMLElement, editor?: Protyle): void;
}

export class FootnoteManager {
    private sidebar?: FootnoteSidebar;
    private main?: Protyle;
    private mainRootId?: string;
    private timer = 0;
    private disposed = false;
    private busy = false;
    private composing = false;
    private revision = 0;
    private request = 0;
    private visibility?: MutationObserver;
    private visible = false;
    private pendingSelection?: {rootId: string; blockId: string; focus?: boolean};
    private snapshot?: DocumentSnapshot;
    private formatIssues: string[] = [];
    private refreshing?: {editor?: Protyle; rootId?: string; promise?: Promise<void>; revision: number; request: number; rerun: boolean};
    private insertionDialog?: Dialog;
    private manualRefreshPending = false;
    private previousLabels = new Map<string, Map<string, string>>();

    constructor(private plugin: Plugin, private host: ManagerHost) {}

    register() {
        this.plugin.addDock({
            type: DOCK_TYPE, data: {},
            config: {position: "RightTop", size: {width: 360, height: 0}, icon: "iconFootnoteJumper", title: "脚注"},
            init: (dock) => {
                this.sidebar?.destroy();
                this.sidebar = new FootnoteSidebar(dock.element as HTMLElement, this.plugin.app, {
                    navigate: (id) => void this.host.navigate(id).catch((error) => this.error(error)),
                    normalize: (options) => void this.normalize(options),
                    refresh: () => {
                        this.manualRefreshPending = true;
                        this.performManualRefresh();
                    },
                    preferences: () => this.host.preferences?.() || DEFAULT_PREFERENCES,
                    setPreferences: (preferences) => {this.host.setPreferences?.(preferences); this.schedule(0);},
                    liveRefresh: () => this.host.liveRefresh?.() ?? true,
                    setLiveRefresh: (enabled) => this.host.setLiveRefresh?.(enabled),
                    checkDuplicates: (anchor) => this.host.checkDuplicates?.(anchor, this.main),
                    ready: () => this.schedule(1000),
                    readonly: () => this.readonly(),
                    jumpEnabled: () => this.host.jumpEnabled(),
                    setJumpEnabled: (enabled) => this.host.setJumpEnabled(enabled),
                });
                this.observeVisibility();
                this.updateVisibility();
            },
            update: () => {this.updateVisibility(); this.schedule(0);},
            resize: () => {this.updateVisibility(); this.sidebar?.resize();},
            destroy: () => {
                this.visibility?.disconnect();
                this.sidebar?.destroy();
                this.sidebar = undefined;
                this.visible = false;
                this.request++;
            },
        });
        this.plugin.protyleSlash = [{
            id: "insert-footnote", filter: ["脚注", "插入脚注", "footnote", "jz"],
            html: '<div class="b3-list-item__first"><span class="b3-list-item__text">插入脚注</span></div>',
            callback: (editor, block) => void this.insert(editor, block),
        }];
        this.plugin.eventBus.on("switch-protyle", this.handleSwitch);
        this.plugin.eventBus.on("loaded-protyle-static", this.handleLoaded);
        this.plugin.eventBus.on("loaded-protyle-dynamic", this.handleLoaded);
        this.plugin.eventBus.on("destroy-protyle", this.handleDestroyed);
        this.plugin.eventBus.on("ws-main", this.handleKernel);
        document.addEventListener("input", this.handleInput, true);
        document.addEventListener("compositionstart", this.handleCompositionStart, true);
        document.addEventListener("compositionend", this.handleCompositionEnd, true);
        document.addEventListener("pointerdown", this.handlePointer, true);
        document.addEventListener("transitionend", this.handleVisibilityTransition, true);
        this.captureMain();
    }

    updateJumpStyle(enabled: boolean) {this.sidebar?.setJumpEnabled(enabled);}

    updatePreferences() {
        this.sidebar?.setPreferences(this.host.preferences?.() || DEFAULT_PREFERENCES);
        this.sidebar?.setLiveRefresh(this.host.liveRefresh?.() ?? true);
        this.schedule(0);
    }

    private performManualRefresh() {
        if (!this.manualRefreshPending || this.composing) return;
        this.manualRefreshPending = false;
        if (this.main) {
            Promise.resolve(this.host.manualRefresh?.(this.main)).then(() => this.schedule(0), (error) => this.error(error));
        }
    }

    private readonly handleSwitch = (event: CustomEvent<{protyle: IProtyle}>) => {
        const protyle = event.detail.protyle;
        if (this.isSidebar(protyle) || !protyle?.block?.rootID) return;
        if (this.main?.protyle !== protyle || this.mainRootId !== protyle.block.rootID) {
            this.revision++;
            this.request++;
            this.main = protyle.getInstance?.() || getAllEditor().find((editor) => editor.protyle === protyle);
            this.mainRootId = protyle.block.rootID;
            this.pendingSelection = undefined;
            this.snapshot = undefined;
            this.sidebar?.clear("正在读取脚注…");
        }
        this.schedule(0);
    };

    private readonly handleLoaded = (event: CustomEvent<{protyle?: IProtyle}>) => {
        this.captureMain();
        const rootId = event.detail?.protyle?.block?.rootID;
        if (rootId && rootId !== this.mainRootId) return;
        this.schedule(300);
    };
    private readonly handleDestroyed = (event: CustomEvent<{protyle: IProtyle}>) => {
        if (event.detail.protyle !== this.main?.protyle) return;
        this.main = undefined;
        this.mainRootId = undefined;
        this.request++;
        this.sidebar?.clear();
        this.schedule(100);
    };

    private readonly handleKernel = (event: CustomEvent<{cmd: string; data?: unknown}>) => {
        if (["transactions", "refresh", "syncFinish"].indexOf(event.detail.cmd) < 0) return;
        if (event.detail.cmd === "transactions" && !this.affectsMain(event.detail.data)) return;
        const transactions = (Array.isArray(event.detail.data) ? event.detail.data : [event.detail.data]) as
            {doOperations?: IOperation[]}[];
        // Undo/redo can replace an entire list or restore its former paragraphs.
        // Discard the embedded copy before it can overlay the restored kernel DOM.
        if (event.detail.cmd !== "transactions" || transactions.some((transaction) =>
            Array.isArray(transaction?.doOperations)
            && transaction.doOperations.some((operation) => ["insert", "delete", "move"].indexOf(operation?.action) >= 0))) {
            this.sidebar?.invalidateEditor();
        }
        this.revision++;
        this.schedule(1000);
    };

    private affectsMain(data: unknown) {
        type Transaction = {rootID?: string; doOperations?: (IOperation & {rootID?: string})[]};
        const transactions = (Array.isArray(data) ? data : data ? [data] : []) as Transaction[];
        if (!transactions.length || !this.mainRootId) return true;
        for (const transaction of transactions) {
            if (!transaction || typeof transaction !== "object") return true;
            const operations = transaction.doOperations;
            if (operations !== undefined && !Array.isArray(operations)) return true;
            if (!operations?.length) {
                if (!transaction.rootID || transaction.rootID === this.mainRootId) return true;
                continue;
            }
            for (const operation of operations) {
                if (!operation || typeof operation !== "object") return true;
                const rootId = operation.rootID || transaction.rootID;
                if (rootId) {if (rootId === this.mainRootId) return true; continue;}
                // An unscoped transaction cannot safely be discarded.
                return true;
            }
        }
        return false;
    }

    private readonly handleInput = (event: Event) => {
        const element = event.target as HTMLElement;
        const editing = element?.closest?.(".protyle-wysiwyg");
        if (!editing) return;
        this.captureMain();
        if (editing !== this.main?.protyle?.wysiwyg?.element && editing !== this.sidebar?.protyle?.wysiwyg?.element) return;
        this.revision++;
        this.schedule(1000);
    };

    private readonly handleCompositionStart = () => {this.composing = true;};
    private readonly handleCompositionEnd = () => {this.composing = false; this.revision++; this.performManualRefresh(); this.schedule(1000);};
    private readonly handlePointer = (event: PointerEvent) => {
        const editorElement = (event.target as HTMLElement)?.closest?.(".protyle-wysiwyg");
        if (!editorElement || editorElement.closest("[data-footnote-sidebar]")) return;
        const editor = getAllEditor().find((item) => item.protyle?.wysiwyg?.element === editorElement);
        if (editor && editor !== this.main) this.handleSwitch(new CustomEvent("switch-protyle", {detail: {protyle: editor.protyle}}));
    };

    private readonly handleVisibilityTransition = (event: Event) => {
        if (this.sidebar && event.target instanceof HTMLElement && event.target.contains(this.sidebar.element)) this.updateVisibility();
    };

    private isSidebar(protyle?: IProtyle) {
        return Boolean(protyle?.wysiwyg?.element?.closest("[data-footnote-sidebar]"));
    }

    private captureMain() {
        const editor = getActiveEditor();
        if (!editor?.protyle?.block?.rootID || this.isSidebar(editor.protyle)) return;
        if (editor !== this.main || editor.protyle.block.rootID !== this.mainRootId) {
            this.revision++;
            this.request++;
            this.pendingSelection = undefined;
            this.snapshot = undefined;
            this.sidebar?.clear("正在读取脚注…");
        }
        this.main = editor;
        this.mainRootId = editor.protyle.block.rootID;
    }

    private readonly() {
        return Boolean(window.siyuan?.config?.readonly || window.siyuan?.isPublish || this.main?.protyle?.disabled);
    }

    private assertWritable(editor: Protyle) {
        this.captureMain();
        if (this.disposed || this.readonly()) throw new Error("当前文档为只读，无法修改脚注");
        if (this.main !== editor || !editor.protyle.wysiwyg?.element?.isConnected) throw new Error("当前文档已切换，请重新执行");
        if (this.composing) throw new Error("请结束输入法组合输入后重试");
    }

    private async flush(editor: Protyle) {
        await this.sidebar?.flushPendingEdits();
        await flushDocumentEdits([editor, this.sidebar?.protyle?.getInstance?.()],
            () => this.assertWritable(editor), (block) => this.host.tablePending(block));
    }

    private async read(editor: Protyle, insertion = false) {
        const rootId = editor.protyle.block.rootID;
        const response = await fetchSyncPost("/api/block/getBlockDOM", {id: rootId});
        if (response.code !== 0 || typeof response.data?.dom !== "string" || !response.data.dom.trim()) {
            throw new Error("读取全文失败，请重试");
        }
        const overlays = [editor.protyle.wysiwyg.element];
        const side = this.sidebar?.protyle;
        if (side?.block?.rootID === rootId && side.wysiwyg?.element) {
            // The focused copy wins when the same definition is open twice.
            if (editor.protyle.wysiwyg.element.contains(document.activeElement)) overlays.unshift(side.wysiwyg.element);
            else overlays.push(side.wysiwyg.element);
        }
        const dom = insertion ? includeQueuedBlocks(response.data.dom, overlays) : response.data.dom;
        const previous = this.previousLabels.get(rootId) || new Map<string, string>();
        let snapshot = buildDocumentSnapshot(rootId, dom, overlays, new Set(), previous);
        // Distinguish dangling footnote-shaped refs from refs into other documents.
        const targets = Array.from(new Set(snapshot.notes.filter((note) => note.missing).reduce<string[]>((all, note) =>
            all.concat(note.references.filter((ref) => ref.kind === "block").map((ref) => ref.targetId)), []).filter(Boolean)));
        const ignored = new Set<string>();
        for (let i = 0; i < targets.length; i += 256) {
            const ids = targets.slice(i, i + 256).map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
            const result = await fetchSyncPost("/api/query/sql", {stmt: `SELECT id, root_id FROM blocks WHERE id IN (${ids}) LIMIT 256`});
            if (result.code !== 0 || !Array.isArray(result.data)) throw new Error("读取块引目标失败，请重试");
            for (const row of result.data) if (row.root_id !== rootId) ignored.add(row.id);
        }
        if (ignored.size) snapshot = buildDocumentSnapshot(rootId, dom, overlays, ignored, previous);
        for (const note of snapshot.notes) if (note.blockId && !previous.has(note.blockId)) previous.set(note.blockId, note.label);
        this.previousLabels.set(rootId, previous);
        return snapshot;
    }

    private schedule(delay: number) {
        if (this.disposed) return;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {this.timer = 0; void this.refresh();}, delay);
    }

    private async refresh() {
        this.captureMain();
        if (this.disposed) return;
        const current = this.refreshing;
        if (current && current.editor === this.main && current.rootId === this.mainRootId) {
            current.rerun = current.rerun || current.revision !== this.revision || current.request !== this.request;
            return current.promise;
        }
        const state = {editor: this.main, rootId: this.mainRootId, promise: undefined as Promise<void>, revision: this.revision, request: this.request, rerun: false};
        this.refreshing = state;
        state.promise = this.refreshOnce();
        state.request = this.request;
        try {await state.promise;}
        finally {
            if (this.refreshing === state) {
                this.refreshing = undefined;
                if (state.rerun) this.schedule(0);
            }
        }
    }

    private async refreshOnce() {
        if (this.disposed) return;
        if (this.composing || this.busy) {this.schedule(1000); return;}
        const editor = this.main;
        if (!editor?.protyle?.wysiwyg?.element?.isConnected) {this.sidebar?.clear(); return;}
        const request = ++this.request, revision = this.revision;
        try {
            const snapshot = await this.read(editor);
            if (this.disposed || this.main !== editor || request !== this.request) return;
            if (revision !== this.revision) {this.schedule(1000); return;}
            this.snapshot = snapshot;
            this.formatIssues = auditFootnoteFormat(snapshot, this.host.preferences?.() || DEFAULT_PREFERENCES);
            if (!this.visible || !this.sidebar) return;
            if (this.pendingSelection?.rootId === snapshot.rootId
                && snapshot.notes.some((note) => note.blockId === this.pendingSelection.blockId)) {
                this.sidebar.selectNew(this.pendingSelection.blockId, this.pendingSelection.focus ?? true);
                this.pendingSelection = undefined;
            }
            this.sidebar.render(snapshot, editor.protyle.title?.editElement?.textContent || "当前文档");
        } catch (error) {
            if (!this.disposed && request === this.request) this.sidebar?.message(error instanceof Error ? error.message : "读取脚注失败");
        }
    }

    async normalize(options: NormalizationOptions) {
        if (this.busy || this.disposed) return;
        this.captureMain();
        const editor = this.main;
        if (!editor) {this.error(new Error("请先打开文档")); return;}
        const rootId = editor.protyle.block.rootID;
        this.setBusy(true);
        try {
            this.assertWritable(editor);
            await this.flush(editor);
            const revision = this.revision;
            const snapshot = await this.read(editor);
            this.assertWritable(editor);
            if (editor.protyle.block.rootID !== rootId) throw new Error("当前文档已切换，请重新执行");
            if (revision !== this.revision) throw new Error("正文或脚注已改变，请重试");
            const signature = documentContentSignature(snapshot.container);
            if (snapshot.notes.some((note) => note.duplicate || note.missing)) {
                this.open();
                this.sidebar?.render(snapshot, editor.protyle.title?.editElement?.textContent || "当前文档");
            }
            const allocated: string[] = [];
            options = resolveNormalizationOptions(snapshot, options);
            const transaction = prepareNormalization(snapshot, options, () => {
                if (typeof window.Lute?.NewNodeID !== "function") throw new Error("思源块 ID 生成器尚未就绪，请重试");
                const id = window.Lute.NewNodeID(); allocated.push(id); return id;
            });
            if (!transaction.forward.length) {showMessage("脚注格式已经统一"); return;}
            const changes = transaction.mapping.filter((item) => item.from !== item.to)
                .map((item) => `[^${item.from}] → [^${item.to}]`).join("；");
            confirm("统一脚注格式", `将整理 ${transaction.referenceCount} 处引用，更新 ${transaction.forward.length} 个块。`
                + `<br>引用写法：${options.format === "text" ? "文本标记 [^编号]" : options.format === "keep" ? "保留写法" : "静态块引"}`
                + (options.format !== "text" ? `；块引编号：${options.blockLabel === "brackets" ? "[编号]" : "[^编号]"}` : "")
                + (options.superscript ? "；引用使用原生上标" : "；保留已有行内样式")
                + (options.definitionFormat ? `<br>脚注定义：${options.definitionFormat === "list" ? "文末有序列表" : "[^编号]: 内容"}` : "")
                + (changes ? `<br>${escapeHTML(changes)}` : "") + "<br><br>可通过一次撤销恢复。", () => {
                void this.applyNormalization(editor, rootId, signature, options, transaction, allocated);
            });
        } catch (error) {this.error(error);}
        finally {this.setBusy(false);}
    }

    private async applyNormalization(editor: Protyle, rootId: string, signature: string, options: NormalizationOptions,
        reviewed: ReturnType<typeof prepareNormalization>, allocated: string[] = []) {
        if (this.busy || this.disposed) return;
        this.setBusy(true);
        try {
            this.assertWritable(editor);
            if (editor.protyle.block.rootID !== rootId) throw new Error("当前文档已切换，请重新执行");
            await this.flush(editor);
            let snapshot: DocumentSnapshot;
            // A save notification may arrive after flush has resolved. Read again
            // rather than treating that notification alone as a content change.
            for (let attempt = 0; attempt < 3; attempt++) {
                const revision = this.revision;
                snapshot = await this.read(editor);
                this.assertWritable(editor);
                if (editor.protyle.block.rootID !== rootId) throw new Error("当前文档已切换，请重新执行");
                if (revision === this.revision) break;
                if (attempt === 2) throw new Error("文档正在保存，请稍后重新整理");
            }
            if (documentContentSignature(snapshot.container) !== signature) throw new Error("正文或脚注已改变，请重新整理并确认");
            let index = 0;
            const transaction = prepareNormalization(snapshot, options, () => {
                if (!allocated[index]) throw new Error("整理目标已改变，请重试");
                return allocated[index++];
            });
            if (transactionSignature(transaction) !== transactionSignature(reviewed)) throw new Error("整理目标已改变，请重试");
            const selection = window.getSelection();
            const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
            const bookmark = range && {startContainer: range.startContainer, startOffset: range.startOffset,
                endContainer: range.endContainer, endOffset: range.endOffset};
            const local = applyNormalizationToEditor(editor.protyle.wysiwyg.element, transaction, rootId);
            try {
                editor.transaction(transaction.forward, transaction.undo);
            } catch (error) {
                local.rollback();
                if (bookmark) {
                    const restored = document.createRange();
                    restored.setStart(bookmark.startContainer, bookmark.startOffset);
                    restored.setEnd(bookmark.endContainer, bookmark.endOffset);
                    selection.removeAllRanges(); selection.addRange(restored);
                }
                throw error;
            }
            // Keep the next native edit's undo baseline in sync with the new DOM.
            const lastHTMLs = editor.protyle.wysiwyg.lastHTMLs;
            if (lastHTMLs) {
                for (const operation of transaction.forward) delete lastHTMLs[operation.id];
                for (const block of Array.from(editor.protyle.wysiwyg.element.querySelectorAll<HTMLElement>("[data-node-id]"))) {
                    if (block.closest('[data-type="NodeBlockQueryEmbed"]')) continue;
                    lastHTMLs[block.dataset.nodeId] = block.outerHTML;
                }
            }
            this.previousLabels.delete(rootId);
            this.sidebar?.invalidateEditor();
            this.host.changed(snapshot.rootId);
            showMessage(`已提交 ${transaction.referenceCount} 处脚注引用的格式整理`);
            this.schedule(1000);
        } catch (error) {this.error(error);}
        finally {this.setBusy(false);}
    }

    async insert(editor: Protyle, block: HTMLElement) {
        if (this.busy || this.disposed || this.insertionDialog) return;
        if (this.isSidebar(editor.protyle)) {this.error(new Error("请在正文中插入脚注")); return;}
        this.captureMain();
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
        const editable = block?.querySelector('[contenteditable="true"]');
        if (!range || !editable?.contains(range.startContainer) || !editable.contains(range.endContainer)
            || block.closest('[data-type="NodeBlockQueryEmbed"]') || ["NodeParagraph", "NodeHeading"].indexOf(block.dataset.type) < 0) {
            this.error(new Error("请在正文段落或标题中使用斜杠菜单插入脚注")); return;
        }
        const before = range.cloneRange(); before.selectNodeContents(editable);
        before.setEnd(range.startContainer, range.startOffset);
        const start = before.toString().length, command = range.toString();
        if (!/^[\/、]/.test(command)) {this.error(new Error("无法获取斜杠命令选区，请重新执行")); return;}
        const rootId = editor.protyle.block.rootID, blockId = block.dataset.nodeId;
        const sourceSignature = documentContentSignature(block.outerHTML);
        try {this.assertWritable(editor);} catch (error) {this.error(error); return;}
        const pickerId = `footnote-picker-${++pickerSequence}`;
        let pickerRows: IncrementalList<DocumentSnapshot["notes"][number]>;
        const dialog = new Dialog({title: "插入脚注", width: "460px",
            content: `<div class="siyuan-footnote-picker">
                <input type="text" class="b3-text-field siyuan-footnote-picker__search" data-picker-search role="combobox" aria-label="搜索脚注" aria-autocomplete="list" aria-expanded="true" aria-controls="${pickerId}-notes" aria-describedby="${pickerId}-hint" placeholder="输入编号或内容，搜索已有脚注" autocomplete="off" spellcheck="false">
                <div id="${pickerId}-hint" class="siyuan-footnote-picker__hint">↑ ↓ 选择 · Enter 前往确认 · Esc 取消</div>
                <div data-picker-status role="status" aria-live="polite">正在读取脚注…</div>
                <div id="${pickerId}-notes" data-picker-notes role="listbox" aria-label="已有脚注"></div>
                <button type="button" class="siyuan-footnote-picker__create" data-picker-create aria-pressed="false" disabled>＋ 新建一条脚注</button>
                <div data-picker-draft hidden><label class="siyuan-footnote-picker__draft"><span>新脚注内容（可选）</span><textarea class="b3-text-field" data-picker-content aria-label="新脚注内容" rows="3" placeholder="填写新脚注内容，编号自动分配"></textarea></label>
                <div class="siyuan-footnote-picker__hint">编号自动分配，留空可在侧栏补充。</div></div>
                <div class="siyuan-footnote-picker__actions"><button class="b3-button" data-picker-submit disabled>插入脚注</button>
                <button class="b3-button b3-button--cancel" data-picker-cancel>取消</button></div></div>`,
            destroyCallback: () => {
                pickerRows?.destroy();
                if (this.insertionDialog === dialog) this.insertionDialog = undefined;
            },
        });
        this.insertionDialog = dialog;
        const status = dialog.element.querySelector<HTMLElement>("[data-picker-status]");
        const notes = dialog.element.querySelector<HTMLElement>("[data-picker-notes]");
        const search = dialog.element.querySelector<HTMLInputElement>("[data-picker-search]");
        const content = dialog.element.querySelector<HTMLTextAreaElement>("[data-picker-content]");
        const submitButton = dialog.element.querySelector<HTMLButtonElement>("[data-picker-submit]");
        const createButton = dialog.element.querySelector<HTMLButtonElement>("[data-picker-create]");
        const draft = dialog.element.querySelector<HTMLElement>("[data-picker-draft]");
        let available: DocumentSnapshot["notes"] = [];
        let matches: DocumentSnapshot["notes"] = [], choices: DocumentSnapshot["notes"] = [];
        const optionId = (note: DocumentSnapshot["notes"][number]) => `${pickerId}-option-${encodeURIComponent(note.key)}`;
        let active = -1, ready = false, composing = false, creating = false;
        const updateAction = () => {
            submitButton.textContent = creating ? "新建脚注" : "插入脚注";
            submitButton.disabled = !ready || this.busy || (!creating && !choices[active]);
            createButton.disabled = !ready || this.busy;
            createButton.setAttribute("aria-pressed", String(creating));
            draft.hidden = !creating;
            content.disabled = !creating || this.busy;
        };
        const activate = (index: number, scroll = false) => {
            active = index;
            creating = !choices[index];
            const selected = choices[index];
            if (selected) {
                // Keyboard navigation can select a candidate outside the rendered batch.
                const rendered = Array.from(notes.querySelectorAll<HTMLElement>("[data-picker-key]"))
                    .some((button) => button.dataset.pickerKey === selected.key);
                if (scroll || !rendered) pickerRows.reveal(selected.key);
                search.setAttribute("aria-activedescendant", optionId(selected));
            } else search.removeAttribute("aria-activedescendant");
            for (const button of Array.from(notes.querySelectorAll<HTMLElement>("[data-picker-key]"))) {
                button.setAttribute("aria-selected", String(button.dataset.pickerKey === selected?.key));
            }
            updateAction();
        };
        createButton.addEventListener("click", () => {activate(-1); content.focus();});
        const cancel = () => {
            dialog.destroy();
            // Restore the slash selection only if it still belongs to this editor.
            if (block.isConnected && editor.protyle.block.rootID === rootId
                && documentContentSignature(block.outerHTML) === sourceSignature && range.startContainer.isConnected) {
                const current = window.getSelection(); current.removeAllRanges(); current.addRange(range);
                editor.protyle.toolbar.range = range;
            }
        };
        dialog.element.querySelector("[data-picker-cancel]").addEventListener("click", cancel);
        search.focus();
        const readForInsertion = async () => {
            const snapshot = await this.read(editor, true);
            this.assertWritable(editor);
            const source = Array.from(editor.protyle.wysiwyg.element.querySelectorAll<HTMLElement>("[data-node-id]"))
                .find((node) => node.dataset.nodeId === blockId && !node.closest('[data-type="NodeBlockQueryEmbed"]'));
            if (editor.protyle.block.rootID !== rootId || !source
                || documentContentSignature(source.outerHTML) !== sourceSignature) throw new Error("正文或插入位置已改变，请重新执行");
            // A freshly created paragraph can still be queued in the native editor.
            // Its native creation precedes this transaction; do not wait for unrelated saves.
            if (!snapshot.blocks.some((node) => node.dataset.nodeId === blockId)) {
                const clone = source.cloneNode(true) as HTMLElement;
                snapshot.container.append(clone); snapshot.blocks.push(clone);
            }
            return snapshot;
        };
        const submit = async () => {
            const existingId = creating ? undefined : choices[active]?.blockId;
            if (!ready || (!creating && !existingId) || this.busy || this.insertionDialog !== dialog) return;
            this.setBusy(true);
            pickerRows.suspend();
            search.disabled = true;
            content.disabled = true;
            for (const button of Array.from(dialog.element.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = true;
            try {
                const snapshot = await readForInsertion();
                if (this.insertionDialog !== dialog || this.disposed) return;
                const preferences = this.host.preferences?.() || DEFAULT_PREFERENCES;
                const transaction = prepareInsertion(snapshot, blockId, start, start + command.length, command, () => {
                    if (typeof window.Lute?.NewNodeID !== "function") throw new Error("思源块 ID 生成器尚未就绪，请重启思源后重试");
                    return window.Lute.NewNodeID();
                }, {preferences, existingId, content: content.value});
                const bookmark = {startContainer: range.startContainer, startOffset: range.startOffset,
                    endContainer: range.endContainer, endOffset: range.endOffset};
                const local = applyInsertionToEditor(editor.protyle.wysiwyg.element, transaction, blockId, transaction.definitionId);
                try {
                    const caret = document.createRange(); caret.setStartAfter(local.reference); caret.collapse(true);
                    const current = window.getSelection(); current.removeAllRanges(); current.addRange(caret);
                    editor.protyle.toolbar.range = caret;
                    editor.transaction(transaction.forward, transaction.undo);
                    if (editor.protyle.wysiwyg.lastHTMLs) editor.protyle.wysiwyg.lastHTMLs[blockId] = transaction.forward
                        .find((operation) => operation.action === "update" && operation.id === blockId).data;
                } catch (error) {
                    local.rollback();
                    if (bookmark.startContainer.isConnected && bookmark.endContainer.isConnected) {
                        const restored = document.createRange(); restored.setStart(bookmark.startContainer, bookmark.startOffset);
                        restored.setEnd(bookmark.endContainer, bookmark.endOffset);
                        const current = window.getSelection(); current.removeAllRanges(); current.addRange(restored);
                        editor.protyle.toolbar.range = restored;
                    }
                    throw error;
                }
                this.pendingSelection = {rootId, blockId: transaction.definitionId, focus: transaction.created};
                this.sidebar?.showPanel("notes");
                this.host.changed(rootId); dialog.destroy(); this.open(); this.schedule(1000);
                showMessage(`已提交脚注 [^${transaction.label}]，可在侧栏编辑内容`);
            } catch (error) {
                this.error(error);
                if (this.insertionDialog === dialog) {
                    search.disabled = false;
                    content.disabled = false;
                    status.textContent = error instanceof Error ? error.message : "插入失败，请重试";
                    for (const button of Array.from(dialog.element.querySelectorAll<HTMLButtonElement>("button"))) {
                        button.disabled = button.dataset.unavailable === "true";
                    }
                }
            } finally {
                this.setBusy(false);
                if (this.insertionDialog === dialog) {updateAction(); pickerRows.resume();}
            }
        };
        submitButton.addEventListener("click", () => void submit());
        pickerRows = new IncrementalList(notes, notes, 40, (note) => note.key,
            (note) => JSON.stringify([note.label, note.content.slice(0, 100), note.missing, note.duplicate]),
            (note) => {
                const button = document.createElement("button"); button.type = "button";
                button.id = optionId(note); button.dataset.pickerKey = note.key;
                button.setAttribute("role", "option");
                button.setAttribute("aria-selected", String(choices[active]?.key === note.key)); button.tabIndex = -1;
                button.className = "b3-button b3-button--outline siyuan-footnote-picker__note";
                const number = document.createElement("strong"); number.className = "siyuan-footnote-picker__number";
                number.textContent = `[^${note.label}]`;
                const excerpt = document.createElement("span"); excerpt.className = "siyuan-footnote-picker__excerpt";
                excerpt.textContent = note.content.slice(0, 100) || "暂无内容";
                button.append(number, document.createTextNode("  "), excerpt);
                button.disabled = !note.blockId || note.duplicate || note.missing;
                button.dataset.unavailable = String(button.disabled); button.dataset.definitionId = note.blockId || "";
                button.setAttribute("aria-disabled", String(button.disabled));
                if (button.disabled) {
                    button.title = note.duplicate ? "编号重复，请先处理" : "缺失定义，请先处理";
                    const warning = document.createElement("small"); warning.className = "siyuan-footnote-picker__warning";
                    warning.textContent = note.duplicate ? "编号重复" : "缺失定义"; button.append(warning);
                } else {
                    button.addEventListener("click", () => activate(choices.indexOf(note)));
                }
                return button;
            }, "脚注候选");
        const filter = () => {
            if (!ready || this.busy) return;
            const query = search.value.trim().toLocaleLowerCase();
            const label = query.match(/^\[\^?([^\]\s:]+)\]$/)?.[1] || query;
            const tokens = label.split(/\s+/).filter(Boolean);
            matches = available.filter((note) => tokens.every((token) =>
                `${note.label}\n${note.content}`.toLocaleLowerCase().includes(token)));
            // Exact numbers come first even when the same text appears in other notes.
            matches.sort((a, b) => Number(b.label.toLocaleLowerCase() === label) - Number(a.label.toLocaleLowerCase() === label));
            choices = matches.filter((note) => note.blockId && !note.duplicate && !note.missing);
            active = -1;
            pickerRows.setItems(matches, true);
            activate(choices.length ? 0 : -1);
            status.textContent = !available.length ? "当前文档没有脚注，可新建脚注。"
                : !matches.length ? "没有匹配的脚注，可修改搜索或新建脚注。"
                : `${query ? `找到 ${matches.length} 条匹配脚注` : `共 ${available.length} 条脚注`}，选择已有脚注或新建。`;
        };
        search.addEventListener("compositionstart", () => {composing = true;});
        search.addEventListener("compositionend", () => {composing = false; filter();});
        search.addEventListener("input", () => {if (!composing) filter();});
        dialog.element.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.isComposing || event.keyCode === 229 || composing || this.busy) return;
            if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); cancel(); return;}
            if (event.target !== search || !ready) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (choices.length) {
                    const next = active < 0 ? (event.key === "ArrowDown" ? 0 : choices.length - 1)
                        : (active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
                    activate(next, true);
                }
            } else if (event.key === "Enter") {
                event.preventDefault();
                if (!submitButton.disabled) submitButton.focus();
            }
        });
        try {
            const snapshot = await readForInsertion();
            if (this.insertionDialog !== dialog || this.disposed) return;
            available = snapshot.notes; ready = true; filter();
        } catch (error) {
            if (this.insertionDialog === dialog) status.textContent = error instanceof Error ? error.message : "读取脚注失败，请重新打开";
        }
    }

    open() {
        const type = this.plugin.name + DOCK_TYPE;
        const frontend = getFrontend();
        if (frontend === "mobile" || frontend === "browser-mobile") {
            const tab = document.querySelector<HTMLElement>(`[data-type="sidebar-${type}-tab"]`);
            const panel = tab?.closest<HTMLElement>(".side-panel");
            if (panel && !tab.classList.contains("fn__none")) {
                for (const other of Array.from(document.querySelectorAll<HTMLElement>("#sidebar, #sidebarRight"))) {
                    if (other !== panel) other.style.transform = "";
                }
                panel.style.transform = "translateX(0px)";
                panel.firstElementChild?.dispatchEvent(new CustomEvent("click", {detail: type}));
            }
        } else {
            const layout = window.siyuan?.layout;
            const dock = [layout?.leftDock, layout?.rightDock, layout?.bottomDock]
                .find((item) => item && Object.prototype.hasOwnProperty.call(item.data, type));
            if (dock) dock.toggleModel(type, true);
            else if (!this.visible) document.querySelector<HTMLElement>(`.dock__item[data-type="${type}"]`)?.click();
        }
        this.updateVisibility();
        this.schedule(0);
    }

    private observeVisibility() {
        this.visibility?.disconnect();
        this.visibility = new MutationObserver(() => this.updateVisibility());
        // Observe only ancestor visibility attributes, never editor content.
        let element: HTMLElement = this.sidebar?.element;
        while (element) {
            this.visibility.observe(element, {attributes: true, attributeFilter: ["class", "style", "hidden"]});
            element = element.parentElement;
        }
    }

    private updateVisibility() {
        const element = this.sidebar?.element;
        let visible = Boolean(element?.isConnected && element.getClientRects().length);
        if (visible && ["mobile", "browser-mobile"].indexOf(getFrontend()) >= 0) {
            const rect = element.getBoundingClientRect();
            visible = rect.right > 0 && rect.left < window.innerWidth;
        }
        if (visible === this.visible) return;
        this.visible = visible;
        if (visible) {this.sidebar.resume(); this.schedule(0);}
        else {
            this.request++;
            window.clearTimeout(this.timer);
            this.timer = 0;
            this.sidebar?.suspend();
        }
    }

    private setBusy(value: boolean) {this.busy = value; this.sidebar?.setBusy(value);}
    private error(error: unknown) {showMessage(error instanceof Error ? error.message : "脚注操作失败，请重试", 5000, "error");}

    destroy() {
        this.disposed = true;
        this.insertionDialog?.destroy();
        this.insertionDialog = undefined;
        this.request++;
        window.clearTimeout(this.timer);
        this.visibility?.disconnect();
        this.plugin.eventBus.off("switch-protyle", this.handleSwitch);
        this.plugin.eventBus.off("loaded-protyle-static", this.handleLoaded);
        this.plugin.eventBus.off("loaded-protyle-dynamic", this.handleLoaded);
        this.plugin.eventBus.off("destroy-protyle", this.handleDestroyed);
        this.plugin.eventBus.off("ws-main", this.handleKernel);
        document.removeEventListener("input", this.handleInput, true);
        document.removeEventListener("compositionstart", this.handleCompositionStart, true);
        document.removeEventListener("compositionend", this.handleCompositionEnd, true);
        document.removeEventListener("pointerdown", this.handlePointer, true);
        document.removeEventListener("transitionend", this.handleVisibilityTransition, true);
        this.sidebar?.destroy();
        this.sidebar = undefined;
        this.main = undefined;
        this.mainRootId = undefined;
        this.pendingSelection = undefined;
        this.snapshot = undefined;
        this.previousLabels.clear();
        this.plugin.protyleSlash = [];
    }
}
