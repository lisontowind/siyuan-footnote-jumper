const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {parseHTML} = require("linkedom");

// Exercise the actual TypeScript with a small SiYuan host double. No running
// kernel or writes to a user's notes are needed for these regression cases.
function loadSource(filename, imports, globals = {}) {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src", filename), "utf8"), {
        compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
    }).outputText;
    vm.runInNewContext(source, {
        exports,
        require: (name) => {
            if (name in imports) return imports[name];
            throw new Error(`Unexpected import: ${name}`);
        },
        console,
        ...globals,
    }, {filename});
    return exports;
}

const definitions = loadSource("definitions.ts", {});

class Element {
    constructor(text = "", blockId) {
        this.textContent = text;
        this.dataset = blockId ? {nodeId: blockId} : {};
        this.blocks = [];
        this.isConnected = true;
        this.classes = new Set();
        this.classList = {
            add: (...names) => names.forEach((name) => this.classes.add(name)),
            remove: (...names) => names.forEach((name) => this.classes.delete(name)),
            contains: (name) => this.classes.has(name),
        };
    }
    closest(selector) {
        if (selector === ".protyle-wysiwyg") return this.editor || (this.isEditor ? this : null);
        if (selector === "[data-node-id]") return this.dataset.nodeId ? this : null;
        if (selector === ".siyuan-footnote-ref") return this.dataset.footnoteId ? this : null;
        return null;
    }
    querySelectorAll() { return this.blocks; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    scrollIntoView() { this.scrolled = true; }
    setAttribute() {}
    removeAttribute() {}
    remove() { this.isConnected = false; }
    contains(target) {
        return target === this || [...(this.children || []), ...this.blocks].some((child) =>
            child === target || child.contains?.(target));
    }
    append(...children) { (this.children ||= []).push(...children); }
    replaceChild(fragment) { this.replacement = fragment; }
}

function host(query = async () => []) {
    const editors = [];
    const opens = [];
    const messages = [];
    const timers = [];
    const cancelledTimers = new Set();
    let calls = 0;
    let now = Date.now();
    class HostDate extends Date { static now() { return now; } }
    const api = {
        Plugin: class { constructor() { this.name = "test"; this.app = {}; } },
        getAllEditor: () => editors.map((protyle) => ({protyle})),
        getActiveEditor: () => editors.length ? {protyle: editors[editors.length - 1]} : undefined,
        getFrontend: () => "desktop",
        openTab: async (options) => { opens.push(options); },
        openMobileFileById: (_, id) => { opens.push({mobile: id}); },
        showMessage: (text) => { messages.push(text); },
        fetchSyncPost: async (_, {stmt}) => { calls++; return {code: 0, data: await query(stmt)}; },
    };
    const window = {setTimeout: (fn) => {timers.push(fn); return timers.length;},
        clearTimeout: (id) => {cancelledTimers.add(id);}};
    const document = {
        body: new Element(),
        querySelectorAll: () => editors.map((editor) => editor.wysiwyg.element),
        createElement: () => new Element(),
        createTextNode: (text) => ({textContent: text}),
        createDocumentFragment: () => new Element(),
        createTreeWalker: (root, _, filter) => {
            const nodes = (root.textNodes || []).filter((node) => filter.acceptNode(node) === 1);
            let index = 0;
            return {nextNode() {this.currentNode = nodes[index++]; return !!this.currentNode;}};
        },
    };
    const editing = loadSource("editing.ts", {siyuan: api, "./document": {}}, {document, window});
    const Plugin = loadSource("index.ts", {siyuan: api, "./definitions": definitions, "./inline": loadSource("inline.ts", {}), "./editing": editing,
        "./document": {DEFAULT_PREFERENCES: {format: "text", definitionFormat: "literal", blockLabel: "caret", renumber: true, superscript: true}}, "./manager": {FootnoteManager: class {}}, "./index.scss": {}}, {
        window, document, Date: HostDate, Node: Element, HTMLElement: Element, NodeFilter: {SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2},
    }).default;
    const plugin = new Plugin(); plugin.enabled = true;
    const addEditor = (rootID, blocks = []) => {
        const element = new Element();
        element.isEditor = true;
        element.blocks = blocks;
        blocks.forEach((block) => { block.editor = element; });
        const protyle = {block: {rootID}, wysiwyg: {element}};
        editors.push(protyle);
        plugin.registerEditor(protyle);
        return {element, protyle};
    };
    const ref = (editor, id) => {
        const reference = new Element();
        reference.editor = editor.element;
        reference.dataset.footnoteId = id;
        return reference;
    };
    return {plugin, document, addEditor, ref, opens, messages, timers, api, calls: () => calls,
        runTimer: (id) => { if (id && !cancelledTimers.has(id)) timers[id - 1](); },
        advanceTime: (ms) => { now += ms; }};
}

function realEditor(h, rootID, html = "") {
    const {document} = parseHTML('<html><body><div class="protyle-wysiwyg"></div></body></html>');
    h.document.createElement = document.createElement.bind(document);
    h.document.createTextNode = document.createTextNode.bind(document);
    const editor = h.addEditor(rootID);
    editor.element = editor.protyle.wysiwyg.element = document.querySelector(".protyle-wysiwyg");
    editor.element.innerHTML = html;
    h.plugin.registerEditor(editor.protyle);
    return editor;
}

test("parse literal definitions, including multiline and empty content", () => {
    assert.equal(definitions.parseDefinition("正文 [^1]"), undefined);
    assert.equal(definitions.parseDefinition("[^bad id]: x"), undefined);
    assert.equal(definitions.parseDefinition(" [^中文]: a\n b ").content, "a\n b");
    assert.equal(definitions.parseDefinition("[^1]:").content, "空脚注");
});

test("read all footnotes with explicit SQL pagination and document scope", async () => {
    const rows = Array.from({length: 600}, (_, i) => ({id: String(i).padStart(5, "0"), content: `[^${i}]: note ${i}`}));
    const statements = [];
    const result = await definitions.readDocumentDefinitions("doc'1", async (stmt) => {
        statements.push(stmt);
        assert.match(stmt, /root_id = 'doc''1'/);
        assert.match(stmt, /ORDER BY id LIMIT 256$/);
        const cursor = stmt.match(/AND id > '([^']*)'/)[1];
        return rows.filter((row) => row.id > cursor).slice(0, 256);
    });
    assert.equal(result.size, 600);
    assert.equal(result.get("599").blockId, "00599");
    assert.equal(statements.length, 3);
});

test("unloaded definition resolves and clicking loads its target block", async () => {
    const h = host(async () => [{id: "tail-block", content: "[^1]: 末尾内容"}]);
    const editor = h.addEditor("long-document", [new Element("正文 [^1]", "body")]);
    const ref = h.ref(editor, "1");
    await h.plugin.jumpToDefinition("1", ref);
    assert.equal(h.plugin.findDefinition("1", ref).content, "末尾内容");
    assert.equal(h.opens[0].doc.id, "tail-block");
    assert.equal(h.opens[0].doc.action[0], "cb-get-hl");
    assert.equal(h.messages.length, 0);
});

test("loaded definition scrolls locally and overrides older indexed content", async () => {
    const h = host(async () => [{id: "tail", content: "[^1]: old"}]);
    const tail = new Element("[^1]: edited", "tail");
    const editor = h.addEditor("document", [tail]);
    await h.plugin.jumpToDefinition("1", h.ref(editor, "1"));
    assert.equal(tail.scrolled, true);
    assert.equal(h.plugin.collectDefinitions(editor.element).get("1").content, "edited");
    assert.equal(h.opens.length, 0);
    tail.textContent = "ordinary paragraph";
    assert.equal(h.plugin.collectDefinitions(editor.element).has("1"), false);
});

test("same footnote numbers stay scoped to their own document", async () => {
    const h = host(async (stmt) => stmt.includes("root_id = 'A'")
        ? [{id: "A-tail", content: "[^1]: A note"}]
        : [{id: "B-tail", content: "[^1]: B note"}]);
    const a = h.addEditor("A");
    const b = h.addEditor("B");
    const c = h.addEditor("C");
    await Promise.all([h.plugin.ensureDocumentDefinitions("A"), h.plugin.ensureDocumentDefinitions("B")]);
    assert.equal(h.plugin.findDefinition("1", h.ref(a, "1")).content, "A note");
    assert.equal(h.plugin.findDefinition("1", h.ref(b, "1")).content, "B note");
    assert.equal(h.plugin.findDefinition("1", h.ref(c, "1")), undefined);
});

test("dynamic paging marks newly added blocks without discarding the document index", async () => {
    const h = host(async () => [{id: "tail", content: "[^1]: cached"}]);
    const editor = realEditor(h, "document");
    await h.plugin.ensureDocumentDefinitions("document");
    editor.element.innerHTML = '<div data-node-id="new-body" data-type="NodeParagraph"><div contenteditable="true">new [^1]</div></div>';
    const added = editor.element.firstElementChild;
    h.plugin.handleProtyleLoaded({detail: {protyle: editor.protyle}});
    assert.equal(h.plugin.dirtyBlocks.has(added), true);
    assert.equal(h.plugin.findDefinition("1", h.ref(editor, "1")).blockId, "tail");
    h.plugin.wrapReferences(added, h.plugin.collectDefinitions(editor.element));
    const wrapped = added.querySelector(".siyuan-footnote-ref");
    assert.equal(wrapped.dataset.footnoteId, "1");
    assert.equal(wrapped.dataset.preview, "cached");
    assert.equal(wrapped.className, "siyuan-footnote-ref");
    await h.plugin.ensureDocumentDefinitions("document");
    assert.equal(h.calls(), 1);
});

test("concurrent lookups share a query, edits invalidate, stale responses cannot restore old data", async () => {
    const pending = [];
    const h = host(() => new Promise((resolve) => pending.push(resolve)));
    h.addEditor("document");
    const first = h.plugin.ensureDocumentDefinitions("document");
    const same = h.plugin.ensureDocumentDefinitions("document");
    assert.equal(first, same);
    h.plugin.handleKernelMessage({detail: {cmd: "transactions"}});
    const fresh = h.plugin.ensureDocumentDefinitions("document");
    pending[1]([{id: "new", content: "[^1]: new"}]);
    await fresh;
    pending[0]([{id: "old", content: "[^1]: old"}]);
    await first;
    assert.equal(h.plugin.documentDefinitions.get("document").definitions.get("1").blockId, "new");
});

test("switched editors do not navigate or show missing messages after an asynchronous lookup", async () => {
    let finish;
    const h = host(() => new Promise((resolve) => {finish = resolve;}));
    const editor = h.addEditor("A");
    const jump = h.plugin.jumpToDefinition("1", h.ref(editor, "1"));
    editor.protyle.block.rootID = "B";
    finish([{id: "A-tail", content: "[^1]: old document"}]);
    await jump;
    assert.equal(h.opens.length, 0);
    assert.equal(h.messages.length, 0);
});

test("disabled or unloaded plugins do not navigate after an asynchronous lookup", async () => {
    for (const flag of ["enabled", "unloaded"]) {
        let finish;
        const h = host(() => new Promise((resolve) => {finish = resolve;}));
        const editor = h.addEditor("A");
        const jump = h.plugin.jumpToDefinition("1", h.ref(editor, "1"));
        h.plugin[flag] = flag === "unloaded";
        finish([{id: "A-tail", content: "[^1]: note"}]);
        await jump;
        assert.equal(h.opens.length, 0);
        assert.equal(h.messages.length, 0);
    }
});

test("native reference conversion also accepts definitions that are not loaded", async () => {
    const h = host(async () => [{id: "tail", content: "[^1]: note"}]);
    const editor = realEditor(h, "A", '<div data-node-id="body" data-type="NodeParagraph"><div contenteditable="true"><span class="siyuan-footnote-ref" data-siyuan-footnote-enhanced="true" data-footnote-id="1">[^1]</span></div></div>');
    await h.plugin.ensureDocumentDefinitions("A");
    const block = editor.element.firstElementChild;
    assert.equal(h.plugin.convertFootnoteMarkersToNativeRefs(block, h.plugin.collectDefinitions(editor.element)), 1);
    const reference = block.querySelector('[data-type="block-ref"]');
    assert.equal(reference.dataset.id, "tail");
    assert.equal(reference.textContent, "[^1]");
});

test("exact page boundaries and non-definition candidates do not lose footnotes", async () => {
    const rows = Array.from({length: 256}, (_, i) => ({
        id: String(i).padStart(5, "0"),
        content: i === 0 ? "正文里包含 [^1]: 并不是定义" : `[^${i}]: note ${i}`,
    }));
    let calls = 0;
    const result = await definitions.readDocumentDefinitions("document", async (stmt) => {
        calls++;
        const cursor = stmt.match(/AND id > '([^']*)'/)[1];
        return rows.filter((row) => row.id > cursor).slice(0, 256);
    });
    assert.equal(calls, 2);
    assert.equal(result.size, 255);
    assert.equal(result.get("255").content, "note 255");
});

test("hover loads the unloaded definition and updates the visible preview", async () => {
    let finish;
    const h = host(() => new Promise((resolve) => { finish = resolve; }));
    const editor = h.addEditor("long-document");
    const ref = h.ref(editor, "1");
    ref.dataset.preview = "未找到对应脚注定义";
    ref.classList.add("siyuan-footnote-ref--missing");
    h.plugin.positionTooltip = () => {};
    h.plugin.handlePointerOver({target: ref});
    const loading = h.plugin.ensureDocumentDefinitions("long-document");
    finish([{id: "tail", content: "[^1]: 文末预览内容"}]);
    await loading;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls(), 1);
    assert.equal(h.plugin.tooltipElement.textContent, "文末预览内容");
    assert.equal(ref.dataset.preview, "文末预览内容");
    assert.equal(ref.classList.contains("siyuan-footnote-ref--missing"), false);
    assert.equal(h.opens.length, 0);
});

test("an earlier hover response cannot overwrite the current preview", async () => {
    const pending = [];
    const h = host(() => new Promise((resolve) => pending.push(resolve)));
    const a = h.ref(h.addEditor("A"), "1");
    const b = h.ref(h.addEditor("B"), "1");
    a.dataset.preview = b.dataset.preview = "未找到对应脚注定义";
    h.plugin.positionTooltip = () => {};
    h.plugin.handlePointerOver({target: a});
    h.plugin.handlePointerOver({target: b});
    const aLoading = h.plugin.ensureDocumentDefinitions("A");
    const bLoading = h.plugin.ensureDocumentDefinitions("B");
    pending[1]([{id: "B-tail", content: "[^1]: B note"}]);
    await bLoading;
    pending[0]([{id: "A-tail", content: "[^1]: A note"}]);
    await aLoading;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.plugin.tooltipElement.textContent, "B note");
});

test("mobile frontends load and highlight an unloaded target block", async () => {
    for (const frontend of ["mobile", "browser-mobile"]) {
        const h = host(async () => [{id: "tail", content: "[^1]: note"}]);
        h.api.getFrontend = () => frontend;
        h.api.openMobileFileById = (_, id, actions) => {
            h.opens.push({mobile: id, actions});
        };
        await h.plugin.jumpToDefinition("1", h.ref(h.addEditor("document"), "1"));
        assert.equal(h.opens[0].mobile, "tail");
        assert.deepEqual(Array.from(h.opens[0].actions), ["cb-get-hl", "cb-get-context"]);
    }
});

test("early post-edit queries expire for the delayed refresh, including renames and deletion", async () => {
    let rows = [{id: "tail", content: "[^1]: old"}];
    const h = host(async () => rows);
    const editor = h.addEditor("document");
    const ref = h.ref(editor, "1");
    await h.plugin.ensureDocumentDefinitions("document");
    h.plugin.handleKernelMessage({detail: {cmd: "transactions"}});
    // SQL can still return the old definition immediately after an editor edit.
    await h.plugin.ensureDocumentDefinitions("document");
    assert.equal(h.plugin.findDefinition("1", ref).content, "old");
    rows = [{id: "tail", content: "[^2]: renamed"}];
    h.advanceTime(1001);
    await h.plugin.ensureDocumentDefinitions("document");
    assert.equal(h.plugin.findDefinition("1", ref), undefined);
    assert.equal(h.plugin.findDefinition("2", ref).content, "renamed");
    rows = [];
    h.plugin.handleKernelMessage({detail: {cmd: "syncFinish"}});
    h.advanceTime(1001);
    await h.plugin.ensureDocumentDefinitions("document");
    assert.equal(h.plugin.findDefinition("2", ref), undefined);
});

test("refresh pauses document queries and rendering during Chinese composition", () => {
    const h = host();
    const body = new Element("正文 [^1]", "body");
    h.addEditor("document", [body]);
    h.plugin.markBlockDirty(body);
    h.plugin.isComposing = true;
    h.plugin.refresh();
    assert.equal(h.calls(), 0);
    assert.equal(h.plugin.dirtyBlocks.has(body), true);
    assert.equal(body.replacement, undefined);
});

test("existing native block references and code do not get wrapped again", () => {
    const h = host();
    const editor = realEditor(h, "document");
    for (const type of ["block-ref", "code"]) {
        editor.element.innerHTML = `<div data-node-id="body" data-type="NodeParagraph"><div contenteditable="true"><span data-type="${type}">[^1]</span></div></div>`;
        const body = editor.element.firstElementChild;
        h.plugin.wrapReferences(body, new Map());
        assert.equal(body.querySelector(".siyuan-footnote-ref"), null);
        assert.equal(body.textContent, "[^1]");
    }
});

function tooltipHost() {
    const h = host();
    const ref = h.ref(h.addEditor("document"), "1");
    ref.dataset.preview = "很长的脚注\n".repeat(100);
    h.plugin.positionTooltip = () => {};
    h.plugin.resolveDefinition = async () => undefined;
    h.plugin.handlePointerOver({target: ref});
    return {...h, reference: ref, tooltip: h.plugin.tooltipElement};
}

test("preview stays open crossing the gap and closes only after leaving both surfaces", () => {
    const h = tooltipHost();
    const outside = new Element();
    h.plugin.handlePointerOut({target: h.reference, relatedTarget: outside});
    const crossingTimer = h.plugin.tooltipHideTimer;
    assert.ok(crossingTimer);
    assert.equal(h.plugin.activeTooltipRef, h.reference);
    h.plugin.handlePointerOver({target: h.tooltip});
    h.runTimer(crossingTimer);
    assert.equal(h.plugin.activeTooltipRef, h.reference);
    assert.equal(h.tooltip.classList.contains("siyuan-footnote-tooltip--visible"), true);
    h.plugin.handlePointerOut({target: h.tooltip, relatedTarget: outside});
    h.runTimer(h.plugin.tooltipHideTimer);
    assert.equal(h.plugin.activeTooltipRef, undefined);
    assert.equal(h.tooltip.classList.contains("siyuan-footnote-tooltip--visible"), false);
});

test("moving directly between the marker, preview, and preview children does not close it", () => {
    const h = tooltipHost();
    const child = new Element();
    h.tooltip.append(child);
    for (const [target, relatedTarget] of [
        [h.reference, h.tooltip], [h.tooltip, child], [child, h.tooltip], [h.tooltip, h.reference],
    ]) {
        h.plugin.handlePointerOut({target, relatedTarget});
        assert.equal(h.plugin.tooltipHideTimer, 0);
        assert.equal(h.plugin.activeTooltipRef, h.reference);
    }
});

test("scrollbar dragging keeps preview open outside until pointer release", () => {
    const h = tooltipHost();
    const outside = new Element();
    const editingBlock = new Element("正文", "editing");
    h.plugin.activeBlock = editingBlock;
    h.plugin.handlePointerDown({target: h.tooltip});
    assert.equal(h.plugin.activeBlock, editingBlock);
    h.plugin.handlePointerOut({target: h.tooltip, relatedTarget: outside});
    h.plugin.handleSelectionChange();
    assert.equal(h.plugin.tooltipHideTimer, 0);
    assert.equal(h.plugin.activeTooltipRef, h.reference);
    h.plugin.handlePointerUp({target: outside});
    assert.equal(h.plugin.tooltipInteracting, false);
    h.runTimer(h.plugin.tooltipHideTimer);
    assert.equal(h.plugin.activeTooltipRef, undefined);
});

test("scrolling and mouse movement inside preview do not reposition it or reset scroll", () => {
    const h = tooltipHost();
    h.tooltip.scrollTop = 180;
    h.plugin.positionTooltip = () => { throw new Error("Preview moved during interaction"); };
    h.plugin.handleViewportChange({target: h.tooltip});
    h.plugin.handlePointerMove({target: h.tooltip});
    h.plugin.handlePointerOver({target: h.reference});
    assert.equal(h.tooltip.scrollTop, 180);
});

test("switching footnotes resets preview scroll and cancels the previous hide timer", () => {
    const h = tooltipHost();
    const next = h.ref(h.addEditor("next-document"), "2");
    next.dataset.preview = "第二条脚注";
    h.tooltip.scrollTop = 180;
    h.plugin.handlePointerOut({target: h.reference, relatedTarget: null});
    const timer = h.plugin.tooltipHideTimer;
    h.plugin.handlePointerOver({target: next});
    h.runTimer(timer);
    assert.equal(h.plugin.activeTooltipRef, next);
    assert.equal(h.tooltip.scrollTop, 0);
    assert.equal(h.tooltip.textContent, "第二条脚注");
});

test("destroying the preview cancels delayed closing and releases drag state", () => {
    const h = tooltipHost();
    h.plugin.scheduleTooltipHide();
    const timer = h.plugin.tooltipHideTimer;
    h.plugin.tooltipInteracting = true;
    h.plugin.destroyTooltip();
    h.runTimer(timer);
    assert.equal(h.plugin.tooltipHideTimer, 0);
    assert.equal(h.plugin.tooltipInteracting, false);
    assert.equal(h.plugin.tooltipElement, undefined);
    assert.equal(h.tooltip.isConnected, false);
});

test("refreshing the originating block preserves preview and scroll across replaced markers", () => {
    const h = tooltipHost();
    const editor = h.reference.editor;
    const body = new Element("正文 [^1]", "body");
    body.editor = editor;
    editor.blocks.push(body);
    const closest = (element) => (selector) => selector === "[data-node-id]" ? body
        : selector === ".protyle-wysiwyg" ? editor
        : selector === ".siyuan-footnote-ref" ? element : null;
    h.reference.closest = closest(h.reference);
    body.blocks = [h.reference];
    h.plugin.documentDefinitions.set("document", {definitions: new Map(), expiresAt: Number.MAX_SAFE_INTEGER});
    const replacement = new Element();
    replacement.dataset = {footnoteId: "1", preview: h.tooltip.textContent};
    replacement.closest = closest(replacement);
    h.plugin.cleanupBlock = () => { body.blocks = []; };
    h.plugin.wrapReferences = () => { body.blocks = [replacement]; };
    h.plugin.markBlockDirty(body);
    h.tooltip.scrollTop = 180;
    h.plugin.refresh();
    assert.equal(h.plugin.activeTooltipRef, replacement);
    assert.equal(h.tooltip.scrollTop, 180);
    assert.equal(h.tooltip.classList.contains("siyuan-footnote-tooltip--visible"), true);
});

function returnHost() {
    const h = host(async () => [{id: "tail", content: "[^1]: note"}]);
    const body = new Element("正文 [^1] 和重复引用 [^1]", "body");
    const editor = h.addEditor("document", [body]);
    const refs = [h.ref(editor, "1"), h.ref(editor, "1")];
    for (const ref of refs) {
        ref.closest = (selector) => selector === "[data-node-id]" ? body
            : selector === ".protyle-wysiwyg" ? editor.element
            : selector === ".siyuan-footnote-ref" ? ref : null;
    }
    body.blocks = refs;
    return {...h, body, editor, refs};
}

test("return button goes back to the clicked occurrence of a repeated reference", async () => {
    const h = returnHost();
    await h.plugin.jumpToDefinition("1", h.refs[1]);
    assert.equal(h.plugin.returnButton.textContent, "↩ 返回正文 [^1]");
    assert.equal(h.plugin.returnOrigin.referenceIndex, 1);
    await h.plugin.returnToReference();
    assert.equal(h.refs[1].scrolled, true);
    assert.equal(h.refs[0].scrolled, undefined);
    assert.equal(h.opens.length, 1);
    assert.equal(h.plugin.returnButton, undefined);
});

test("returning reloads an unloaded original paragraph by block ID", async () => {
    const h = returnHost();
    await h.plugin.jumpToDefinition("1", h.refs[0]);
    h.body.isConnected = false;
    h.editor.element.blocks = [];
    await h.plugin.returnToReference();
    assert.equal(h.opens[0].doc.id, "tail");
    assert.equal(h.opens[1].doc.id, "body");
    assert.equal(h.opens[1].doc.action[0], "cb-get-hl");
    assert.equal(h.plugin.returnOrigin, undefined);
});

test("returning from another document cannot target its matching block or footnote number", async () => {
    const h = returnHost();
    await h.plugin.jumpToDefinition("1", h.refs[0]);
    const otherBody = new Element("正文 [^1]", "body");
    h.addEditor("other-document", [otherBody]);
    await h.plugin.returnToReference();
    assert.equal(otherBody.scrolled, undefined);
    assert.equal(h.refs[0].scrolled, undefined);
    assert.equal(h.opens[1].doc.id, "body");
});

test("mobile return also reloads the original block", async () => {
    const h = returnHost();
    h.api.getFrontend = () => "mobile";
    await h.plugin.jumpToDefinition("1", h.refs[0]);
    h.editor.element.blocks = [];
    await h.plugin.returnToReference();
    assert.equal(h.opens[0].mobile, "tail");
    assert.equal(h.opens[1].mobile, "body");
});

test("failed return keeps the origin and re-enables the button for retry", async () => {
    const h = returnHost();
    await h.plugin.jumpToDefinition("1", h.refs[0]);
    h.editor.element.blocks = [];
    h.api.openTab = async () => { throw new Error("Navigation failed"); };
    await h.plugin.returnToReference();
    assert.equal(h.plugin.returnOrigin.blockId, "body");
    assert.equal(h.plugin.returnButton.disabled, false);
    assert.equal(h.messages[0], "返回正文失败，请重试");
});

test("disabling plugin removes return UI and origin without modifying notes", async () => {
    const h = returnHost();
    await h.plugin.jumpToDefinition("1", h.refs[0]);
    const button = h.plugin.returnButton;
    h.plugin.saveSettings = () => {};
    h.plugin.setEnabled(false);
    assert.equal(h.plugin.returnOrigin, undefined);
    assert.equal(h.plugin.returnButton, undefined);
    assert.equal(button.isConnected, false);
    assert.equal(h.body.textContent, "正文 [^1] 和重复引用 [^1]");
});
