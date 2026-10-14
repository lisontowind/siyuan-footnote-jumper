import {App, Protyle, showMessage} from "siyuan";
import {DocumentSnapshot, IndexedFootnote, NormalizationOptions} from "./document";

interface SidebarActions {
    navigate(blockId: string): void;
    normalize(options: NormalizationOptions): void;
    refresh(): void;
    ready(): void;
    readonly(): boolean;
}

export class FootnoteSidebar {
    private list: HTMLElement;
    private context: HTMLElement;
    private status: HTMLElement;
    private editorHost: HTMLElement;
    private references: HTMLElement;
    private editor?: Protyle;
    private editorMount?: HTMLElement;
    private savingEditors = new Set<Promise<void>>();
    private editorId?: string;
    private selected?: string;
    private rootId?: string;
    private snapshot?: DocumentSnapshot;
    private normalizeButton: HTMLButtonElement;
    private format: HTMLSelectElement;
    private definitionFormat: HTMLSelectElement;
    private refreshNumbers: HTMLButtonElement;
    private renumber: HTMLInputElement;
    private generation = 0;
    private focusNew = false;
    private closed = false;
    private busy = false;
    private selectedKeys = new Map<string, string>();

    constructor(readonly element: HTMLElement, private app: App, private actions: SidebarActions) {
        element.setAttribute("data-footnote-sidebar", "true");
        element.classList.add("siyuan-footnote-sidebar");
        element.innerHTML = `<div class="block__icons">
            <div class="block__logo"><svg class="block__logoicon"><use href="#iconFootnoteJumper"></use></svg>脚注</div>
            <span class="fn__flex-1"></span>
            <button type="button" class="block__icon" data-action="refresh" aria-label="刷新脚注">↻</button>
            <span class="block__icon" data-type="min" aria-label="关闭脚注侧栏"><svg><use href="#iconMin"></use></svg></span>
        </div>
        <div class="siyuan-footnote-sidebar__context"></div>
        <div class="siyuan-footnote-sidebar__tools">
            <label>引用 <select class="b3-select" aria-label="目标脚注写法">
                <option value="block">静态块引</option><option value="text">文本标记</option><option value="keep">保留写法</option>
            </select></label>
            <label>定义 <select class="b3-select" aria-label="脚注定义格式" data-definition-format>
                <option value="list">文末有序列表</option><option value="literal">[^编号]: 内容</option>
            </select></label>
            <label><input type="checkbox" checked> 连续编号</label>
            <button type="button" class="b3-button b3-button--outline" data-action="normalize">统一格式</button>
            <button type="button" class="b3-button b3-button--outline" data-action="refresh-numbers" hidden>刷新序号</button>
        </div>
        <div class="siyuan-footnote-sidebar__status" role="status"></div>
        <div class="siyuan-footnote-sidebar__list" aria-label="脚注列表"></div>
        <div class="siyuan-footnote-sidebar__editor-title">脚注原块 · 自动保存</div>
        <div class="siyuan-footnote-sidebar__editor"></div>
        <div class="siyuan-footnote-sidebar__references" aria-label="被引段落"></div>`;
        this.context = element.querySelector(".siyuan-footnote-sidebar__context");
        this.list = element.querySelector(".siyuan-footnote-sidebar__list");
        this.status = element.querySelector(".siyuan-footnote-sidebar__status");
        this.editorHost = element.querySelector(".siyuan-footnote-sidebar__editor");
        this.references = element.querySelector(".siyuan-footnote-sidebar__references");
        this.normalizeButton = element.querySelector('[data-action="normalize"]');
        this.format = element.querySelector("select");
        this.definitionFormat = element.querySelector("[data-definition-format]");
        this.refreshNumbers = element.querySelector('[data-action="refresh-numbers"]');
        this.renumber = element.querySelector('input[type="checkbox"]');
        element.querySelector('[data-action="refresh"]').addEventListener("click", () => actions.refresh());
        this.normalizeButton.addEventListener("click", () => actions.normalize({
            format: this.format.value as NormalizationOptions["format"], renumber: this.renumber.checked,
            definitionFormat: this.definitionFormat.value as NormalizationOptions["definitionFormat"],
        }));
        this.refreshNumbers.addEventListener("click", () => actions.normalize({format: "keep", renumber: false,
            definitionFormat: this.snapshot.definitionFormat}));
        this.list.addEventListener("click", (event) => {
            const key = (event.target as HTMLElement).closest<HTMLElement>("[data-note-key]")?.dataset.noteKey;
            if (!key) return;
            this.selected = key;
            this.selectedKeys.set(this.rootId, key);
            this.renderSelection();
            this.highlightSelection();
        });
        this.references.addEventListener("click", (event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
            if (id) actions.navigate(id);
        });
    }

    get protyle() {return this.editor?.protyle;}

    async flushPendingEdits() {
        const editor = this.editor as Protyle & {flushPendingTransactions?: () => Promise<void>};
        await Promise.all(Array.from(this.savingEditors));
        await editor?.flushPendingTransactions?.();
    }

    setBusy(busy: boolean) {
        this.busy = busy;
        this.normalizeButton.disabled = busy || !this.snapshot || this.actions.readonly();
        this.refreshNumbers.disabled = this.normalizeButton.disabled;
    }

    message(text: string) {this.status.textContent = text;}

    clear(text = "请先打开文档") {
        this.snapshot = undefined;
        this.rootId = undefined;
        this.destroyEditor();
        this.list.replaceChildren();
        this.references.replaceChildren();
        this.context.textContent = "";
        this.message(text);
        this.setBusy(this.busy);
    }

    selectNew(blockId: string) {this.selected = blockId; this.focusNew = true;}

    render(snapshot: DocumentSnapshot, title: string) {
        if (this.rootId !== snapshot.rootId) {
            this.destroyEditor();
            this.rootId = snapshot.rootId;
            if (!this.focusNew) this.selected = this.selectedKeys.get(snapshot.rootId);
        }
        this.snapshot = snapshot;
        this.context.textContent = title || "当前文档";
        const count = snapshot.notes.filter((note) => note.blockId).length;
        this.message(`${count} 个脚注 · ${snapshot.references.length} 处引用`
            + (snapshot.pending ? " · 有待保存的块" : "")
            + (snapshot.staleReferenceCount ? ` · 序号已变化，请刷新序号（${snapshot.staleReferenceCount} 处）` : ""));
        this.refreshNumbers.hidden = !snapshot.staleReferenceCount;
        this.setBusy(this.busy);
        if (!snapshot.notes.some((note) => note.key === this.selected)) this.selected = snapshot.notes[0]?.key;
        this.selectedKeys.set(snapshot.rootId, this.selected);
        const fragment = document.createDocumentFragment();
        for (const note of snapshot.notes) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "siyuan-footnote-sidebar__note";
            button.dataset.noteKey = note.key;
            const label = document.createElement("strong");
            label.textContent = `[^${note.label}] · ${note.references.length} 处引用`;
            const content = document.createElement("span");
            content.textContent = note.content.slice(0, 100);
            button.append(label, content);
            if (note.missing || note.duplicate || !note.references.length) {
                const state = document.createElement("small");
                state.textContent = note.missing ? "缺失定义" : note.duplicate ? "编号重复" : "未引用";
                state.className = note.missing || note.duplicate ? "siyuan-footnote-sidebar__warning" : "";
                button.append(state);
            }
            fragment.append(button);
        }
        this.list.replaceChildren(fragment);
        this.highlightSelection();
        this.renderSelection();
    }

    private highlightSelection() {
        for (const button of Array.from(this.list.querySelectorAll<HTMLElement>("[data-note-key]"))) {
            button.setAttribute("aria-pressed", String(button.dataset.noteKey === this.selected));
        }
    }

    private renderSelection() {
        const note = this.snapshot?.notes.find((item) => item.key === this.selected);
        this.renderReferences(note);
        if (!note?.blockId || this.closed) {
            this.destroyEditor();
            this.editorHost.textContent = note?.missing ? "点击下方段落定位并修复脚注标记。" : "选择脚注以编辑原块。";
            return;
        }
        if (this.editorId === note.blockId && this.editor) {
            if (this.actions.readonly()) this.editor.disable();
            else this.editor.enable();
            return; // Keep the native editor and caret through index refreshes.
        }
        this.destroyEditor();
        this.editorHost.replaceChildren();
        const mount = document.createElement("div");
        mount.setAttribute("data-footnote-sidebar", "true");
        this.editorHost.append(mount);
        this.editorMount = mount;
        this.editorId = note.blockId;
        const generation = this.generation;
        this.editor = new Protyle(this.app, mount, {
            blockId: note.blockId, rootId: this.rootId,
            action: ["cb-get-all"],
            render: {title: false, background: false, breadcrumb: false, gutter: true, scroll: false},
            click: {preventInsetEmptyBlock: true},
            after: (editor) => {
                if (generation !== this.generation) return;
                if (this.actions.readonly()) editor.disable();
                if (this.focusNew && !this.actions.readonly()) {
                    this.focusNew = false;
                    const block = editor.protyle.wysiwyg?.element.querySelector("[data-node-id]");
                    if (block) editor.focusBlock(block, false);
                }
                this.actions.ready();
            },
        });
    }

    private renderReferences(note?: IndexedFootnote) {
        const fragment = document.createDocumentFragment();
        const title = document.createElement("strong");
        title.textContent = "被引段落";
        fragment.append(title);
        const groups = new Map<string, {heading: string; excerpt: string; count: number}>();
        for (const ref of note?.references || []) {
            const group = groups.get(ref.blockId);
            if (group) group.count++;
            else groups.set(ref.blockId, {heading: ref.heading, excerpt: ref.excerpt, count: 1});
        }
        if (note?.blockId) {
            const locate = document.createElement("button");
            locate.type = "button";
            locate.className = "b3-button b3-button--outline";
            locate.dataset.blockId = note.blockId;
            locate.textContent = "定位脚注原块";
            fragment.append(locate);
        }
        for (const [id, group] of groups) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "siyuan-footnote-sidebar__reference";
            button.dataset.blockId = id;
            const heading = document.createElement("small");
            heading.textContent = `${group.heading || "正文"} · ${group.count} 次`;
            const excerpt = document.createElement("span");
            excerpt.textContent = group.excerpt;
            button.append(heading, excerpt);
            fragment.append(button);
        }
        if (!groups.size) {
            const empty = document.createElement("span");
            empty.textContent = "当前文档没有引用此脚注。";
            fragment.append(empty);
        }
        this.references.replaceChildren(fragment);
    }

    invalidateEditor() {this.destroyEditor(); this.snapshot = undefined;}
    suspend() {this.closed = true; this.destroyEditor();}
    resume() {this.closed = false; if (this.snapshot) this.renderSelection();}
    resize() {this.editor?.resize();}

    private destroyEditor() {
        this.generation++;
        const editor = this.editor as Protyle & {flushPendingTransactions?: () => Promise<void>};
        const mount = this.editorMount;
        this.editor = undefined;
        this.editorId = undefined;
        this.editorMount = undefined;
        if (!editor) return;
        const finish = () => {editor.destroy(); mount?.remove();};
        if (!editor.flushPendingTransactions) {finish(); return;}
        // Keep the old editor connected until pending input and queued kernel
        // transactions are saved, including on panel close or plugin unload.
        if (mount) {mount.style.display = "none"; document.body.append(mount);}
        let saving: Promise<void>;
        try {saving = editor.flushPendingTransactions();}
        catch (error) {showMessage("保存脚注失败，请检查思源同步状态", 5000, "error"); finish(); return;}
        const task = Promise.resolve(saving).then(finish, (error) => {
            finish();
            showMessage("保存脚注失败，请检查思源同步状态", 5000, "error");
            throw error;
        });
        this.savingEditors.add(task);
        void task.then(() => this.savingEditors.delete(task), () => this.savingEditors.delete(task));
    }

    destroy() {
        this.suspend();
        this.element.replaceChildren();
        this.snapshot = undefined;
        this.selectedKeys.clear();
    }
}
