import {App, Protyle, showMessage} from "siyuan";
import {auditFootnoteFormat, DEFAULT_PREFERENCES, DocumentSnapshot, FootnotePreferences, IndexedFootnote, NormalizationOptions} from "./document";

interface SidebarActions {
    navigate(blockId: string): void;
    normalize(options: NormalizationOptions): void;
    refresh(): void;
    preferences?(): FootnotePreferences;
    setPreferences?(preferences: FootnotePreferences): void;
    liveRefresh?(): boolean;
    setLiveRefresh?(enabled: boolean): void;
    panelAutoRefresh?(): boolean;
    setPanelAutoRefresh?(enabled: boolean): void;
    checkDuplicates?(anchor: HTMLElement): void;
    ready(): void;
    readonly(): boolean;
    jumpEnabled(): boolean;
    setJumpEnabled(enabled: boolean): void;
}

/** Retain keyed rows and load adjacent batches as the viewport approaches either edge. */
export class IncrementalList<T> {
    private items: T[] = [];
    private limit: number;
    private start = 0;
    private revealed?: string;
    private pinned?: T;
    private rows = new Map<string, {element: HTMLElement; signature: string}>();
    private more: HTMLElement;
    private earlier: HTMLElement;
    private observer?: IntersectionObserver;
    private active = true;

    constructor(private element: HTMLElement, private scrollRoot: HTMLElement, private batch: number,
        private key: (item: T) => string, private signature: (item: T) => string,
        private create: (item: T) => HTMLElement, private label: string) {
        this.limit = batch;
        this.earlier = document.createElement("div");
        this.more = document.createElement("div");
        for (const [edge, sentinel] of [["start", this.earlier], ["end", this.more]] as const) {
            sentinel.className = "siyuan-footnote-sidebar__list-edge";
            sentinel.dataset.listEdge = edge; sentinel.dataset.listKind = label;
            sentinel.setAttribute("aria-hidden", "true");
        }
        if (typeof window.IntersectionObserver === "function") {
            this.observer = new window.IntersectionObserver((entries) => {
                if (!this.active) return;
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    if (entry.target === this.earlier && !this.earlier.hidden) this.loadEarlier();
                    if (entry.target === this.more && !this.more.hidden) this.loadMore();
                }
            }, {root: scrollRoot, rootMargin: "80px", threshold: 0});
            this.observer.observe(this.earlier); this.observer.observe(this.more);
        } else scrollRoot.addEventListener("scroll", this.onScroll, {passive: true});
    }

    private readonly onScroll = () => {
        if (!this.active) return;
        // Geometry is relative to the scrolling viewport, including reference lists nested below the editor.
        const viewport = this.scrollRoot.getBoundingClientRect();
        if (!this.earlier.hidden && this.earlier.getBoundingClientRect().bottom >= viewport.top - 80
            && this.earlier.getBoundingClientRect().top <= viewport.bottom + 80) this.loadEarlier();
        if (!this.more.hidden && this.more.getBoundingClientRect().top <= viewport.bottom + 80
            && this.more.getBoundingClientRect().bottom >= viewport.top - 80) this.loadMore();
    };

    setItems(items: T[], reset = false, pinned?: T) {
        this.items = items; this.pinned = pinned;
        if (reset || this.start >= items.length) {
            this.start = 0; this.limit = this.batch; this.revealed = undefined; this.element.scrollTop = 0;
        }
        if (this.revealed && pinned && this.key(pinned) === this.revealed) this.positionPage(this.revealed);
        else this.revealed = undefined;
        this.render();
    }

    private positionPage(key: string) {
        const index = this.items.findIndex((item) => this.key(item) === key);
        if (index >= 0 && (index < this.start || index >= this.limit)) {
            const page = Math.floor(index / this.batch) * this.batch;
            this.start = Math.max(0, page - this.batch);
            this.limit = Math.min(this.items.length, page + this.batch * 2);
        }
    }

    reveal(key: string) {
        this.revealed = key;
        this.positionPage(key);
        this.render();
        this.rows.get(key)?.element.scrollIntoView?.({block: "nearest", inline: "nearest", behavior: "instant"});
    }

    private readonly loadEarlier = () => {
        if (!this.active || this.start === 0) return;
        const anchor = this.earlier.nextElementSibling as HTMLElement;
        const top = anchor?.getBoundingClientRect?.().top;
        this.start = Math.max(0, this.start - this.batch); this.revealed = undefined;
        this.render();
        // Account for native scroll anchoring too: only compensate the remaining visual displacement.
        if (top !== undefined && anchor?.isConnected) this.scrollRoot.scrollTop += anchor.getBoundingClientRect().top - top;
    };

    private readonly loadMore = () => {
        if (!this.active || this.limit >= this.items.length) return;
        this.limit = Math.min(this.items.length, this.limit + this.batch);
        this.render();
    };

    private render() {
        const visible = this.items.slice(this.start, this.limit);
        if (this.pinned && !visible.some((item) => this.key(item) === this.key(this.pinned))) visible.push(this.pinned);
        if (this.more.parentNode !== this.element) this.element.append(this.more);
        if (this.earlier.parentNode !== this.element) this.element.prepend(this.earlier);
        const keep = new Set<string>();
        let cursor = this.earlier.nextSibling;
        for (const item of visible) {
            const key = this.key(item), signature = this.signature(item);
            let row = this.rows.get(key);
            if (!row || row.signature !== signature) {
                const element = this.create(item);
                if (row?.element.parentNode === this.element) {
                    if (cursor === row.element) cursor = element;
                    row.element.replaceWith(element);
                }
                row = {element, signature}; this.rows.set(key, row);
            }
            if (cursor === row.element) cursor = cursor.nextSibling;
            else this.element.insertBefore(row.element, cursor);
            keep.add(key);
        }
        while (cursor && cursor !== this.more) {const next = cursor.nextSibling; cursor.remove(); cursor = next;}
        for (const key of this.rows.keys()) if (!keep.has(key)) this.rows.delete(key);
        this.earlier.hidden = this.start === 0;
        this.more.hidden = this.limit >= this.items.length;
    }

    suspend() {this.active = false; this.observer?.disconnect();}
    resume() {this.active = true; this.observer?.observe(this.earlier); this.observer?.observe(this.more);}
    destroy() {
        this.suspend(); this.scrollRoot.removeEventListener("scroll", this.onScroll);
        this.rows.clear(); this.items = []; this.pinned = undefined; this.revealed = undefined;
    }
}

let sidebarPanelSequence = 0;

interface ReferenceGroup {id: string; heading: string; excerpt: string; count: number;}

export class FootnoteSidebar {
    private activePanel: "notes" | "settings" = "notes";
    private notesPanel: HTMLElement;
    private settingsPanel: HTMLElement;
    private notesReset = false;
    private list: HTMLElement;
    private noteRows: IncrementalList<IndexedFootnote>;
    private referenceRows: IncrementalList<ReferenceGroup>;
    private notesByKey = new Map<string, IndexedFootnote>();
    private notesByLabel = new Map<string, IndexedFootnote[]>();
    private locateInput: HTMLInputElement;
    private locateButton: HTMLButtonElement;
    private locateStatus: HTMLElement;
    private lastLocatedLabel?: string;
    private lastLocatedKey?: string;
    private referenceKey?: string;
    private referenceNote?: IndexedFootnote;
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
    private blockLabel: HTMLSelectElement;
    private superscript: HTMLInputElement;
    private refreshNumbers: HTMLButtonElement;
    private renumber: HTMLInputElement;
    private jumpStyle: HTMLInputElement;
    private liveRefresh: HTMLInputElement;
    private panelAutoRefresh: HTMLInputElement;
    private refreshButton: HTMLButtonElement;
    private generation = 0;
    private focusNew = false;
    private closed = false;
    private busy = false;
    private selectedKeys = new Map<string, string>();

    constructor(readonly element: HTMLElement, private app: App, private actions: SidebarActions) {
        element.setAttribute("data-footnote-sidebar", "true");
        element.classList.add("siyuan-footnote-sidebar");
        element.innerHTML = `<div class="block__icons siyuan-footnote-sidebar__toolbar">
            <div class="block__logo"><svg class="block__logoicon"><use href="#iconFootnoteJumper"></use></svg>脚注</div>
            <span class="fn__flex-1"></span>
            <label class="siyuan-footnote-sidebar__auto-refresh" title="仅面板打开时自动更新脚注列表；关闭自动刷新后可点击右侧按钮更新"><span>自动刷新</span><input type="checkbox" role="switch" aria-label="面板自动刷新" class="siyuan-footnote-sidebar__switch" data-panel-auto-refresh></label>
            <button type="button" class="block__icon siyuan-footnote-sidebar__toolbar-button siyuan-footnote-sidebar__refresh" data-action="refresh" aria-label="刷新脚注面板" title="刷新脚注面板"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
            <button type="button" class="block__icon siyuan-footnote-sidebar__toolbar-button" data-type="min" aria-label="关闭脚注侧栏" title="关闭脚注侧栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>
        </div>
        <div class="siyuan-footnote-sidebar__document">
            <span class="siyuan-footnote-sidebar__eyebrow">当前文档</span>
            <div class="siyuan-footnote-sidebar__context">尚未打开文档</div>
        </div>
        <div class="siyuan-footnote-sidebar__tabs" role="tablist" aria-label="脚注侧栏面板">
            <button type="button" role="tab" data-panel="notes" aria-selected="true">脚注<span class="siyuan-footnote-sidebar__tab-count" data-note-count aria-hidden="true" hidden>0</span></button>
            <button type="button" role="tab" data-panel="settings" aria-selected="false" tabindex="-1">设置</button>
        </div>
        <section class="siyuan-footnote-sidebar__panel" data-panel-content="notes" role="tabpanel">
        <div class="siyuan-footnote-sidebar__status" role="status"></div>
        <form class="siyuan-footnote-sidebar__quick-locate" role="search" aria-label="脚注编号快速定位">
            <div class="siyuan-footnote-sidebar__locate-controls">
                <svg class="siyuan-footnote-sidebar__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
                <input type="text" class="b3-text-field" data-locate-number aria-label="脚注编号" placeholder="按编号定位，如 12" autocomplete="off" spellcheck="false">
                <button type="submit" class="b3-button b3-button--outline" data-action="locate-number" title="定位脚注（Enter）">定位</button>
            </div>
            <div class="siyuan-footnote-sidebar__hint" data-locate-status role="status" aria-live="polite" hidden></div>
        </form>
        <div class="siyuan-footnote-sidebar__list" aria-label="脚注列表"></div>
        <div class="siyuan-footnote-sidebar__editor-title"><div class="siyuan-footnote-sidebar__editor-label"><strong>脚注原块</strong><span class="siyuan-footnote-sidebar__selected-number" data-selected-number hidden></span></div><span class="siyuan-footnote-sidebar__save-state">自动保存</span></div>
        <div class="siyuan-footnote-sidebar__editor"></div>
        <div class="siyuan-footnote-sidebar__references" aria-label="被引段落">
            <div class="siyuan-footnote-sidebar__references-heading"><strong>被引段落</strong><span class="siyuan-footnote-sidebar__reference-count">0</span></div>
            <button type="button" class="b3-button b3-button--outline siyuan-footnote-sidebar__locate" hidden>定位脚注原块</button>
            <div data-reference-rows></div><span class="siyuan-footnote-sidebar__reference-empty"></span>
        </div>
        </section>
        <section class="siyuan-footnote-sidebar__panel" data-panel-content="settings" role="tabpanel" hidden>
        <div class="siyuan-footnote-sidebar__panel-intro"><strong>脚注偏好</strong><p>设置后续插入的写法，也可整理当前文档。</p></div>
        <div class="siyuan-footnote-sidebar__mode siyuan-footnote-sidebar__settings-box">
            <label class="siyuan-footnote-sidebar__field" data-reference-format-field><span class="siyuan-footnote-sidebar__section-title">引用写法</span><select class="b3-select" aria-label="目标脚注写法">
                <option value="block">静态块引</option><option value="text">文本标记</option>
            </select></label>
            <div class="siyuan-footnote-sidebar__hint">用于后续插入；已有脚注通过「统一格式」转换。</div>
        </div>
        <div class="siyuan-footnote-sidebar__display">
            <label class="siyuan-footnote-sidebar__display-toggle"><span>脚注跳转样式</span><input type="checkbox" role="switch" class="siyuan-footnote-sidebar__switch" data-jump-style aria-describedby="footnote-jump-style-hint"></label>
            <label class="siyuan-footnote-sidebar__display-toggle"><span>编辑块实时刷新</span><input type="checkbox" role="switch" class="siyuan-footnote-sidebar__switch" data-live-refresh></label>
            <div id="footnote-jump-style-hint" class="siyuan-footnote-sidebar__hint">用于正文文本标记的匹配、跳转、预览和上标；关闭编辑块实时刷新后，离开编辑块时自动匹配。面板列表由右上角「自动刷新」单独控制。</div>
        </div>
        <div class="siyuan-footnote-sidebar__tools siyuan-footnote-sidebar__settings-box" role="group" aria-label="统一脚注格式">
            <div class="siyuan-footnote-sidebar__section-title">格式整理</div>
            <label class="siyuan-footnote-sidebar__field" data-definition-format-field><span>定义格式</span><select class="b3-select" aria-label="脚注定义格式" data-definition-format>
                <option value="list">文末有序列表</option><option value="literal">[^编号]: 内容</option>
            </select></label>
            <label class="siyuan-footnote-sidebar__field" data-block-label-field><span>块引编号</span><select class="b3-select" aria-label="静态块引编号样式" data-block-label>
                <option value="caret">[^编号]</option><option value="brackets">[编号]</option>
            </select></label>
            <div class="siyuan-footnote-sidebar__hint" data-text-format-hint hidden>文本标记固定使用 [^编号]: 内容，避免列表重排改变对应关系。</div>
            <div class="siyuan-footnote-sidebar__tool-actions">
            <label class="siyuan-footnote-sidebar__check"><input type="checkbox" data-renumber checked> 连续编号</label>
            <label class="siyuan-footnote-sidebar__check"><input type="checkbox" data-superscript checked> 引用使用上标</label>
            </div>
            <button type="button" class="b3-button" data-action="normalize">统一格式</button>
            <div class="siyuan-footnote-sidebar__hint siyuan-footnote-sidebar__normalize-hint">确认后应用于当前文档，支持撤销。</div>
            <button type="button" class="b3-button b3-button--outline" data-action="refresh-numbers" hidden>刷新序号</button>
        </div>
        <div class="siyuan-footnote-sidebar__audit" role="status" hidden></div>
        <div class="siyuan-footnote-sidebar__settings-box siyuan-footnote-sidebar__diagnostics"><div class="siyuan-footnote-sidebar__section-title">文档检查</div><div class="siyuan-footnote-sidebar__hint">查找重复编号，定位需要处理的脚注。</div><button type="button" class="b3-button b3-button--outline" data-action="check-duplicates">检查重复脚注编号</button></div>
        </section>`;
        this.context = element.querySelector(".siyuan-footnote-sidebar__context");
        this.notesPanel = element.querySelector('[data-panel-content="notes"]');
        this.settingsPanel = element.querySelector('[data-panel-content="settings"]');
        const panelId = `footnote-panel-${++sidebarPanelSequence}`;
        const jumpHint = element.querySelector<HTMLElement>("#footnote-jump-style-hint");
        jumpHint.id = `${panelId}-jump-hint`;
        element.querySelector("[data-jump-style]").setAttribute("aria-describedby", jumpHint.id);
        for (const name of ["notes", "settings"] as const) {
            const tab = element.querySelector<HTMLElement>(`[data-panel="${name}"]`);
            const panel = name === "notes" ? this.notesPanel : this.settingsPanel;
            tab.id = `${panelId}-${name}-tab`; panel.id = `${panelId}-${name}`;
            tab.setAttribute("aria-controls", panel.id); panel.setAttribute("aria-labelledby", tab.id);
            tab.addEventListener("click", () => this.showPanel(name));
            tab.addEventListener("keydown", (event) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? "notes" : event.key === "End" ? "settings" : name === "notes" ? "settings" : "notes";
                this.showPanel(next); element.querySelector<HTMLElement>(`[data-panel="${next}"]`).focus();
            });
        }
        this.list = element.querySelector(".siyuan-footnote-sidebar__list");
        this.status = element.querySelector(".siyuan-footnote-sidebar__status");
        this.editorHost = element.querySelector(".siyuan-footnote-sidebar__editor");
        this.references = element.querySelector(".siyuan-footnote-sidebar__references");
        this.locateInput = element.querySelector("[data-locate-number]");
        this.locateButton = element.querySelector('[data-action="locate-number"]');
        this.locateStatus = element.querySelector("[data-locate-status]");
        element.querySelector(".siyuan-footnote-sidebar__quick-locate").addEventListener("submit", (event) => {
            event.preventDefault(); this.locateNumber();
        });
        this.locateInput.addEventListener("input", () => this.clearLocateFeedback());
        this.locateInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault();
        });
        this.noteRows = new IncrementalList(this.list, this.list, 40, (note) => note.key,
            (note) => JSON.stringify([note.label, note.content.slice(0, 100), note.references.length, note.missing, note.duplicate]),
            (note) => this.createNoteRow(note), "脚注");
        this.referenceRows = new IncrementalList(this.references.querySelector("[data-reference-rows]"), this.notesPanel, 30,
            (group) => group.id, (group) => JSON.stringify([group.heading, group.excerpt, group.count]),
            (group) => this.createReferenceRow(group), "段落");
        this.normalizeButton = element.querySelector('[data-action="normalize"]');
        this.format = element.querySelector("select");
        this.definitionFormat = element.querySelector("[data-definition-format]");
        this.blockLabel = element.querySelector("[data-block-label]");
        this.superscript = element.querySelector("[data-superscript]");
        this.refreshNumbers = element.querySelector('[data-action="refresh-numbers"]');
        this.renumber = element.querySelector('[data-renumber]');
        this.jumpStyle = element.querySelector('[data-jump-style]');
        this.liveRefresh = element.querySelector('[data-live-refresh]');
        this.panelAutoRefresh = element.querySelector('[data-panel-auto-refresh]');
        this.refreshButton = element.querySelector('[data-action="refresh"]');
        this.setPanelAutoRefresh(actions.panelAutoRefresh?.() ?? true);
        this.panelAutoRefresh.addEventListener("change", () => actions.setPanelAutoRefresh?.(this.panelAutoRefresh.checked));
        this.setPreferences(actions.preferences?.() || DEFAULT_PREFERENCES);
        this.setLiveRefresh(actions.liveRefresh?.() ?? true);
        this.liveRefresh.addEventListener("change", () => {
            actions.setLiveRefresh?.(this.liveRefresh.checked);
            this.updateFormatOptions();
        });
        element.querySelector<HTMLElement>('[data-action="check-duplicates"]').addEventListener("click", (event) =>
            actions.checkDuplicates?.(event.currentTarget as HTMLElement));
        this.setJumpEnabled(actions.jumpEnabled());
        this.jumpStyle.addEventListener("change", () => actions.setJumpEnabled(this.jumpStyle.checked));
        element.querySelector('[data-action="refresh"]').addEventListener("click", () => actions.refresh());
        this.normalizeButton.addEventListener("click", () => actions.normalize({
            format: this.format.value as NormalizationOptions["format"], renumber: this.renumber.checked,
            definitionFormat: this.format.value === "text" ? "literal" : this.definitionFormat.value as NormalizationOptions["definitionFormat"],
            blockLabel: this.blockLabel.value as NormalizationOptions["blockLabel"], superscript: this.superscript.checked,
        }));
        for (const control of [this.format, this.definitionFormat, this.blockLabel, this.renumber, this.superscript]) {
            control.addEventListener("change", () => {
                actions.setPreferences?.(this.getPreferences());
                this.updateFormatOptions();
                this.renderAudit();
            });
        }
        this.refreshNumbers.addEventListener("click", () => actions.normalize({format: "keep", renumber: false,
            definitionFormat: this.snapshot.definitionFormat}));
        this.list.addEventListener("click", (event) => {
            const key = (event.target as HTMLElement).closest<HTMLElement>("[data-note-key]")?.dataset.noteKey;
            if (!key || !this.snapshot) return;
            this.selected = key;
            this.selectedKeys.set(this.rootId, key);
            this.noteRows.setItems(this.snapshot.notes, false, this.notesByKey.get(key));
            this.renderSelection();
            this.highlightSelection();
        });
        this.references.addEventListener("click", (event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
            if (id) actions.navigate(id);
        });
        this.clear();
    }

    showPanel(panel: "notes" | "settings") {
        if (panel === this.activePanel) return;
        this.activePanel = panel;
        this.notesPanel.hidden = panel !== "notes"; this.settingsPanel.hidden = panel !== "settings";
        for (const name of ["notes", "settings"]) {
            const tab = this.element.querySelector<HTMLElement>(`[data-panel="${name}"]`);
            tab.setAttribute("aria-selected", String(name === panel)); tab.tabIndex = name === panel ? 0 : -1;
        }
        if (panel === "settings") {this.noteRows.suspend(); this.referenceRows.suspend();}
        else if (!this.closed) {
            this.renderNotes(); this.noteRows.resume(); this.referenceRows.resume(); this.resize();
        }
    }

    get protyle() {return this.editor?.protyle;}

    private clearLocateFeedback() {
        this.lastLocatedLabel = undefined; this.lastLocatedKey = undefined;
        this.locateInput.removeAttribute("aria-invalid");
        this.locateStatus.textContent = ""; this.locateStatus.hidden = true;
    }

    private locateNumber() {
        if (!this.snapshot || this.busy || this.closed) return;
        const input = this.locateInput.value.trim();
        const label = input.match(/^\[\^?([^\]\s:]+)\]$/)?.[1] || input;
        const matches = this.notesByLabel.get(label) || [];
        if (!matches.length) {
            this.clearLocateFeedback(); this.locateInput.setAttribute("aria-invalid", "true");
            this.locateStatus.textContent = label ? `未找到编号 ${label} 的脚注。` : "请输入脚注编号。";
            this.locateStatus.hidden = false; return;
        }
        const previous = this.lastLocatedLabel === label && this.lastLocatedKey === this.selected
            ? matches.findIndex((note) => note.key === this.selected) : -1;
        const note = matches[(previous + 1) % matches.length];
        this.lastLocatedLabel = label; this.lastLocatedKey = note.key;
        this.locateInput.removeAttribute("aria-invalid");
        this.selected = note.key; this.focusNew = false; this.selectedKeys.set(this.rootId, note.key);
        this.noteRows.setItems(this.snapshot.notes, false, note);
        this.highlightSelection(); this.renderSelection();
        this.locateStatus.textContent = matches.length > 1
            ? `编号 [^${label}] 有 ${matches.length} 条脚注，已定位第 ${(previous + 1) % matches.length + 1} 条；再次定位可切换。`
            : `已定位脚注 [^${label}]${note.missing ? "（缺失定义）" : ""}。`;
        this.locateStatus.hidden = false;
        // Reveal only after the result hint and editor have established the final layout.
        this.noteRows.reveal(note.key);
    }

    setJumpEnabled(enabled: boolean) {this.jumpStyle.checked = enabled;}

    getPreferences(): FootnotePreferences {
        return {format: this.format.value as FootnotePreferences["format"],
            definitionFormat: this.definitionFormat.value as FootnotePreferences["definitionFormat"],
            blockLabel: this.blockLabel.value as FootnotePreferences["blockLabel"],
            renumber: this.renumber.checked, superscript: this.superscript.checked};
    }

    setPreferences(preferences: FootnotePreferences) {
        const select = (control: HTMLSelectElement, value: string) => {
            for (const option of Array.from(control.options)) option.selected = false;
            Array.from(control.options).find((option) => option.value === value).selected = true;
        };
        select(this.format, preferences.format); select(this.definitionFormat, preferences.definitionFormat);
        select(this.blockLabel, preferences.blockLabel);
        this.renumber.checked = preferences.renumber; this.superscript.checked = preferences.superscript;
        this.updateFormatOptions(); this.renderAudit();
    }

    setLiveRefresh(enabled: boolean) {this.liveRefresh.checked = enabled; this.updateFormatOptions();}
    setPanelAutoRefresh(enabled: boolean) {this.panelAutoRefresh.checked = enabled;}
    setRefreshing(refreshing: boolean) {
        this.refreshButton.disabled = refreshing;
        this.refreshButton.setAttribute("aria-busy", String(refreshing));
        this.refreshButton.title = refreshing ? "正在刷新脚注…" : "刷新脚注面板";
    }

    private renderAudit() {
        const audit = this.element.querySelector<HTMLElement>(".siyuan-footnote-sidebar__audit");
        if (!audit) return;
        const issues = this.snapshot ? auditFootnoteFormat(this.snapshot, this.getPreferences()) : [];
        audit.hidden = !issues.length;
        audit.textContent = issues.length ? `格式不符合偏好：${issues.join("、")}。请点击“统一格式”。` : "";
    }

    private updateFormatOptions() {
        const text = this.format.value === "text";
        this.element.querySelector<HTMLElement>(".siyuan-footnote-sidebar__display").hidden = !text;
        this.blockLabel.disabled = this.format.value === "text";
        this.element.querySelector<HTMLElement>('[data-block-label-field]').hidden = text;
        this.element.querySelector<HTMLElement>('[data-definition-format-field]').hidden = text;
        this.definitionFormat.disabled = text;
        this.definitionFormat.querySelector<HTMLOptionElement>('option[value="list"]').disabled = text;
        this.element.querySelector<HTMLElement>('[data-text-format-hint]').hidden = !text;
    }

    async flushPendingEdits() {
        const editor = this.editor as Protyle & {flushPendingTransactions?: () => Promise<void>};
        await Promise.all(Array.from(this.savingEditors));
        await editor?.flushPendingTransactions?.();
    }

    setBusy(busy: boolean) {
        this.busy = busy;
        this.normalizeButton.disabled = busy || !this.snapshot || this.actions.readonly();
        this.refreshNumbers.disabled = this.normalizeButton.disabled;
        this.locateInput.disabled = this.locateButton.disabled = busy || !this.snapshot;
    }

    message(text: string) {this.status.textContent = text;}

    clear(text = "请先打开文档") {
        this.snapshot = undefined;
        this.updateFormatOptions();
        this.renderAudit();
        this.rootId = undefined;
        this.destroyEditor();
        this.notesByKey.clear(); this.notesByLabel.clear();
        this.locateInput.value = ""; this.clearLocateFeedback();
        this.noteRows.setItems([], true);
        this.referenceKey = undefined; this.referenceNote = undefined;
        this.referenceRows.setItems([], true);
        this.renderReferences();
        this.context.textContent = "尚未打开文档";
        this.element.querySelector<HTMLElement>("[data-note-count]").hidden = true;
        this.element.querySelector<HTMLElement>("[data-selected-number]").hidden = true;
        this.context.removeAttribute("title");
        this.refreshNumbers.hidden = true;
        this.renderEmptyList("等待打开文档", "打开文档后，可在这里查看和编辑脚注。");
        this.editorHost.classList.add("siyuan-footnote-sidebar__editor--empty");
        this.editorHost.textContent = "选择脚注以编辑原块。";
        this.message(text);
        this.setBusy(this.busy);
    }

    selectNew(blockId: string, focus = true) {this.selected = blockId; this.focusNew = focus;}

    render(snapshot: DocumentSnapshot, title: string) {
        const documentChanged = this.rootId !== snapshot.rootId;
        if (documentChanged) {
            this.destroyEditor();
            this.rootId = snapshot.rootId;
            if (!this.focusNew) this.selected = this.selectedKeys.get(snapshot.rootId);
        }
        this.snapshot = snapshot;
        this.notesByKey.clear(); this.notesByLabel.clear();
        for (const note of snapshot.notes) {
            this.notesByKey.set(note.key, note);
            if (!this.notesByLabel.has(note.label)) this.notesByLabel.set(note.label, []);
            this.notesByLabel.get(note.label).push(note);
        }
        if (documentChanged) {this.locateInput.value = ""; this.clearLocateFeedback();}
        else if (this.lastLocatedKey && this.notesByKey.get(this.lastLocatedKey)?.label !== this.lastLocatedLabel) this.clearLocateFeedback();
        this.updateFormatOptions();
        this.renderAudit();
        this.context.textContent = title || "当前文档";
        this.context.title = this.context.textContent;
        const saveState = this.element.querySelector(".siyuan-footnote-sidebar__save-state");
        saveState.textContent = this.actions.readonly() ? "只读" : "自动保存";
        const count = snapshot.notes.filter((note) => note.blockId).length;
        const noteCount = this.element.querySelector<HTMLElement>("[data-note-count]");
        noteCount.textContent = String(count); noteCount.hidden = false;
        this.message(`${count} 个脚注 · ${snapshot.references.length} 处引用`
            + (snapshot.pending ? " · 有待保存的块" : "")
            + (snapshot.staleReferenceCount ? ` · 序号已变化，请刷新序号（${snapshot.staleReferenceCount} 处）` : ""));
        this.refreshNumbers.hidden = !snapshot.staleReferenceCount;
        this.setBusy(this.busy);
        if (!this.notesByKey.has(this.selected)) this.selected = snapshot.notes[0]?.key;
        this.selectedKeys.set(snapshot.rootId, this.selected);
        this.notesReset ||= documentChanged;
        if (this.activePanel === "notes") this.renderNotes();
    }

    private renderNotes() {
        const snapshot = this.snapshot;
        if (!snapshot) return;
        this.noteRows.setItems(snapshot.notes, this.notesReset, this.notesByKey.get(this.selected));
        this.notesReset = false;
        if (!snapshot.notes.length) this.renderEmptyList("还没有脚注", "在正文输入 /，选择「插入脚注」开始添加。");
        this.highlightSelection();
        this.renderSelection();
    }

    private createNoteRow(note: IndexedFootnote) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "siyuan-footnote-sidebar__note";
        button.dataset.noteKey = note.key;
        button.setAttribute("aria-pressed", String(note.key === this.selected));
        const label = document.createElement("strong");
        label.className = "siyuan-footnote-sidebar__number"; label.textContent = `[^${note.label}]`;
        const heading = document.createElement("span"); heading.className = "siyuan-footnote-sidebar__note-heading";
        const count = document.createElement("small"); count.textContent = `${note.references.length} 处引用`;
        heading.append(label, count);
        const content = document.createElement("span"); content.className = "siyuan-footnote-sidebar__excerpt";
        content.textContent = note.content.slice(0, 100) || (note.missing ? "未找到对应的脚注内容" : "暂无内容，点击开始编辑");
        button.append(heading, content);
        if (note.missing || note.duplicate || !note.references.length) {
            const state = document.createElement("small");
            state.textContent = note.missing ? "缺失定义" : note.duplicate ? "编号重复" : "未引用";
            state.className = "siyuan-footnote-sidebar__badge" + (note.missing || note.duplicate ? " siyuan-footnote-sidebar__warning" : "");
            button.append(state);
        }
        return button;
    }

    private renderEmptyList(title: string, description: string) {
        const empty = document.createElement("div");
        empty.className = "siyuan-footnote-sidebar__empty";
        const symbol = document.createElement("span");
        symbol.className = "siyuan-footnote-sidebar__empty-symbol";
        symbol.textContent = "[^ ]";
        symbol.setAttribute("aria-hidden", "true");
        const heading = document.createElement("strong");
        heading.textContent = title;
        const hint = document.createElement("span");
        hint.textContent = description;
        empty.append(symbol, heading, hint);
        this.list.replaceChildren(empty);
    }

    private highlightSelection() {
        for (const button of Array.from(this.list.querySelectorAll<HTMLElement>("[data-note-key]"))) {
            const pressed = String(button.dataset.noteKey === this.selected);
            if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
        }
    }

    private renderSelection() {
        if (this.activePanel !== "notes") return;
        const note = this.snapshot ? this.notesByKey.get(this.selected) : undefined;
        const selectedNumber = this.element.querySelector<HTMLElement>("[data-selected-number]");
        selectedNumber.hidden = !note;
        selectedNumber.textContent = note ? `[^${note.label}]` : "";
        this.renderReferences(note);
        this.editorHost.classList.toggle("siyuan-footnote-sidebar__editor--empty", !note?.blockId || this.closed);
        if (!note?.blockId || this.closed) {
            this.destroyEditor();
            this.editorHost.textContent = note?.missing ? "点击下方段落定位并修复脚注标记。" : "选择脚注以编辑原块。";
            return;
        }
        if (this.editorId === note.blockId && this.editor) {
            const readonly = this.actions.readonly();
            if (Boolean(this.editor.protyle.disabled) !== readonly) {
                if (readonly) this.editor.disable(); else this.editor.enable();
            }
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
                if (this.focusNew && this.activePanel === "notes" && !this.actions.readonly()) {
                    this.focusNew = false;
                    const block = editor.protyle.wysiwyg?.element.querySelector("[data-node-id]");
                    if (block) editor.focusBlock(block, false);
                }
                this.actions.ready();
            },
        });
    }

    private renderReferences(note?: IndexedFootnote) {
        if (this.referenceNote === note && this.referenceKey !== undefined) return;
        const key = `${this.rootId || ""}:${note?.key || ""}`, reset = key !== this.referenceKey;
        this.referenceKey = key; this.referenceNote = note;
        const groups = new Map<string, ReferenceGroup>();
        for (const ref of note?.references || []) {
            const group = groups.get(ref.blockId);
            if (group) group.count++;
            else groups.set(ref.blockId, {id: ref.blockId, heading: ref.heading, excerpt: ref.excerpt, count: 1});
        }
        const count = this.references.querySelector(".siyuan-footnote-sidebar__reference-count");
        if (count.textContent !== String(groups.size)) count.textContent = String(groups.size);
        const locate = this.references.querySelector<HTMLButtonElement>(".siyuan-footnote-sidebar__locate");
        locate.hidden = !note?.blockId;
        if (note?.blockId) {if (locate.dataset.blockId !== note.blockId) locate.dataset.blockId = note.blockId;}
        else locate.removeAttribute("data-block-id");
        this.referenceRows.setItems(Array.from(groups.values()), reset);
        const empty = this.references.querySelector<HTMLElement>(".siyuan-footnote-sidebar__reference-empty");
        empty.hidden = groups.size > 0;
        const message = note ? "当前文档没有引用此脚注。" : "选择脚注后，查看引用它的正文段落。";
        if (empty.textContent !== message) empty.textContent = message;
    }

    private createReferenceRow(group: ReferenceGroup) {
        const button = document.createElement("button"); button.type = "button";
        button.className = "siyuan-footnote-sidebar__reference"; button.dataset.blockId = group.id;
        button.title = "定位到正文段落";
        const heading = document.createElement("small"); heading.textContent = `${group.heading || "正文"} · ${group.count} 次`;
        const excerpt = document.createElement("span"); excerpt.textContent = group.excerpt;
        excerpt.className = "siyuan-footnote-sidebar__excerpt"; button.append(heading, excerpt);
        return button;
    }

    invalidateEditor() {this.destroyEditor(); this.snapshot = undefined;}
    suspend() {this.closed = true; this.noteRows.suspend(); this.referenceRows.suspend(); this.destroyEditor();}
    resume() {this.closed = false; if (this.activePanel === "notes") {this.renderNotes(); this.noteRows.resume(); this.referenceRows.resume();}}
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
        this.noteRows.destroy(); this.referenceRows.destroy(); this.notesByKey.clear(); this.notesByLabel.clear();
        this.referenceNote = undefined; this.referenceKey = undefined;
        this.element.replaceChildren();
        this.snapshot = undefined;
        this.selectedKeys.clear();
    }
}
