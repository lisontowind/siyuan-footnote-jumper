const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {parseHTML} = require("linkedom");

function compile(name, imports, globals = {}) {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src", name), "utf8"), {
        compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
    }).outputText;
    vm.runInNewContext(source, {exports, require: (id) => {
        if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
        return imports[id];
    }, console, Error, ...globals}, {filename: name});
    return exports;
}

const block = (id, html, type = "NodeParagraph", attrs = "") =>
    `<div data-node-id="${id}" data-type="${type}" ${attrs}><div contenteditable="true">${html}</div><div class="protyle-attr" contenteditable="false"></div></div>`;
const ref = (id, label, subtype = "s") => `<span data-type="block-ref" data-subtype="${subtype}" data-id="${id}">${label}</span>`;

function host() {
    const {document, window} = parseHTML("<html><body></body></html>");
    const globals = {document, HTMLElement: window.HTMLElement, Node: window.Node};
    const definitions = compile("definitions.ts", {});
    const model = compile("document.ts", {"./definitions": definitions, "./inline": compile("inline.ts", {})}, globals);
    const editors = [], nativeEditors = [], messages = [], confirmations = [], transactions = [], timers = new Map();
    let active, dom = "", timerId = 0, pendingRead, nextId = 0, readonly = false, selection;
    const bus = new Map();
    const hostWindow = {siyuan: {config: {readonly: false}}, Lute: {NewNodeID: () => `new-${++nextId}`},
        setTimeout: (cb, delay) => {const id = ++timerId; timers.set(id, {cb, delay}); return id;},
        clearTimeout: (id) => timers.delete(id), getSelection: () => selection};
    class Protyle {
        constructor(app, element, options) {
            this.options = options;
            this.destroyed = false;
            const note = document.createElement("div");
            note.className = "protyle-wysiwyg";
            note.innerHTML = block(options.blockId, "[^1]: native");
            element.append(note);
            this.protyle = {block: {rootID: options.rootId}, wysiwyg: {element: note}, getInstance: () => this};
            nativeEditors.push(this);
            editors.push(this);
        }
        destroy() {this.destroyed = true; this.protyle.wysiwyg.element.remove();}
        disable() {this.protyle.disabled = true;}
        enable() {this.protyle.disabled = false;}
        resize() {this.resized = true;}
        focusBlock() {this.focused = true;}
    }
    // Lute is a window global in the real host, not a require("siyuan") export.
    const api = {Protyle,
        getActiveEditor: () => active, getAllEditor: () => editors, getFrontend: () => "desktop",
        showMessage: (text) => messages.push(text), confirm: (title, text, cb) => confirmations.push({title, text, cb}),
        fetchSyncPost: async (url) => {
            if (url === "/api/query/sql") return {code: 0, data: [{id: "external", root_id: "other"}]};
            if (pendingRead) return pendingRead;
            return {code: 0, data: {dom}};
        }};
    const sidebarModule = compile("sidebar.ts", {siyuan: api, "./document": model}, {...globals, window: hostWindow});
    const editing = compile("editing.ts", {siyuan: api, "./document": model}, {...globals, window: hostWindow});
    const managerModule = compile("manager.ts", {siyuan: api, "./document": model, "./sidebar": sidebarModule, "./editing": editing}, {
        ...globals, window: hostWindow, CustomEvent: window.CustomEvent,
        MutationObserver: class {observe() {} disconnect() {}},
    });
    const plugin = {name: "test", app: {}, protyleSlash: [],
        addDock(options) {this.dock = options;},
        eventBus: {on: (name, cb) => {if (!bus.has(name)) bus.set(name, new Set()); bus.get(name).add(cb);},
            off: (name, cb) => bus.get(name)?.delete(cb)}};
    const addEditor = (rootId, html) => {
        const element = document.createElement("div");
        element.className = "protyle-wysiwyg";
        element.innerHTML = html;
        document.body.append(element);
        const editor = {protyle: {block: {rootID: rootId}, wysiwyg: {element}, disabled: false},
            transaction: (forward, undo) => transactions.push({forward, undo})};
        editor.protyle.getInstance = () => editor;
        editors.push(editor); active = editor;
        return editor;
    };
    const opens = [], changes = [];
    let jumpEnabled = true;
    const manager = new managerModule.FootnoteManager(plugin, {
        jumpEnabled: () => jumpEnabled,
        setJumpEnabled: (enabled) => {jumpEnabled = enabled; manager.updateJumpStyle(enabled);},
        navigate: async (id) => opens.push(id), tablePending: () => false, changed: (id) => changes.push(id)});
    return {document, model, manager, plugin, api, hostWindow, nativeEditors, messages, confirmations, editing,
        transactions, timers, addEditor, opens, changes, sidebarModule, editors,
        snapshot: (html, overlays = [], ignored) => model.buildDocumentSnapshot("doc", html, overlays, ignored),
        setDOM: (html) => {dom = html;}, setActive: (editor) => {active = editor;},
        deferRead: () => {let resolve; pendingRead = new Promise((r) => {resolve = r;}); return (html) => {
            pendingRead = undefined; resolve({code: 0, data: {dom: html}});};},
        setSelection: (value) => {selection = value;},
        emit: (name, detail) => {for (const cb of bus.get(name) || []) cb({detail});},
        mount: () => {const element = document.createElement("div"); document.body.append(element);
            element.getClientRects = () => [{width: 360}]; plugin.dock.init({element}); return element;},
    };
}

test("index preserves document order, mixed targets, headings, unloaded blocks and table cells", () => {
    const h = host();
    const html = block("heading", "章节 A", "NodeHeading", 'data-subtype="h2"')
        + block("z-body", `首先 [^B] ${ref("def-B", "old anchor")} 再 [^A]`)
        + `<div data-node-id="list" data-type="NodeList">${block("a-body", "后来 [^A]")}</div>`
        + block("table", "<table><tbody><tr><td>[^A]</td><td>[^B]</td></tr></tbody></table>", "NodeTable")
        + block("def-A", "[^A]: A") + block("def-B", "[^B]: B") + block("unused", "[^unused]: C");
    const snapshot = h.snapshot(html);
    assert.deepEqual(Array.from(snapshot.notes, n => n.label), ["B", "A", "unused"]);
    assert.equal(snapshot.notes[0].references.length, 3);
    assert.equal(snapshot.notes[1].references.length, 3);
    assert.equal(snapshot.references[0].blockId, "z-body");
    assert.equal(snapshot.references[0].heading, "章节 A");
    assert.equal(snapshot.notes[0].references[1].targetId, "def-B");
});

test("overlays keep full table rows, current rich text, and document position", () => {
    const h = host();
    const editor = h.addEditor("doc", block("z", "新的 [^1]") + block("table", "<table><tr><td>部分行</td></tr></table>", "NodeTable"));
    const s = h.snapshot(block("z", "旧正文") + block("a", "[^1]")
        + block("table", "<table><tr><td>[^1]</td></tr><tr><td>[^1]</td></tr></table>", "NodeTable")
        + block("d", "[^1]: <b>内容</b>"), [editor.protyle.wysiwyg.element]);
    assert.equal(s.references.length, 4);
    assert.equal(s.references[0].excerpt, "新的 [^1]");
    assert.equal(s.pending, false);
});

test("code, embeds, ordinary and cross-document refs are excluded; split inline markers are supported", () => {
    const h = host();
    const s = h.snapshot(block("body", `[^<b>A</b>] <code>[^A]</code> ${ref("ordinary", "[^A]")}`
        + ` ${ref("external", "[^A]")} ${ref("external", "ordinary anchor")}`)
        + block("ordinary", "ordinary") + block("d", "[^A]: note")
        + `<div data-type="NodeBlockQueryEmbed">${block("foreign", "[^X]: foreign")}${block("foreign-body", "[^X]")}</div>`
        + block("code", "[^X]", "NodeCodeBlock"), [], new Set(["external"]));
    assert.equal(s.references.length, 1);
    assert.equal(s.references[0].label, "A");
    assert.equal(s.notes.length, 1);
});

test("duplicate and missing definitions remain diagnosable and stop normalization", () => {
    const h = host();
    const s = h.snapshot(block("body", `[^1] [^missing] ${ref("gone", "[^broken]")}`)
        + block("a", "[^1]: A") + block("b", "[^1]: B"));
    assert.equal(s.notes.filter(n => n.duplicate).length, 2);
    assert.equal(s.notes.filter(n => n.missing).length, 2);
    assert.throws(() => h.model.prepareNormalization(s, {format: "block", renumber: true}), /重复编号或缺失/);
});

test("normalization swaps labels simultaneously and preserves rich text, IDs, properties and full undo", () => {
    const h = host();
    const html = block("body", `先 [^2] 后 [^1] 及 ${ref("d2", "[^stale]", "d")}`)
        + block("d1", '[^<b>1</b>]: <a href="https://example.test">链接</a>', "NodeParagraph", 'custom-color="red"')
        + block("d2", "[^2]: <b>加粗</b>") + block("unused", "[^50]: 保留");
    const s = h.snapshot(html);
    const tx = h.model.prepareNormalization(s, {format: "block", renumber: true});
    assert.deepEqual(Array.from(tx.mapping, m => [m.from, m.to]), [["2", "1"], ["1", "2"], ["50", "3"]]);
    assert.equal(tx.forward.length, 4);
    const next = new Map(tx.forward.map(op => [op.id, op.data]));
    assert.match(next.get("d1"), /custom-color="red"/);
    assert.match(next.get("d1"), /<b>2<\/b>/);
    assert.match(next.get("d1"), /href="https:\/\/example.test"/);
    assert.match(next.get("d2"), /\[\^1\]: <b>加粗<\/b>/);
    const result = h.snapshot(Array.from(next.values()).join(""));
    assert.deepEqual(Array.from(result.references, r => [r.label, r.targetId]), [["1", "d2"], ["2", "d1"], ["1", "d2"]]);
    for (const op of tx.undo) assert.equal(op.data, h.snapshot(html).blocks.find(b => b.dataset.nodeId === op.id).outerHTML);
});

test("multiple split markers in one formatted run normalize without offset corruption", () => {
    const h = host();
    const s = h.snapshot(block("body", '[^<b>A</b>] / [^<i>B</i>] / [^A]')
        + block("a", "[^A]: A") + block("b", "[^B]: B"));
    const tx = h.model.prepareNormalization(s, {format: "block", renumber: true});
    const result = h.snapshot(tx.forward.map(op => op.data).join(""));
    assert.deepEqual(Array.from(result.references, r => r.targetId), ["a", "b", "a"]);
    assert.equal(result.references[0].excerpt, "[1] / [2] / [1]");
});

test("text conversion and keep mode retain native target identity and ordinary refs", () => {
    const h = host();
    const html = block("body", `${ref("a", "old")} [^B] ${ref("other", "ordinary")}`)
        + block("a", "[^A]: A") + block("b", "[^B]: B");
    const text = h.model.prepareNormalization(h.snapshot(html), {format: "text", renumber: true});
    assert.match(text.forward[0].data, /\[\^1\] \[\^2\]/);
    assert.match(text.forward[0].data, /data-id="other"/);
    const keep = h.model.prepareNormalization(h.snapshot(html), {format: "keep", renumber: false});
    assert.match(keep.forward[0].data, /data-id="a"/);
    assert.match(keep.forward[0].data, /\[\^B\]/);
});

test("temporary native styling and text enhancements are stripped from forward and undo data", () => {
    const h = host();
    const s = h.snapshot(block("body", '<span class="siyuan-footnote-ref" data-siyuan-footnote-enhanced="true" data-footnote-id="A" data-preview="preview">[^A]</span>'
        + '<span class="existing siyuan-footnote-native-ref" data-type="block-ref" data-id="a">[^A]</span>')
        + block("a", "[^A]: note", "NodeParagraph", 'class="siyuan-footnote-definition" data-footnote-id="A"'));
    const tx = h.model.prepareNormalization(s, {format: "text", renumber: true});
    for (const op of [...tx.forward, ...tx.undo]) assert.doesNotMatch(op.data, /siyuan-footnote|data-footnote|data-preview/);
    assert.match(tx.undo[0].data, /class="existing"/);
    assert.match(tx.undo[0].data, /data-id="a"/);
});

test("insert chooses unused number including missing refs and atomically adds terminal heading and definition", () => {
    const h = host();
    const html = block("body", "正文 /脚注 末尾 [^1]") + block("d2", "[^2]: existing");
    const s = h.snapshot(html);
    let id = 0;
    const tx = h.model.prepareInsertion(s, "body", 3, 6, "/脚注", () => `new-${++id}`);
    assert.equal(tx.label, "3");
    assert.equal(tx.forward.length, 3);
    assert.equal(tx.forward[0].previousID, "d2");
    assert.equal(tx.forward[1].previousID, tx.forward[0].id);
    assert.equal(tx.forward[1].parentID, "doc");
    assert.match(tx.forward[2].data, /data-id="new-1"/);
    assert.match(tx.forward[1].data, /\[\^3\]: /);
    assert.deepEqual(Array.from(tx.undo, op => op.action), ["delete", "delete", "update"]);
    assert.equal(tx.undo[2].data, h.snapshot(html).blocks[0].outerHTML);
});

test("insertion reuses only a terminal top-level footnote section", () => {
    const h = host();
    const body = block("body", "/jz");
    const heading = block("heading", "脚注", "NodeHeading", 'data-subtype="h2"');
    const note = block("note", "[^1]: note");
    const tx = h.model.prepareInsertion(h.snapshot(body + heading + note), "body", 0, 3, "/jz", () => "new");
    assert.equal(tx.forward.length, 2);
    const anotherSection = block("end", "其他", "NodeHeading", 'data-subtype="h2"');
    let id = 0;
    const next = h.model.prepareInsertion(h.snapshot(body + heading + note + anotherSection), "body", 0, 3, "/jz", () => `new-${++id}`);
    assert.equal(next.forward.length, 3);
    assert.equal(next.forward[0].previousID, "end");
});

test("pending new blocks and changed insertion text stop all writes", () => {
    const h = host();
    const editor = h.addEditor("doc", block("new-block", "待保存"));
    const s = h.snapshot(block("body", "/jz"), [editor.protyle.wysiwyg.element]);
    assert.equal(s.pending, true);
    assert.throws(() => h.model.prepareNormalization(s, {format: "block", renumber: true}), /待保存/);
    assert.throws(() => h.model.prepareInsertion(s, "body", 0, 3, "/jz", () => "id"), /待保存/);
    assert.throws(() => h.model.prepareInsertion(h.snapshot(block("body", "changed")), "body", 0, 3, "/jz", () => "id"), /已改变/);
});

test("unsaved moves stop normalization rather than renumbering in an old order", () => {
    const h = host();
    const editor = h.addEditor("doc", block("second", "[^B]") + block("first", "[^A]"));
    const s = h.snapshot(block("first", "[^A]") + block("second", "[^B]")
        + block("a", "[^A]: A") + block("b", "[^B]: B"), [editor.protyle.wysiwyg.element]);
    assert.equal(s.pending, true);
    assert.throws(() => h.model.prepareNormalization(s, {format: "block", renumber: true}), /待保存/);
});

test("sidebar groups paragraphs, mounts original native block, retains editor and safely renders note content", () => {
    const h = host();
    h.manager.register();
    const element = h.mount();
    const sidebar = h.manager.sidebar;
    const s = h.snapshot(block("body", "[^A] and [^A]") + block("a", "[^A]: &lt;img src=x onerror=alert(1)&gt;"));
    sidebar.render(s, "文档");
    assert.equal(h.nativeEditors.length, 1);
    assert.equal(h.nativeEditors[0].options.blockId, "a");
    assert.equal(element.querySelectorAll('[data-block-id="body"]').length, 1);
    assert.match(element.querySelector('[data-block-id="body"]').textContent, /2 次/);
    assert.equal(element.querySelector("img"), null);
    sidebar.render(h.snapshot(block("body", "[^A]") + block("a", "[^A]: changed")), "文档");
    assert.equal(h.nativeEditors.length, 1);
    sidebar.suspend();
    assert.equal(h.nativeEditors[0].destroyed, true);
    sidebar.resume();
    assert.equal(h.nativeEditors.length, 2);
    sidebar.resize();
    assert.equal(h.nativeEditors[1].resized, true);
    h.manager.destroy();
    assert.equal(h.nativeEditors[1].destroyed, true);
    assert.equal(h.plugin.protyleSlash.length, 0);
    assert.equal(h.timers.size, 0);
});

test("sidebar jump style follows shared state and stays separate from normalization options", () => {
    const h = host(); h.manager.register();
    let panel = h.mount();
    let toggle = panel.querySelector('[data-jump-style]');
    const renumber = panel.querySelector('.siyuan-footnote-sidebar__check input');
    assert.equal(toggle.checked, true);
    const options = [];
    h.manager.normalize = (value) => options.push(value);
    panel.querySelector('select option[value="block"]').selected = true;
    toggle.checked = false;
    toggle.dispatchEvent(new h.document.defaultView.Event("change"));
    h.manager.sidebar.clear();
    assert.equal(toggle.checked, false);
    panel.querySelector('[data-action="normalize"]').dispatchEvent(new h.document.defaultView.Event("click"));
    assert.equal(options[0].renumber, renumber.checked);
    assert.equal(options[0].format, "block");
    h.manager.sidebar.destroy(); panel.remove();
    panel = h.mount(); toggle = panel.querySelector('[data-jump-style]');
    assert.equal(toggle.checked, false);
    h.manager.updateJumpStyle(true);
    assert.equal(toggle.checked, true);
    assert.equal(h.transactions.length, 0);
});

test("sidebar focus never changes managed document and read-only mounts disable editing", async () => {
    const h = host();
    const main = h.addEditor("doc", block("body", "[^A]"));
    h.setDOM(block("body", "[^A]") + block("a", "[^A]: note"));
    h.manager.register();
    h.mount();
    await h.manager.refresh();
    const native = h.nativeEditors[0];
    h.setActive(native);
    h.emit("switch-protyle", {protyle: native.protyle});
    assert.equal(h.manager.main, main);
    h.hostWindow.siyuan.config.readonly = true;
    h.manager.sidebar.render(h.snapshot(block("body", "[^A]") + block("a", "[^A]: note")), "文档");
    assert.equal(native.protyle.disabled, true);
    await h.manager.normalize({format: "block", renumber: true});
    assert.equal(h.transactions.length, 0);
    assert.match(h.messages.at(-1), /只读/);
});

test("closing native editing waits for pending input and preserves a connected editor until save finishes", async () => {
    const h = host();
    h.manager.register();
    h.mount();
    h.manager.sidebar.render(h.snapshot(block("body", "[^A]") + block("a", "[^A]: note")), "文档");
    const native = h.nativeEditors[0];
    let finish;
    native.flushPendingTransactions = () => new Promise(resolve => {finish = resolve;});
    h.manager.sidebar.suspend();
    assert.equal(native.destroyed, false);
    assert.equal(native.protyle.wysiwyg.element.isConnected, true);
    assert.equal(h.manager.sidebar.protyle, undefined);
    let saved = false;
    const waiting = h.manager.sidebar.flushPendingEdits().then(() => {saved = true;});
    await Promise.resolve();
    assert.equal(saved, false);
    finish();
    await waiting;
    assert.equal(native.destroyed, true);
    assert.equal(native.protyle.wysiwyg.element.isConnected, false);
});

test("normalization confirmation rejects body edits and switched documents; unchanged review commits once", async () => {
    const h = host();
    h.addEditor("doc", block("body", "[^A]"));
    h.setDOM(block("body", "[^A]") + block("a", "[^A]: note"));
    h.manager.register();
    await h.manager.normalize({format: "block", renumber: true});
    assert.equal(h.confirmations.length, 1);
    h.manager.main.protyle.wysiwyg.element.querySelector('[contenteditable="true"]').textContent = "changed [^A]";
    h.confirmations[0].cb();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 0);
    assert.match(h.messages.at(-1), /已改变/);
    await h.manager.normalize({format: "block", renumber: true});
    h.addEditor("other", block("other", "other"));
    h.confirmations.at(-1).cb();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 0);
    assert.match(h.messages.at(-1), /切换/);
    const clean = host();
    clean.addEditor("doc", block("body", "[^A]"));
    clean.setDOM(block("body", "[^A]") + block("a", "[^A]: note"));
    clean.manager.register();
    await clean.manager.normalize({format: "block", renumber: true});
    clean.confirmations[0].cb();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clean.transactions.length, 1);
    assert.equal(clean.transactions[0].undo.length, clean.transactions[0].forward.length);
});

test("confirmation tolerates a focus change between equivalent main and sidebar editing copies", async () => {
    const h = host();
    const html = block("body", "正文 [^A]") + block("a", "[^A]: 内容", "NodeParagraph", 'data-node-index="40" updated="20261017000000"');
    const editor = h.addEditor("doc", html); h.setDOM(html); h.manager.register(); h.mount();
    await h.manager.refresh();
    const side = h.manager.sidebar.protyle.wysiwyg.element;
    side.innerHTML = block("a", "[^A]: 内容", "NodeParagraph", 'updated="20261017000001" data-node-index="1"');
    let focused = side.querySelector('[contenteditable="true"]');
    Object.defineProperty(h.document, "activeElement", {configurable: true, get: () => focused});
    await h.manager.normalize({format: "block", renumber: true, definitionFormat: "list"});
    assert.equal(h.confirmations.length, 1);
    // Closing SiYuan's confirmation can restore focus to the main editor.
    focused = editor.protyle.wysiwyg.element.querySelector('[contenteditable="true"]');
    h.confirmations[0].cb(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1, h.messages.at(-1));
    assert.match(h.transactions[0].forward.at(-1).data, /\[1\]/);
});

test("content comparison ignores renderer metadata but detects rich text, targets, properties and hierarchy changes", () => {
    const h = host();
    const original = block("body", `<b>正文</b> ${ref("a", "[^A]")} <a href="https://example.test/one">链接</a>`,
        "NodeParagraph", 'updated="20261017000000" data-node-index="8" custom-color="red"') + block("a", "[^A]: 内容");
    const signature = h.model.documentContentSignature(original);
    const metadataOnly = original.replace('updated="20261017000000" data-node-index="8"', 'data-node-index="1" updated="20261017000001"')
        .replace('contenteditable="true"', 'spellcheck="false" contenteditable="true"');
    assert.equal(h.model.documentContentSignature(metadataOnly), signature);
    for (const changed of [
        original.replace("正文", "修改"), original.replace("<b>正文</b>", "<i>正文</i>"),
        original.replace('data-id="a"', 'data-id="different"'), original.replace('custom-color="red"', 'custom-color="blue"'),
        original.replace("example.test/one", "example.test/two"), original.replace("[^A]: 内容", "[^B]: 内容"),
        block("a", "[^A]: 内容") + block("body", "正文 [^A]"),
    ]) assert.notEqual(h.model.documentContentSignature(changed), signature);
});

test("late save notifications are reread during confirmation without rejecting unchanged content", async () => {
    const h = host();
    const html = block("body", "[^A]") + block("a", "[^A]: 内容");
    h.addEditor("doc", html); h.setDOM(html); h.manager.register();
    await h.manager.normalize({format: "block", renumber: true, definitionFormat: "list"});
    const finish = h.deferRead();
    h.confirmations[0].cb();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    h.emit("ws-main", {cmd: "transactions", data: [{rootID: "doc", doOperations: [{action: "update", id: "body"}]}]});
    finish(html); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1, h.messages.at(-1));
});

test("async preparation and stale sidebar reads cannot act on a switched document", async () => {
    const h = host();
    h.addEditor("doc", block("body", "[^A]"));
    h.manager.register();
    h.mount();
    const finish = h.deferRead();
    const work = h.manager.normalize({format: "block", renumber: true});
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const other = h.addEditor("other", block("other", "different"));
    h.emit("switch-protyle", {protyle: other.protyle});
    finish(block("body", "[^A]") + block("a", "[^A]: note"));
    await work;
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.transactions.length, 0);
    assert.equal(h.manager.sidebar.protyle, undefined);
});

test("table pending, Chinese composition and async input block normalization", async () => {
    for (const condition of ["table", "composition", "input"]) {
        const h = host();
        h.addEditor("doc", block("body", "[^A]") + block("table", "<table></table>", "NodeTable"));
        h.setDOM(block("body", "[^A]") + block("a", "[^A]: note"));
        h.manager.register();
        if (condition === "table") {
            h.manager.host.tablePending = () => true;
            h.hostWindow.setTimeout = cb => setImmediate(cb);
        }
        if (condition === "composition") h.manager.handleCompositionStart();
        let finish;
        if (condition === "input") finish = h.deferRead();
        const work = h.manager.normalize({format: "block", renumber: true});
        if (finish) {
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            h.manager.revision++;
            finish(block("body", "[^A]") + block("a", "[^A]: note"));
        }
        await work;
        assert.equal(h.confirmations.length, 0, condition);
        assert.equal(h.transactions.length, 0, condition);
    }
});

test("normalization ends table selection and waits for native save before preparing full table changes", async () => {
    const h = host();
    const table = text => block("table", `<table><tbody><tr><td>${text} [^A]</td></tr><tr><td>未加载行 [^A]</td></tr></tbody></table>`, "NodeTable");
    const html = text => block("body", "正文 [^A]") + table(text) + block("a", "[^A]: note");
    const editor = h.addEditor("doc", html("新内容"));
    editor.protyle.wysiwyg.element.querySelectorAll('tr')[1].remove();
    h.setDOM(html("旧内容")); h.manager.register();
    h.manager.host.tablePending = () => true; // Active/display flags may remain set after save.
    let ended = false, finish;
    h.setSelection({anchorNode: editor.protyle.wysiwyg.element.querySelector('td').firstChild,
        removeAllRanges() {ended = true; this.anchorNode = null;}});
    editor.flushPendingTransactions = () => new Promise(resolve => {finish = () => {h.setDOM(html("新内容")); resolve();};});
    const preparing = h.manager.normalize({format: "block", renumber: true});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, true);
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.transactions.length, 0);
    finish(); await preparing;
    assert.equal(h.confirmations.length, 1, h.messages.at(-1));
    editor.flushPendingTransactions = async () => {};
    h.confirmations[0].cb(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1, h.messages.at(-1));
    const savedTable = h.transactions[0].forward.find(op => op.id === "table").data;
    assert.match(savedTable, /新内容/); assert.match(savedTable, /未加载行/);
    assert.doesNotMatch(savedTable, /旧内容/);
    assert.equal((savedTable.match(/data-type="block-ref"/g) || []).length, 2);
});

test("native save failures and document switches while saving stop normalization", async () => {
    for (const failure of ["save", "switch"]) {
        const h = host();
        const html = block("body", "[^A]") + block("a", "[^A]: note");
        const editor = h.addEditor("doc", html); h.setDOM(html); h.manager.register();
        editor.flushPendingTransactions = async () => {
            if (failure === "save") throw Error("native save rejected");
            editor.protyle.block.rootID = "other";
        };
        await h.manager.normalize({format: "block", renumber: true});
        assert.equal(h.confirmations.length, 0); assert.equal(h.transactions.length, 0);
        assert.match(h.messages.at(-1), failure === "save" ? /保存编辑内容失败/ : /文档已切换/);
    }
});

test("older hosts wait for matching rich table content instead of active flags", async () => {
    const h = host();
    const html = text => block("table", `<table><tbody><tr><td><b>${text}</b> [^A]</td></tr></tbody></table>`, "NodeTable");
    const editor = h.addEditor("doc", html("新")); h.setDOM(html("旧"));
    let waits = 0;
    h.hostWindow.setTimeout = cb => {waits++; h.setDOM(html("新")); return setImmediate(cb);};
    await h.editing.flushDocumentEdits([editor], () => {}, () => true);
    assert.equal(waits, 1); assert.equal(h.transactions.length, 0);
    const unchangedSelection = {anchorNode: h.document.createTextNode("outside"), removeAllRanges() {throw Error("paragraph selection cleared");}};
    h.setSelection(unchangedSelection);
    await h.editing.flushDocumentEdits([editor], () => {}, () => true);
    assert.equal(h.hostWindow.getSelection(), unchangedSelection);
});

test("older hosts reject unsaved rich formatting and partial table copies without submitting them", async () => {
    for (const mismatch of ["rich", "partial"]) {
        const h = host();
        const table = rows => block("table", `<table><tbody>${rows}</tbody></table>`, "NodeTable");
        const live = table('<tr><td><b>same text</b></td></tr>');
        const editor = h.addEditor("doc", live);
        const original = editor.protyle.wysiwyg.element.innerHTML;
        h.setDOM(mismatch === "rich" ? live.replace('<b>same text</b>', '<i>same text</i>')
            : table('<tr><td><b>same text</b></td></tr><tr><td>unloaded</td></tr>'));
        let waits = 0;
        h.hostWindow.setTimeout = cb => {waits++; return setImmediate(cb);};
        await assert.rejects(h.editing.flushDocumentEdits([editor], () => {}, () => true), /表格内容尚未保存完成/);
        assert.equal(waits, 10); assert.equal(h.transactions.length, 0);
        assert.equal(editor.protyle.wysiwyg.element.innerHTML, original);
    }
});

test("reusing one editor instance for another root cannot submit a reviewed normalization", async () => {
    const h = host();
    const editor = h.addEditor("doc", block("body", "[^A]"));
    h.setDOM(block("body", "[^A]") + block("a", "[^A]: note"));
    h.manager.register();
    await h.manager.normalize({format: "block", renumber: true});
    editor.protyle.block.rootID = "other-doc";
    h.confirmations[0].cb();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 0);
    assert.match(h.messages.at(-1), /切换/);
});

test("slash insertion uses global Lute without a module export and leaves no writes when the generator is missing", async () => {
    for (const available of [true, false]) {
        const h = host();
        const html = block("body", "正文 /脚注 末尾");
        const editor = h.addEditor("doc", html);
        h.setDOM(html);
        h.manager.register();
        assert.equal(h.api.Lute, undefined);
        if (!available) delete h.hostWindow.Lute;
        const source = editor.protyle.wysiwyg.element.firstElementChild;
        const text = source.querySelector('[contenteditable="true"]').firstChild;
        h.document.createRange = () => ({
            setStart(node, offset) {this.startContainer = node; this.startOffset = offset;},
            setEnd(node, offset) {this.endContainer = node; this.endOffset = offset;},
            setStartAfter(node) {this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1);},
            collapse() {this.endContainer = this.startContainer; this.endOffset = this.startOffset;},
        });
        editor.protyle.toolbar = {};
        editor.protyle.wysiwyg.lastHTMLs = {};
        const range = {startContainer: text, startOffset: 3, endContainer: text, endOffset: 6,
            cloneRange() {return {...this};},
            selectNodeContents() {this.startOffset = 0; this.endOffset = text.data.length;},
            setEnd(node, offset) {this.endContainer = node; this.endOffset = offset;},
            toString() {return text.data.slice(this.startOffset, this.endOffset);}};
        h.setSelection({rangeCount: 1, range, getRangeAt() {return this.range;},
            removeAllRanges() {this.rangeCount = 0;}, addRange(range) {this.range = range; this.rangeCount = 1;}});
        await h.manager.insert(editor, source);
        if (available) {
            assert.equal(h.transactions.length, 1);
            const {forward, undo} = h.transactions[0];
            assert.equal(forward.length, 3);
            assert.equal(undo.length, 3);
            assert.match(forward[2].data, /data-id="new-1"/);
            assert.match(forward[1].data, /\[\^1\]: /);
            assert.match(editor.protyle.wysiwyg.lastHTMLs.body, /\[1\]/);
        } else {
            assert.equal(h.transactions.length, 0);
            assert.match(h.messages.at(-1), /生成器尚未就绪/);
            assert.equal(source.outerHTML, h.snapshot(html).blocks[0].outerHTML);
        }
        assert.equal(h.manager.busy, false);
    }
});

test("local insertion displays the active marker and terminal section; rollback restores the original editor", () => {
    const h = host();
    const html = block("body", "正文 /jz 末尾");
    const editor = h.addEditor("doc", html);
    const root = editor.protyle.wysiwyg.element;
    const before = root.innerHTML;
    const original = root.firstElementChild;
    const tx = h.model.prepareInsertion(h.snapshot(html), "body", 3, 6, "/jz", (() => {
        let id = 0; return () => `new-${++id}`;
    })());
    const local = h.model.applyInsertionToEditor(root, tx, "body", tx.definitionId);
    assert.equal(local.reference.textContent, "[1]");
    assert.equal(root.children.length, 3);
    assert.equal(root.querySelectorAll('[data-id="new-1"]').length, 1);
    assert.doesNotMatch(root.textContent, /\/jz/);
    local.rollback();
    assert.equal(root.firstElementChild, original);
    assert.equal(root.children.length, 1);
    assert.equal(root.innerHTML, before);
});

test("invalid local insertion data is rejected before modifying the editing copy", () => {
    const h = host();
    const html = block("body", "/jz");
    const editor = h.addEditor("doc", html);
    const root = editor.protyle.wysiwyg.element;
    const before = root.innerHTML;
    let id = 0;
    const tx = h.model.prepareInsertion(h.snapshot(html), "body", 0, 3, "/jz", () => `new-${++id}`);
    tx.forward.find(operation => operation.id === tx.definitionId).data = block("wrong-id", "wrong definition");
    assert.throws(() => h.model.applyInsertionToEditor(root, tx, "body", tx.definitionId), /事务内容无效/);
    assert.equal(root.innerHTML, before);
});

const orderedList = (id, entries, start = 1) => `<div data-node-id="${id}" data-type="NodeList" data-subtype="o" class="list">`
    + entries.map(([blockId, content, saved], i) => `<div data-node-id="li-${blockId}" data-type="NodeListItem" data-subtype="o" data-marker="${start + i}." class="li"><div class="protyle-action">${start + i}.</div>`
        + block(blockId, content, "NodeParagraph", saved ? `custom-footnote-label="${saved}"` : "") + `</div>`).join("") + `</div>`;

function replay(h, html, operations) {
    const root = h.document.createElement("div"); root.innerHTML = html;
    const find = (id) => Array.from(root.querySelectorAll("[data-node-id]")).find(node => node.dataset.nodeId === id);
    for (const op of operations) {
        const current = find(op.id);
        if (op.action === "delete") current?.remove();
        else if (op.action === "update") {
            assert.ok(current, `update target ${op.id} exists`);
            const template = h.document.createElement("template"); template.innerHTML = op.data;
            current.replaceWith(template.content);
        } else {
            let node = current;
            if (op.action === "insert") {
                assert.equal(current, undefined, `insert target ${op.id} is unique`);
                const template = h.document.createElement("template"); template.innerHTML = op.data;
                node = template.content;
            }
            const previous = find(op.previousID), next = find(op.nextID);
            const parent = find(op.parentID) || root;
            if (previous) previous.after(node);
            else if (next) next.before(node);
            else if (op.action === "move") parent.insertBefore(node, parent.firstChild);
            else parent.append(node);
        }
    }
    return root.innerHTML;
}

test("only the final ordered list is indexed; explicit definitions take priority", () => {
    const h = host();
    const list = orderedList("tail", [["d1", "<b>第一条</b>"], ["d2", "第二条"]], 3);
    const s = h.snapshot(block("body", `[^3] ${ref("d2", "[^4]")}`) + list + block("blank", ""));
    assert.equal(s.definitionFormat, "list");
    assert.deepEqual(Array.from(s.notes, n => [n.label, n.blockId]), [["3", "d1"], ["4", "d2"]]);
    assert.equal(s.notes[0].content, "第一条");
    assert.equal(h.snapshot(list + block("after", "正文")).notes.length, 0);
    const explicit = h.snapshot(block("body", "[^1]") + block("literal", "[^1]: 显式定义") + list);
    assert.equal(explicit.definitionFormat, "literal");
    assert.deepEqual(Array.from(explicit.notes, n => n.blockId), ["literal"]);
    const separate = h.snapshot(orderedList("body-list", [["ordinary", "普通清单"]]) + list);
    assert.equal(separate.notes.length, 2);
});

test("literal definitions convert to a terminal list with rich content, stable targets and exact undo", () => {
    const h = host();
    const html = block("body", `[^B] [^A] ${ref("a", "[^A]")}`)
        + block("a", '[^A]: <b>加粗</b> <a href="https://example.test">链接</a>', "NodeParagraph", 'custom-color="red"')
        + block("middle", "保留正文") + block("b", "[^B]: 第二条") + block("unused", "[^unused]: 未引用");
    let id = 0;
    const tx = h.model.prepareNormalization(h.snapshot(html), {format: "block", renumber: true, definitionFormat: "list"}, () => `new-${++id}`);
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    const s = h.snapshot(next);
    assert.equal(s.topLevel.at(-1).dataset.type, "NodeList");
    assert.deepEqual(Array.from(s.notes, n => [n.label, n.blockId]), [["1", "b"], ["2", "a"], ["3", "unused"]]);
    assert.deepEqual(Array.from(s.references, r => r.targetId), ["b", "a", "a"]);
    assert.match(next, /custom-color="red"/); assert.match(next, /<b>加粗<\/b>/);
    assert.match(next, /href="https:\/\/example.test"/);
    assert.doesNotMatch(next, /\[\^[^\]]+\]:/);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
    const again = h.model.prepareNormalization(h.snapshot(next), {format: "block", renumber: true, definitionFormat: "list"}, () => {throw Error("should reuse existing IDs");});
    assert.equal(again.forward.length, 0);
    const reverse = h.model.prepareNormalization(h.snapshot(next), {format: "text", renumber: false, definitionFormat: "literal"});
    const literal = replay(h, next, reverse.forward);
    assert.equal(h.snapshot(literal).definitionFormat, "literal");
    assert.match(literal, /\[\^2\]: <b>加粗<\/b>/);
    assert.equal(replay(h, literal, reverse.undo), next);
});

test("reordered list labels warn and refresh text and native references without changing targets", () => {
    const h = host();
    const html = block("body", `[^1] ${ref("a", "[^1]")} [^2]`)
        + orderedList("tail", [["b", "B", "2"], ["a", "A", "1"]]);
    const s = h.snapshot(html);
    assert.equal(s.staleReferenceCount, 3);
    assert.equal(s.notes.find(n => n.blockId === "a").references.length, 2);
    const tx = h.model.prepareNormalization(s, {format: "keep", renumber: false, definitionFormat: "list"});
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    assert.equal(h.snapshot(next).staleReferenceCount, 0);
    assert.match(next, /\[\^2\].*data-id="a".*\[2\].*\[\^1\]/);
    assert.deepEqual(Array.from(h.snapshot(next).topLevel.at(-1).querySelectorAll('[data-type="NodeParagraph"]'), n => n.dataset.nodeId), ["b", "a"]);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
    h.manager.register(); const panel = h.mount();
    h.manager.sidebar.render(h.snapshot(html), "文档");
    assert.match(panel.querySelector('[role="status"]').textContent, /序号已变化，请刷新序号/);
    assert.equal(panel.querySelector('[data-action="refresh-numbers"]').hidden, false);
});

test("list-mode insertion appends a list item and local rollback restores both editor copies", () => {
    const h = host();
    const html = block("body", "/jz") + orderedList("tail", [["a", "A"]], 3);
    let id = 0;
    const tx = h.model.prepareInsertion(h.snapshot(html), "body", 0, 3, "/jz", () => `new-${++id}`);
    assert.equal(tx.label, "4");
    assert.deepEqual(Array.from(tx.forward, op => [op.action, op.id]), [["update", "tail"], ["update", "body"]]);
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    assert.equal(h.snapshot(next).notes.length, 2);
    assert.doesNotMatch(next, /\[\^4\]:/);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
    const editor = h.addEditor("doc", html), before = editor.protyle.wysiwyg.element.innerHTML;
    const local = h.model.applyInsertionToEditor(editor.protyle.wysiwyg.element, tx, "body", tx.definitionId);
    assert.equal(editor.protyle.wysiwyg.element.querySelectorAll('[data-type="NodeListItem"]').length, 2);
    local.rollback(); assert.equal(editor.protyle.wysiwyg.element.innerHTML, before);
});

test("normalization updates the loaded editor before submission and rolls back a rejected submission", async () => {
    for (const fail of [false, true]) {
        const h = host();
        const html = block("body", "正文 [^B] [^A]") + block("a", "[^A]: <b>A</b>") + block("b", "[^B]: B");
        const editor = h.addEditor("doc", html), root = editor.protyle.wysiwyg.element;
        editor.protyle.wysiwyg.lastHTMLs = {body: root.firstElementChild.outerHTML};
        const original = root.innerHTML, body = root.firstElementChild;
        h.setDOM(html); h.manager.register();
        const submit = editor.transaction;
        editor.transaction = (forward, undo) => {
            assert.equal(root.querySelectorAll('[data-type="NodeList"]').length, 1);
            assert.equal(root.querySelectorAll('[data-type="NodeListItem"]').length, 2);
            assert.doesNotMatch(root.textContent, /\[\^[AB]\]/);
            assert.equal(root.querySelector('[data-type="block-ref"]').dataset.id, "b");
            if (fail) throw Error("宿主事务提交失败");
            submit(forward, undo);
        };
        await h.manager.normalize({format: "block", renumber: true, definitionFormat: "list"});
        h.confirmations[0].cb(); await new Promise(resolve => setImmediate(resolve));
        if (fail) {
            assert.equal(root.innerHTML, original);
            assert.equal(root.firstElementChild, body);
            assert.equal(h.transactions.length, 0);
            assert.match(h.messages.at(-1), /操作失败|宿主事务提交失败/);
            assert.equal(editor.protyle.wysiwyg.lastHTMLs.body, body.outerHTML);
        } else {
            assert.equal(h.transactions.length, 1);
            assert.equal(root.innerHTML, replay(h, original, h.transactions[0].forward));
            assert.match(editor.protyle.wysiwyg.lastHTMLs.body, /\[1\]/);
        }
    }
});

test("normalization leaves unloaded insertion anchors alone and restores local deletes, updates and moves", () => {
    const h = host();
    const root = h.addEditor("doc", block("a", "A") + block("b", "B") + block("c", "C")).protyle.wysiwyg.element;
    const original = root.innerHTML;
    const local = h.model.applyNormalizationToEditor(root, {forward: [
        {action: "delete", id: "b"}, {action: "update", id: "c", data: block("c", "new C")},
        {action: "move", id: "a", previousID: "c", parentID: "doc"},
        {action: "insert", id: "new", data: block("new", "new"), previousID: "unloaded", parentID: "doc"},
    ]}, "doc");
    assert.deepEqual(Array.from(root.children, node => node.dataset.nodeId), ["c", "a"]);
    local.rollback(); assert.equal(root.innerHTML, original);
    assert.throws(() => h.model.applyNormalizationToEditor(root, {forward: [
        {action: "delete", id: "a"}, {action: "update", id: "c", data: block("wrong-id", "invalid")},
    ]}, "doc"), /事务内容无效/);
    assert.equal(root.innerHTML, original);
});

test("list conversion review reuses allocated IDs and rejects edits before committing", async () => {
    const h = host(); h.manager.register();
    const html = block("body", "[^A]") + block("a", "[^A]: A");
    h.addEditor("doc", html); h.setDOM(html);
    const options = {format: "block", renumber: true, definitionFormat: "list"};
    await h.manager.normalize(options); h.confirmations[0].cb();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1);
    const next = replay(h, h.snapshot(html).signature, h.transactions[0].forward);
    assert.equal(h.snapshot(next).notes[0].blockId, "a");
    h.setDOM(next);
    // The next review must have changes, then reject a concurrent edit.
    options.definitionFormat = "literal";
    await h.manager.normalize(options);
    h.manager.main.protyle.wysiwyg.element.firstElementChild.querySelector('[contenteditable]').textContent = "changed [^A]";
    h.confirmations.at(-1).cb(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1);
    assert.match(h.messages.at(-1), /已改变/);
});

test("nested and heading definitions retain content and document-root placement through list conversion", () => {
    const h = host();
    const content = block("heading-note", "[^H]: <i>标题脚注</i>", "NodeHeading", 'data-subtype="h3" class="h3"')
        + `<div data-node-id="quote" data-type="NodeBlockquote">${block("inside", "[^Q]: 引用内脚注")}${block("other", "保留引用内容")}</div>`
        + block("body", "[^Q] [^H]");
    const html = `<div data-node-id="doc" data-type="NodeDocument">${content}</div>`;
    let id = 0;
    const tx = h.model.prepareNormalization(h.snapshot(html), {format: "block", renumber: true, definitionFormat: "list"}, () => `new-${++id}`);
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    const s = h.snapshot(next);
    assert.equal(s.notes.length, 2);
    assert.equal(s.topLevel.at(-1).parentElement.dataset.nodeId, "doc");
    assert.equal(s.blocks.find(b => b.dataset.nodeId === "heading-note").dataset.type, "NodeParagraph");
    assert.match(next, /<i>标题脚注<\/i>/); assert.match(next, /保留引用内容/);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
});

test("imported list reorders retain text targets while the sidebar is open", async () => {
    const h = host(); h.manager.register(); h.mount();
    const first = block("body", "[^1] [^2]") + orderedList("tail", [["a", "A"], ["b", "B"]]);
    const editor = h.addEditor("doc", first); h.setDOM(first); await h.manager.refresh();
    const reordered = block("body", "[^1] [^2]") + orderedList("tail", [["b", "B"], ["a", "A"]]);
    editor.protyle.wysiwyg.element.innerHTML = reordered; h.setDOM(reordered);
    // The real native editor reflects kernel transactions; remove the host
    // double's unrelated hard-coded definition overlay for this model check.
    h.manager.sidebar.invalidateEditor();
    const s = await h.manager.read(editor);
    assert.equal(s.staleReferenceCount, 2);
    assert.equal(s.notes.find(n => n.blockId === "a").references[0].label, "1");
});

test("literal renames ignore saved list labels, including old normalized documents", () => {
    const h = host();
    const html = block("body", "[^A] [^B]")
        + block("a", "[^A]: A", "NodeParagraph", 'custom-footnote-label="1"')
        + block("b", "[^B]: B", "NodeParagraph", 'custom-footnote-label="1"');
    const s = h.snapshot(html);
    assert.deepEqual(Array.from(s.notes, n => [n.blockId, n.references.length, n.missing, n.duplicate]),
        [["a", 1, false, false], ["b", 1, false, false]]);
    const tx = h.model.prepareNormalization(s, {format: "keep", renumber: false, definitionFormat: "literal"});
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    assert.doesNotMatch(next, /custom-footnote-label/);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
});

test("unsaved list metadata and parent changes block writes without truncating partial lists", () => {
    const h = host();
    const html = block("body", "/jz") + orderedList("tail", [["a", "A"], ["b", "B"]]);
    const editor = h.addEditor("doc", html);
    for (const changed of [
        html.replace('data-marker="1."', 'data-marker="5."'),
        html.replace('data-subtype="o" class="list"', 'data-subtype="u" class="list"'),
        block("body", "/jz") + block("a", "A") + orderedList("tail", [["b", "B"]]),
    ]) {
        editor.protyle.wysiwyg.element.innerHTML = changed;
        const snapshot = h.snapshot(html, [editor.protyle.wysiwyg.element]);
        assert.equal(snapshot.pending, true);
        assert.throws(() => h.model.prepareNormalization(snapshot, {format: "keep", renumber: false}), /待保存/);
        assert.throws(() => h.model.prepareInsertion(snapshot, "body", 0, 3, "/jz", () => "new"), /待保存/);
    }
    editor.protyle.wysiwyg.element.innerHTML = orderedList("tail", [["b", "B"]], 2);
    const partial = h.snapshot(html, [editor.protyle.wysiwyg.element]);
    assert.equal(partial.pending, false);
    assert.equal(partial.notes.length, 2);
    const isolated = h.document.createElement("div");
    isolated.setAttribute("data-footnote-sidebar", "true");
    isolated.innerHTML = block("a", "新的 A");
    const side = h.snapshot(html, [isolated]);
    assert.equal(side.pending, false);
    assert.equal(side.notes.find(n => n.blockId === "a").content, "新的 A");
});

test("definition layout preserves unrelated empty containers and removes only vacated ancestors", () => {
    const h = host();
    const empty = '<div data-node-id="empty" data-type="NodeList" data-subtype="u" class="list"><div class="protyle-attr"></div></div>';
    const html = block("body", "[^A]") + empty
        + '<div data-node-id="old-list" data-type="NodeList" data-subtype="u"><div data-node-id="old-item" data-type="NodeListItem">'
        + block("a", "[^A]: <b>A</b>") + '</div></div>';
    let id = 0;
    const tx = h.model.prepareNormalization(h.snapshot(html), {format: "block", renumber: true, definitionFormat: "list"}, () => `new-${++id}`);
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    assert.match(next, /data-node-id="empty"/);
    assert.doesNotMatch(next, /data-node-id="old-(list|item)"/);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
});

test("conversion and undo restore targets before writing native refs, including refs within definitions", () => {
    const h = host();
    const html = block("body", ref("a", "[^A]"))
        + `<div data-node-id="quote" data-type="NodeBlockquote">${block("a", "[^A]: A")}${block("b", `[^B]: B ${ref("a", "see A")}`)}</div>`;
    let id = 0;
    const tx = h.model.prepareNormalization(h.snapshot(html), {format: "block", renumber: true, definitionFormat: "list"}, () => `new-${++id}`);
    const after = replay(h, h.snapshot(html).signature, tx.forward);
    assert.doesNotMatch(after, /data-node-id="quote"/);
    assert.equal(tx.forward.at(-1).id, "b");
    assert.ok(tx.forward.findIndex(op => op.action === "insert") < tx.forward.findIndex(op => op.id === "body"));
    assert.ok(tx.undo.findIndex(op => op.action === "insert" && op.id === "quote") < tx.undo.findIndex(op => op.id === "body"));
    assert.equal(replay(h, after, tx.undo), h.snapshot(html).signature);
    const onlyDefinitions = h.snapshot(block("a", "[^A]: A") + block("b", "[^B]: B"));
    const only = h.model.prepareNormalization(onlyDefinitions, {format: "block", renumber: true, definitionFormat: "list"}, () => `new-${++id}`);
    assert.equal(only.undo.find(op => op.action === "insert").nextID, undefined);
});

test("empty native targets are recovered by unambiguous footnote labels without treating plain brackets as refs", () => {
    const h = host();
    const html = block("body", `${ref("", "[1]", "")} ${ref("", "[^2]", "")} [1] ${ref("unrelated", "[1]")}`)
        + orderedList("tail", [["a", "A"], ["b", "B"]]);
    const snapshot = h.snapshot(html);
    assert.equal(snapshot.references.length, 2);
    assert.equal(snapshot.notes.every(note => !note.missing), true);
    const tx = h.model.prepareNormalization(snapshot, {format: "block", renumber: false, definitionFormat: "list"});
    const fixed = h.snapshot(replay(h, h.snapshot(html).signature, tx.forward));
    assert.deepEqual(Array.from(fixed.references, ref => ref.targetId), ["a", "b"]);
});

test("structural undo discards stale sidebar content before reading restored literal definitions", async () => {
    const h = host(); h.manager.register(); h.mount();
    const listed = block("body", ref("a", "[1]")) + orderedList("tail", [["a", "A"]]);
    const editor = h.addEditor("doc", listed); h.setDOM(listed); await h.manager.refresh();
    const embedded = h.nativeEditors.at(-1);
    embedded.protyle.wysiwyg.element.innerHTML = block("a", "A");
    const restored = block("body", ref("a", "[^A]")) + block("a", "[^A]: A");
    editor.protyle.wysiwyg.element.innerHTML = restored; h.setDOM(restored);
    h.emit("ws-main", {cmd: "transactions", data: [{doOperations: [{action: "delete", id: "tail"}, {action: "insert", id: "a"}]}]});
    assert.equal(embedded.destroyed, true);
    const snapshot = await h.manager.read(editor);
    assert.equal(snapshot.definitionFormat, "literal");
    assert.equal(snapshot.notes[0].label, "A");
    assert.equal(snapshot.references.length, 1);
});

test("sidebar ignores other-root events but refreshes mixed, unscoped and sync transactions", () => {
    const h = host(); h.manager.register();
    const main = h.addEditor("doc", block("body", "[^1]") + block("d", "[^1]: A"));
    h.mount(); h.manager.captureMain(); h.timers.clear();
    const revision = h.manager.revision;
    h.emit("ws-main", {cmd: "transactions", data: {rootID: "other", doOperations: [{action: "update", id: "foreign"}]}});
    h.emit("loaded-protyle-dynamic", {protyle: {block: {rootID: "other"}}});
    assert.equal(h.timers.size, 0);
    assert.equal(h.manager.revision, revision);
    for (const data of [
        [{rootID: "other"}, {rootID: "doc"}],
        {rootID: "other", doOperations: [{rootID: "doc", action: "update", id: "body"}]},
        {doOperations: [{action: "update", id: "body"}]},
        undefined,
        {rootID: "other", doOperations: {}},
    ]) {
        h.timers.clear(); h.emit("ws-main", {cmd: "transactions", data});
        assert.equal(h.timers.size, 1);
    }
    h.timers.clear(); h.emit("ws-main", {cmd: "syncFinish", data: {rootID: "other"}});
    assert.equal(h.timers.size, 1);
    h.timers.clear(); h.emit("loaded-protyle-dynamic", {protyle: main.protyle});
    assert.equal(h.timers.size, 1);
});

test("background transactions do not cancel a normalization review for the managed document", async () => {
    const h = host(); h.manager.register();
    const html = block("body", "[^A]") + block("a", "[^A]: A");
    h.addEditor("doc", html); h.setDOM(html);
    const resolve = h.deferRead();
    const review = h.manager.normalize({format: "block", renumber: true});
    await new Promise(resolve => setImmediate(resolve));
    h.emit("ws-main", {cmd: "transactions", data: {rootID: "other", doOperations: [{action: "update", id: "foreign"}]}});
    resolve(html); await review;
    assert.equal(h.confirmations.length, 1);
    h.confirmations[0].cb(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1);
    assert.equal(h.messages.some(message => /已改变/.test(message)), false);
});

test("numeric native anchors identify footnote paragraphs and ordered-list items by target, not displayed number", () => {
    const h = host();
    const html = block("heading", "章节", "NodeHeading")
        + block("body", `${ref("li-b", "[99]")} ${ref("a", "[1]")} ${ref("li-b", "[2]", "d")} [^1]`)
        + block("table", `<table><tr><td>${ref("li-a", "[1]")}</td></tr></table>`, "NodeTable")
        + orderedList("tail", [["a", "A"], ["b", "B"]]);
    const s = h.snapshot(html);
    assert.equal(s.references.length, 5);
    assert.equal(s.staleReferenceCount, 1, "Only [99] has an outdated number; matching [1]/[2] anchors are current");
    assert.deepEqual(Array.from(s.notes, note => [note.blockId, note.references.length]), [["b", 2], ["a", 3]]);
    assert.equal(s.notes.some(note => note.missing), false);
    assert.deepEqual(Array.from(s.references.filter(r => r.kind === "block"), r => [r.targetId, r.definitionId]),
        [["li-b", "b"], ["a", "a"], ["li-b", "b"], ["li-a", "a"]]);
    h.manager.register(); const panel = h.mount();
    h.manager.sidebar.render(s, "文档");
    assert.match(panel.querySelector('[data-note-key="b"]').textContent, /2 处引用/);
    assert.match(panel.querySelector('[data-block-id="body"]').textContent, /章节 · 2 次/);
});

test("numeric native footnotes participate in text, block and keep normalization with reversible targets", () => {
    const h = host();
    const html = block("body", `${ref("li-b", "[2]", "d")} ${ref("a", "[1]")} ${ref("li-a", "[1]")}`)
        + orderedList("tail", [["a", "<b>A</b>"], ["b", "B"]]);
    for (const format of ["text", "block", "keep"]) for (const definitionFormat of ["list", "literal"]) {
        const tx = h.model.prepareNormalization(h.snapshot(html), {format, renumber: true, definitionFormat});
        const next = replay(h, h.snapshot(html).signature, tx.forward);
        const s = h.snapshot(next);
        assert.deepEqual(Array.from(s.notes, n => [n.blockId, n.references.length]), [["b", 1], ["a", 2]]);
        assert.equal(s.notes.some(n => n.missing), false);
        if (format === "text") assert.equal(s.references.every(r => r.kind === "text"), true);
        else {
            assert.deepEqual(Array.from(s.references, r => r.native.textContent), ["[1]", "[2]", "[2]"]);
            assert.deepEqual(Array.from(s.references, r => r.targetId), definitionFormat === "literal"
                ? ["b", "a", "a"] : ["li-b", "a", "li-a"]);
        }
        assert.match(next, /<b>A<\/b>/);
        assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
    }
});

test("numeric anchors to ordinary blocks, body lists or unknown targets do not become footnotes", () => {
    const h = host();
    const html = block("body", `${ref("li-ordinary", "[1]")} ${ref("ordinary", "[1]")} ${ref("external", "[1]")} ${ref("missing", "[1]")}`)
        + orderedList("body-list", [["ordinary", "普通清单"]])
        + block("after", "正文") + orderedList("tail", [["a", "A"]]);
    const s = h.snapshot(html);
    assert.equal(s.references.length, 0);
    assert.equal(s.notes.length, 1);
    assert.equal(s.notes[0].references.length, 0);
    const explicit = h.snapshot(block("body", `${ref("d", "[123]", "d")} ${ref("ordinary", "[1]")}`)
        + block("d", "[^1]: 定义") + block("ordinary", "普通段落"));
    assert.equal(explicit.references.length, 1);
    assert.equal(explicit.references[0].definitionId, "d");
});

test("static refs use plain brackets while text markers and literal definitions retain caret syntax", () => {
    const h = host();
    const html = block("body", `正文 [^12] ${ref("d", "[^12]")} 普通文字 [12]`)
        + block("d", "[^12]: <b>内容</b>");
    const options = {format: "block", renumber: false};
    const tx = h.model.prepareNormalization(h.snapshot(html), options);
    const native = replay(h, h.snapshot(html).signature, tx.forward);
    const s = h.snapshot(native);
    assert.equal(s.references.length, 2);
    assert.deepEqual(Array.from(s.references, r => [r.targetId, r.native.textContent, r.native.dataset.subtype]),
        [["d", "[12]", "s"], ["d", "[12]", "s"]]);
    assert.match(native, /\[\^12\]: <b>内容<\/b>/);
    assert.equal(s.staleReferenceCount, 0);
    assert.equal(h.model.prepareNormalization(h.snapshot(native), options).forward.length, 0);
    assert.equal(replay(h, native, tx.undo), h.snapshot(html).signature);
    const textTx = h.model.prepareNormalization(h.snapshot(native), {format: "text", renumber: false});
    const text = replay(h, native, textTx.forward);
    assert.equal(h.snapshot(text).references.length, 2);
    assert.match(text, /正文 \[\^12\] \[\^12\] 普通文字 \[12\]/);
    assert.equal(replay(h, text, textTx.undo), native);
});
