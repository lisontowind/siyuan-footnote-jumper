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
    const dialogs = [];
    const api = {Protyle,
        Dialog: class {
            constructor(options) {this.options = options; this.element = document.createElement("div");
                this.element.innerHTML = options.content; document.body.append(this.element); dialogs.push(this);}
            destroy() {this.element.remove(); this.options.destroyCallback?.();}
        },
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
    let jumpEnabled = true, liveRefresh = true, preferences = {...model.DEFAULT_PREFERENCES};
    const manager = new managerModule.FootnoteManager(plugin, {
        jumpEnabled: () => jumpEnabled,
        preferences: () => preferences,
        setPreferences: (value) => {preferences = {...value}; manager.updatePreferences();},
        liveRefresh: () => liveRefresh,
        setLiveRefresh: (value) => {liveRefresh = value; manager.updatePreferences();},
        setJumpEnabled: (enabled) => {jumpEnabled = enabled; manager.updateJumpStyle(enabled);},
        navigate: async (id) => opens.push(id), tablePending: () => false, changed: (id) => changes.push(id)});
    return {document, model, manager, plugin, api, hostWindow, nativeEditors, messages, confirmations, editing,
        transactions, timers, addEditor, opens, changes, sidebarModule, editors, dialogs,
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
    assert.equal(result.references[0].excerpt, "[^1] / [^2] / [^1]");
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

test("pending new blocks only stop normalization; changed insertion text still stops insertion", () => {
    const h = host();
    const editor = h.addEditor("doc", block("new-block", "待保存"));
    const s = h.snapshot(block("body", "/jz"), [editor.protyle.wysiwyg.element]);
    assert.equal(s.pending, true);
    assert.throws(() => h.model.prepareNormalization(s, {format: "block", renumber: true}), /待保存/);
    assert.equal(h.model.prepareInsertion(s, "body", 0, 3, "/jz", () => "id").referenceCount, 1);
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
    assert.match(h.transactions[0].forward.at(-1).data, /\[\^1\]/);
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
        // Choose creation in the dialog; opening it itself must never write.
        await h.manager.insert(editor, source);
        assert.equal(h.transactions.length, 0);
        confirmNewFootnote(h);
        for (let tick = 0; tick < 12; tick++) await Promise.resolve();
        if (available) {
            assert.equal(h.transactions.length, 1);
            const {forward, undo} = h.transactions[0];
            assert.equal(forward.length, 3);
            assert.equal(undo.length, 3);
            assert.match(forward[2].data, /data-id="new-1"/);
            assert.match(forward[1].data, /data-type="NodeList"/);
            assert.match(editor.protyle.wysiwyg.lastHTMLs.body, /\[\^1\]/);
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
    assert.equal(local.reference.textContent, "[^1]");
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

test("refreshing legacy mixed references migrates list definitions to fixed labels without changing targets", () => {
    const h = host();
    const html = block("body", `[^1] ${ref("a", "[^1]")} [^2]`)
        + orderedList("tail", [["b", "B", "2"], ["a", "A", "1"]]);
    const s = h.snapshot(html);
    assert.equal(s.staleReferenceCount, 3);
    assert.equal(s.notes.find(n => n.blockId === "a").references.length, 2);
    const tx = h.model.prepareNormalization(s, {format: "keep", renumber: false, definitionFormat: "list"});
    const next = replay(h, h.snapshot(html).signature, tx.forward);
    assert.equal(h.snapshot(next).staleReferenceCount, 0);
    assert.match(next, /\[\^2\].*data-id="a".*\[\^2\].*\[\^1\]/);
    assert.equal(h.snapshot(next).definitionFormat, "literal");
    assert.deepEqual(Array.from(h.snapshot(next).topLevel.slice(-2), n => n.dataset.nodeId), ["b", "a"]);
    assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
    h.manager.register(); const panel = h.mount();
    h.manager.sidebar.render(h.snapshot(html), "文档");
    assert.match(panel.querySelector('.siyuan-footnote-sidebar__status').textContent, /序号已变化，请刷新序号/);
    assert.equal(panel.querySelector('[data-action="refresh-numbers"]').hidden, false);
});

test("list-mode insertion appends a list item and local rollback restores both editor copies", () => {
    const h = host();
    const html = block("body", "/jz") + orderedList("tail", [["a", "A"]], 3);
    let id = 0;
    const tx = h.model.prepareInsertion(h.snapshot(html), "body", 0, 3, "/jz", () => `new-${++id}`);
    assert.equal(tx.label, "4");
    assert.deepEqual(Array.from(tx.forward, op => [op.action, op.id]), [["insert", "new-2"], ["update", "body"]]);
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
            assert.match(editor.protyle.wysiwyg.lastHTMLs.body, /\[\^1\]/);
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
        const insertion = h.model.prepareInsertion(snapshot, "body", 0, 3, "/jz", () => "new");
        assert.equal(insertion.forward.some(op => op.action === "update" && op.id === "tail"), false);
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
        assert.equal(s.definitionFormat, format === "text" ? "literal" : definitionFormat);
        if (format === "text") assert.equal(s.references.every(r => r.kind === "text"), true);
        else {
            assert.deepEqual(Array.from(s.references, r => r.native.textContent), ["[^1]", "[^2]", "[^2]"]);
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
    const options = {format: "block", renumber: false, blockLabel: "brackets"};
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

test("styled references support both static labels and native superscript across every format with exact undo", () => {
    const h = host();
    const html = block("body", '<span data-type="strong" style="color: red">前 [^<i>12</i>] 后</span> '
        + '<span data-type="block-ref em" data-id="d" data-subtype="d" style="background-color: yellow">[12]</span>')
        + block("table", '<table><tr><td><span data-type="u">[^12]</span></td><td>普通 [12]</td></tr></table>', "NodeTable")
        + block("d", "[^12]: <b>定义</b>");
    for (const format of ["block", "text", "keep"]) for (const blockLabel of ["caret", "brackets"])
        for (const definitionFormat of ["literal", "list"]) {
            const options = {format, blockLabel, definitionFormat, renumber: true, superscript: true};
            let id = 0;
            const tx = h.model.prepareNormalization(h.snapshot(html), options, () => `new-${++id}`);
            const next = replay(h, h.snapshot(html).signature, tx.forward);
            const snapshot = h.snapshot(next);
            assert.equal(snapshot.definitionFormat, format === "block" ? definitionFormat : "literal");
            assert.equal(snapshot.references.length, 3);
            assert.equal(snapshot.notes.some(n => n.missing), false);
            for (const r of snapshot.references) {
                const element = r.native || r.run.find(n => n.data.includes("[^1]")).parentElement;
                assert.equal(element.matches('[data-type~="sup"]'), true);
                if (r.kind === "block") {
                    assert.equal(element.textContent, blockLabel === "caret" ? "[^1]" : "[1]");
                    assert.equal(element.dataset.id, "d");
                    assert.equal(element.parentElement.matches('td, th, [contenteditable="true"]'), true);
                } else assert.equal(element.hasAttribute("data-id"), false);
            }
            const body = snapshot.blocks.find(b => b.dataset.nodeId === "body");
            const first = body.querySelector('[data-type~="sup"]');
            assert.equal(first.matches('[data-type~="strong"][data-type~="em"]'), true);
            assert.equal(first.style.color, "red");
            assert.equal(body.firstElementChild.firstElementChild.textContent, "前 ");
            assert.match(next, /普通 \[12\]/);
            assert.match(next, /<b>定义<\/b>/);
            const again = h.model.prepareNormalization(h.snapshot(next), options, () => {throw Error("must reuse IDs");});
            assert.equal(again.forward.length, 0, JSON.stringify({options, next, again}));
            assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
        }
});

test("native superscript and inline styles survive block-text-block conversions without duplicating size", () => {
    const h = host();
    const html = block("body", '<span data-type="block-ref sup strong text" data-id="d" data-subtype="s" style="color: red">[^10]</span>')
        + block("d", "[^10]: 内容");
    const textTx = h.model.prepareNormalization(h.snapshot(html), {format: "text", renumber: false});
    const text = replay(h, h.snapshot(html).signature, textTx.forward);
    assert.doesNotMatch(text, /block-ref|data-id=/);
    assert.match(text, /data-type="sup strong text"/);
    const tx = h.model.prepareNormalization(h.snapshot(text), {format: "block", renumber: false, superscript: true, blockLabel: "brackets"});
    const next = replay(h, text, tx.forward);
    const r = h.snapshot(next).references[0];
    assert.equal(r.targetId, "d");
    assert.equal(r.native.matches('[data-type~="sup"][data-type~="strong"]'), true);
    assert.equal(r.native.querySelector("span"), null);
    assert.equal(r.native.style.color, "red");
    assert.equal(r.native.textContent, "[10]");
});

test("sidebar offers block and text formats with dependent fields and independent superscript controls", () => {
    const h = host(); h.manager.register();
    const panel = h.mount(), values = [];
    h.manager.normalize = options => values.push(options);
    assert.equal(panel.querySelector('[data-block-label]').querySelector('option').value, "caret");
    assert.equal(panel.querySelector('[data-superscript]').hasAttribute("checked"), true);
    panel.querySelector('[data-block-label] option[value="brackets"]').selected = true;
    panel.querySelector('[data-superscript]').checked = true;
    panel.querySelector('[data-renumber]').checked = false;
    assert.equal(panel.querySelector('select option[value="keep"]'), null);
    panel.querySelector('[data-definition-format] option[value="list"]').selected = true;
    for (const format of ["block", "text", "block"]) {
        panel.querySelector(`select option[value="${format}"]`).selected = true;
        panel.querySelector('select').dispatchEvent(new h.document.defaultView.Event("change"));
        assert.equal(panel.querySelector('[data-block-label]').disabled, format === "text");
        assert.equal(panel.querySelector('[data-definition-format] option[value="list"]').disabled, format === "text");
        assert.equal(panel.querySelector('[data-definition-format-field]').hidden, format === "text");
        assert.equal(panel.querySelector('[data-block-label-field]').hidden, format === "text");
        assert.equal(panel.querySelector('[data-text-format-hint]').hidden, format !== "text");
        panel.querySelector('[data-action="normalize"]').dispatchEvent(new h.document.defaultView.Event("click"));
        assert.equal(values.at(-1).format, format);
        assert.equal(values.at(-1).blockLabel, "brackets");
        assert.equal(values.at(-1).superscript, true);
        assert.equal(values.at(-1).renumber, false);
        assert.equal(values.at(-1).definitionFormat, format === "text" ? "literal" : "list");
    }
});

test("text and mixed keep normalization always use fixed definitions, including omitted layout and superscript", () => {
    const h = host();
    const html = block("body", `[^1] ${ref("li-b", "[2]")}`)
        + orderedList("tail", [["b", "B", "2"], ["a", "<b>A</b>", "1"]]);
    for (const format of ["text", "keep"]) for (const superscript of [false, true])
        for (const definitionFormat of [undefined, "list", "literal"]) {
            const options = {format, superscript, definitionFormat, renumber: false};
            const tx = h.model.prepareNormalization(h.snapshot(html), options);
            const next = replay(h, h.snapshot(html).signature, tx.forward);
            const snapshot = h.snapshot(next);
            assert.equal(snapshot.definitionFormat, "literal");
            assert.equal(snapshot.staleReferenceCount, 0);
            assert.equal(snapshot.references.length, 2);
            assert.equal(snapshot.notes.find(n => n.blockId === "a").references[0].label, "2");
            assert.equal(snapshot.notes.find(n => n.blockId === "b").references[0].label, "1");
            assert.match(next, /\[\^2\]: <b>A<\/b>/);
            assert.equal(snapshot.references[1].kind, format === "keep" ? "block" : "text");
            if (format === "keep") assert.equal(snapshot.references[1].targetId, "b");
            assert.equal(h.model.prepareNormalization(h.snapshot(next), options).forward.length, 0);
            assert.equal(replay(h, next, tx.undo), h.snapshot(html).signature);
        }
});

test("legacy mixed-reference refresh confirmation uses fixed definitions and preserves targets", async () => {
    const h = host(); h.manager.register(); const panel = h.mount();
    const html = block("body", `[^1] ${ref("b", "[2]")}`)
        + orderedList("tail", [["a", "A"], ["b", "B"]]);
    const editor = h.addEditor("doc", html); h.setDOM(html);
    h.manager.sidebar.render(h.snapshot(html), "文档");
    h.manager.sidebar.invalidateEditor();
    await h.manager.normalize({format: "keep", renumber: false, definitionFormat: "list"});
    assert.match(h.confirmations[0].text, /脚注定义：\[\^编号\]: 内容/);
    assert.doesNotMatch(h.confirmations[0].text, /脚注定义：文末有序列表/);
    h.confirmations[0].cb();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.transactions.length, 1);
    assert.equal(h.snapshot(editor.protyle.wysiwyg.element.innerHTML).definitionFormat, "literal");
});


function slashContext(h, editor, start = 3, end = 6) {
    const source = editor.protyle.wysiwyg.element.firstElementChild;
    const text = source.querySelector('[contenteditable="true"]').firstChild;
    h.document.createRange = () => ({
        setStart(node, offset) {this.startContainer = node; this.startOffset = offset;},
        setEnd(node, offset) {this.endContainer = node; this.endOffset = offset;},
        setStartAfter(node) {this.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + 1);},
        collapse() {this.endContainer = this.startContainer; this.endOffset = this.startOffset;},
    });
    editor.protyle.toolbar = {}; editor.protyle.wysiwyg.lastHTMLs = {};
    const range = {startContainer: text, startOffset: start, endContainer: text, endOffset: end,
        cloneRange() {return {...this};}, selectNodeContents() {this.startOffset = 0; this.endOffset = text.data.length;},
        setEnd(node, offset) {this.endContainer = node; this.endOffset = offset;},
        toString() {return text.data.slice(this.startOffset, this.endOffset);}};
    h.setSelection({rangeCount: 1, range, getRangeAt() {return this.range;},
        removeAllRanges() {this.rangeCount = 0;}, addRange(value) {this.range = value; this.rangeCount = 1;}});
    return source;
}
async function settle() {for (let tick = 0; tick < 25; tick++) await Promise.resolve();}
function confirmNewFootnote(h) {
    const dialog = h.dialogs.at(-1).element;
    dialog.querySelector('[data-picker-create]').click();
    dialog.querySelector('[data-picker-submit]').click();
}

async function openLargePicker(h, count = 1000) {
    const html = block('body', '正文 /jz 后') + Array.from({length: count}, (_, i) =>
        block(`picker-note-${i + 1}`, `[^${i + 1}]: 候选说明 ${i + 1}${i === count - 1 ? ' 搜索文末特殊内容' : ''}`)).join('');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
    await h.manager.insert(editor, slashContext(h, editor));
    return h.dialogs.at(-1).element;
}

test('large picker loads 40 rows at a time while retaining selection, row identity and complete search', async () => {
    const h = host(), dialog = await openLargePicker(h), list = dialog.querySelector('[data-picker-notes]');
    assert.equal(list.querySelectorAll('[role="option"]').length, 40);
    assert.match(dialog.querySelector('[data-picker-status]').textContent, /1000 条脚注/);
    const first = list.querySelector('[data-definition-id="picker-note-1"]');
    scrollListEdge(h, dialog, '脚注候选');
    assert.equal(list.querySelectorAll('[role="option"]').length, 80);
    assert.equal(list.querySelector('[data-definition-id="picker-note-1"]'), first);
    assert.equal(first.getAttribute('aria-selected'), 'true');
    list.querySelector('[data-definition-id="picker-note-75"]').click();
    assert.equal(dialog.querySelector('[data-picker-submit]').textContent, '插入脚注');
    scrollListEdge(h, dialog, '脚注候选');
    assert.equal(list.querySelectorAll('[role="option"]').length, 120);
    assert.equal(list.querySelector('[data-definition-id="picker-note-75"]').getAttribute('aria-selected'), 'true');
    const search = dialog.querySelector('[data-picker-search]'); search.value = '搜索文末特殊内容';
    search.dispatchEvent(new h.document.defaultView.Event('input'));
    assert.equal(list.querySelectorAll('[role="option"]').length, 1);
    assert.equal(list.querySelector('[role="option"]').dataset.definitionId, 'picker-note-1000');
    assert.equal(list.scrollTop, 0);
    assert.equal(dialog.querySelector('[data-list-edge="end"]').hidden, true);
    assert.equal(h.transactions.length, 0);
    search.value = ''; search.dispatchEvent(new h.document.defaultView.Event('input'));
    assert.equal(list.querySelectorAll('[role="option"]').length, 40);
    dialog.querySelector('[data-picker-cancel]').click();
});

test('picker keyboard navigation crosses batches and wraps to the last unloaded note before confirmation', async () => {
    const h = host(), dialog = await openLargePicker(h), search = dialog.querySelector('[data-picker-search]');
    const key = key => search.dispatchEvent(Object.assign(new h.document.defaultView.Event('keydown', {bubbles: true}), {key}));
    for (let i = 0; i < 40; i++) key('ArrowDown');
    assert.equal(dialog.querySelector('[aria-selected="true"]').dataset.definitionId, 'picker-note-41');
    assert.equal(dialog.querySelectorAll('[role="option"]').length, 120);
    key('ArrowUp');
    assert.equal(dialog.querySelector('[aria-selected="true"]').dataset.definitionId, 'picker-note-40');
    search.value = ''; search.dispatchEvent(new h.document.defaultView.Event('input'));
    dialog.querySelector('[data-picker-create]').click();
    key('ArrowUp');
    const selected = dialog.querySelector('[aria-selected="true"]');
    assert.equal(selected.dataset.definitionId, 'picker-note-1000');
    assert.equal(search.getAttribute('aria-activedescendant'), selected.id);
    assert.ok(dialog.querySelectorAll('[role="option"]').length <= 120);
    assert.equal(h.transactions.length, 0);
    dialog.querySelector('[data-picker-submit]').click(); await settle();
    assert.equal(h.transactions.length, 1);
    assert.equal(h.transactions[0].forward.length, 1);
    assert.match(h.transactions[0].forward[0].data, /data-id="picker-note-1000"/);
});

test('picker disconnects scroll observers on close and ignores late observer callbacks', async () => {
    const h = host(), observers = [];
    h.hostWindow.IntersectionObserver = class {
        constructor(callback) {this.callback = callback; this.targets = new Set(); observers.push(this);}
        observe(target) {this.targets.add(target);}
        disconnect() {this.disconnected = true;}
    };
    const dialog = await openLargePicker(h, 200), observer = observers[0];
    const end = dialog.querySelector('[data-list-edge="end"]');
    observer.callback([{isIntersecting: true, target: end}]);
    assert.equal(dialog.querySelectorAll('[role="option"]').length, 80);
    dialog.querySelector('[data-picker-cancel]').click();
    assert.equal(observer.disconnected, true);
    observer.callback([{isIntersecting: true, target: end}]);
    assert.equal(dialog.querySelectorAll('[role="option"]').length, 80);
    assert.equal(h.manager.insertionDialog, undefined);
    assert.equal(h.transactions.length, 0);
});

test('picker searches complete content and wrapped labels, prioritizes exact labels and skips unavailable choices', async () => {
    const h = host(), html = block('body', '正文 /jz 后')
        + block('other', '[^17]: 包含 7 的说明') + block('exact', '[^7]: Exact match')
        + block('long', '[^A]: ' + '较长的说明。'.repeat(30) + ' Hidden Keyword')
        + block('dup1', '[^D]: 重复一') + block('dup2', '[^D]: 重复二');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
    await h.manager.insert(editor, slashContext(h, editor));
    const dialog = h.dialogs.at(-1).element, input = dialog.querySelector('[data-picker-search]');
    const search = value => {input.value = value; input.dispatchEvent(new h.document.defaultView.Event('input'));};
    search('[^7]');
    assert.equal(dialog.querySelector('[role="option"]').dataset.definitionId, 'exact');
    assert.equal(input.getAttribute('aria-activedescendant'), dialog.querySelector('[data-definition-id="exact"]').id);
    search('hidden keyword');
    assert.equal(dialog.querySelectorAll('[role="option"]').length, 1);
    assert.equal(dialog.querySelector('[role="option"]').dataset.definitionId, 'long');
    search('D');
    assert.equal(dialog.querySelector('[data-definition-id="dup1"]').disabled, true);
    assert.match(dialog.querySelector('[data-definition-id="dup1"]').textContent, /编号重复/);
    assert.notEqual(dialog.querySelector('[aria-selected="true"]')?.dataset.definitionId, 'dup1');
    search('没有匹配');
    assert.equal(dialog.querySelectorAll('[role="option"]').length, 0);
    assert.equal(input.hasAttribute('aria-activedescendant'), false);
    assert.equal(dialog.querySelector('[data-picker-submit]').disabled, false);
    assert.match(dialog.querySelector('[data-picker-status]').textContent, /没有匹配/);
    assert.equal(h.transactions.length, 0);
});

test('picker keyboard reuse respects IME and creates no extra definition or content edits', async () => {
    const h = host(), html = block('body', '正文 /jz 后') + block('a', '[^1]: One') + block('b', '[^2]: Two');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
    await h.manager.insert(editor, slashContext(h, editor));
    const dialog = h.dialogs.at(-1).element, input = dialog.querySelector('[data-picker-search]');
    const key = (key, extra = {}) => input.dispatchEvent(Object.assign(new h.document.defaultView.Event('keydown', {bubbles: true}), {key, ...extra}));
    dialog.querySelector('[data-picker-content]').value = '不能覆盖已有脚注';
    key('Enter', {isComposing: true}); await settle(); assert.equal(h.transactions.length, 0);
    key('ArrowDown');
    assert.equal(dialog.querySelector('[aria-selected="true"]').dataset.definitionId, 'b');
    key('Enter'); await settle();
    assert.equal(h.transactions.length, 0);
    assert.equal(dialog.querySelector('[data-picker-submit]').textContent, '插入脚注');
    dialog.querySelector('[data-picker-submit]').click(); await settle();
    assert.equal(h.transactions.length, 1);
    assert.equal(h.transactions[0].forward.length, 1);
    assert.match(h.transactions[0].forward[0].data, /data-id="b"/);
    assert.doesNotMatch(h.transactions[0].forward[0].data, /不能覆盖/);
});

test('new footnote content stays plain text across literal, initial list and appended list insertions with exact undo', () => {
    const h = host(), content = '<img src=x onerror=alert(1)> & 说明\n第二行';
    for (const mode of ['literal', 'initial-list', 'append-list']) {
        const tail = mode === 'literal' ? block('old', '[^4]: 已有说明') : mode === 'append-list'
            ? '<div data-node-id="list" data-type="NodeList" data-subtype="o"><div data-node-id="item" data-type="NodeListItem" data-marker="1.">' + block('old', '已有说明') + '</div></div>' : '';
        const html = block('body', '正文 /jz 后') + tail;
        let id = 0;
        const tx = h.model.prepareInsertion(h.snapshot(html), 'body', 3, 6, '/jz', () => `new-${++id}`, {preferences: h.model.DEFAULT_PREFERENCES, content});
        const fragment = h.document.createElement('div');
        fragment.innerHTML = tx.forward.filter(op => op.action === 'insert').map(op => op.data).join('');
        const definition = fragment.querySelector(`[data-node-id="${tx.definitionId}"] [contenteditable="true"]`);
        assert.equal(definition.textContent, mode === 'literal' ? `[^${tx.label}]: ${content}` : content, mode);
        assert.equal(fragment.querySelector('img'), null, mode);
        assert.equal(tx.undo.filter(op => op.action === 'delete').length, tx.forward.filter(op => op.action === 'insert').length);
        assert.equal(tx.undo.find(op => op.action === 'update').data, h.snapshot(html).blocks[0].outerHTML);
    }
});

test('picker requires confirmation to create entered content and preserves the draft after failed submission', async () => {
    const h = host(), html = block('body', '正文 /jz 后');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
    await h.manager.insert(editor, slashContext(h, editor));
    const dialog = h.dialogs.at(-1).element, draft = dialog.querySelector('[data-picker-content]');
    draft.value = '直接输入的说明';
    const transaction = editor.transaction; editor.transaction = () => {throw Error('提交失败');};
    draft.dispatchEvent(Object.assign(new h.document.defaultView.Event('keydown', {bubbles: true}), {key: 'Enter', ctrlKey: true}));
    await settle(); assert.equal(h.transactions.length, 0);
    dialog.querySelector('[data-picker-submit]').click(); await settle();
    assert.equal(h.transactions.length, 0);
    assert.equal(draft.value, '直接输入的说明'); assert.equal(draft.disabled, false);
    assert.equal(dialog.querySelector('[data-picker-search]').disabled, false);
    editor.transaction = transaction;
    dialog.querySelector('[data-picker-submit]').click(); await settle();
    assert.equal(h.transactions.length, 1);
    assert.match(h.transactions[0].forward.filter(op => op.action === 'insert').map(op => op.data).join(''), /直接输入的说明/);
    assert.equal(h.manager.pendingSelection.focus, true);
});

test('picker selection and create mode change the confirmation label without writing or losing the draft', async () => {
    const h = host(), html = block('body', '正文 /jz 后') + block('a', '[^1]: One') + block('b', '[^2]: Two');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
    await h.manager.insert(editor, slashContext(h, editor));
    const dialog = h.dialogs.at(-1).element, submit = dialog.querySelector('[data-picker-submit]');
    assert.equal(submit.textContent, '插入脚注');
    assert.equal(dialog.querySelector('[data-picker-draft]').hidden, true);
    dialog.querySelector('[data-definition-id="b"]').click();
    assert.equal(dialog.querySelector('[aria-selected="true"]').dataset.definitionId, 'b');
    assert.equal(submit.textContent, '插入脚注');
    dialog.querySelector('[data-picker-create]').click();
    assert.equal(submit.textContent, '新建脚注');
    assert.equal(dialog.querySelector('[data-picker-draft]').hidden, false);
    assert.equal(dialog.querySelector('[aria-selected="true"]'), null);
    dialog.querySelector('[data-picker-content]').value = '保留草稿';
    dialog.querySelector('[data-definition-id="a"]').click();
    assert.equal(submit.textContent, '插入脚注');
    dialog.querySelector('[data-picker-create]').click();
    assert.equal(dialog.querySelector('[data-picker-content]').value, '保留草稿');
    assert.equal(h.transactions.length, 0);
    submit.click(); await settle();
    assert.equal(h.transactions.length, 1);
    assert.match(h.transactions[0].forward.filter(op => op.action === 'insert').map(op => op.data).join(''), /保留草稿/);
});

test("sidebar persists mode and dependent preferences, only exposes manual refresh with live refresh off", () => {
    const h = host(); h.addEditor("doc", block("body", "正文")); h.manager.register(); const panel = h.mount();
    const select = (selector, value) => {
        panel.querySelector(`${selector} option[value="${value}"]`).selected = true;
        panel.querySelector(selector).dispatchEvent(new h.document.defaultView.Event("change"));
    };
    assert.equal(panel.querySelector('select'), panel.querySelector('[data-reference-format-field] select'));
    assert.equal(panel.querySelector('.siyuan-footnote-sidebar__display').hidden, true);
    select('select', 'text');
    assert.equal(panel.querySelector('.siyuan-footnote-sidebar__display').hidden, false);
    assert.equal(panel.querySelector('[data-action="refresh"]').hidden, true);
    panel.querySelector('[data-live-refresh]').checked = false;
    panel.querySelector('[data-live-refresh]').dispatchEvent(new h.document.defaultView.Event("change"));
    assert.equal(panel.querySelector('[data-action="refresh"]').hidden, false);
    select('select', 'block'); select('[data-block-label]', 'brackets'); select('[data-definition-format]', 'literal');
    select('select', 'text'); select('select', 'block');
    assert.equal(panel.querySelector('[data-block-label]').value, 'brackets');
    assert.equal(panel.querySelector('[data-definition-format]').value, 'literal');
    const replacement = h.mount();
    assert.equal(replacement.querySelector('[data-block-label]').value, 'brackets');
    assert.equal(replacement.querySelector('[data-definition-format]').value, 'literal');
    assert.equal(replacement.querySelector('[data-live-refresh]').checked, false);
    assert.equal(h.transactions.length, 0);
});

test("format audit is read-only, ignores temporary styles, reports every requested mismatch", () => {
    const h = host();
    const html = block("body", '[^9]') + block('d', '[^9]: 内容');
    const snapshot = h.snapshot(html), before = snapshot.signature;
    const issues = h.model.auditFootnoteFormat(snapshot, h.model.DEFAULT_PREFERENCES);
    for (const expected of ['引用写法', '定义格式', '引用上标', '连续编号']) assert.ok(issues.includes(expected));
    assert.equal(snapshot.container.firstElementChild.outerHTML, h.snapshot(before).container.firstElementChild.outerHTML);
    const tx = h.model.prepareNormalization(h.snapshot(html), h.model.DEFAULT_PREFERENCES, (() => {let i = 0; return () => `audit-${++i}`;})());
    const normalized = replay(h, before, tx.forward);
    assert.deepEqual(Array.from(h.model.auditFootnoteFormat(h.snapshot(normalized), h.model.DEFAULT_PREFERENCES)), []);
    const prefs = {...h.model.DEFAULT_PREFERENCES, superscript: false};
    assert.deepEqual(Array.from(h.model.auditFootnoteFormat(h.snapshot(normalized), prefs)), []);
    const pending = h.snapshot(html); pending.pending = true;
    assert.deepEqual(Array.from(h.model.auditFootnoteFormat(pending, prefs)), []);
});

test("picker opens before the document read finishes, cancellation and late reads never write", async () => {
    const h = host(), html = block('body', '正文 /jz 后');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register(); const source = slashContext(h, editor);
    const finish = h.deferRead(); const opening = h.manager.insert(editor, source);
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.dialogs[0].element.querySelector('[data-picker-submit]').disabled, true);
    h.dialogs[0].element.querySelector('[data-picker-cancel]').click(); finish(html); await opening;
    assert.equal(h.transactions.length, 0); assert.equal(h.manager.insertionDialog, undefined);
    assert.equal(h.model.documentContentSignature(editor.protyle.wysiwyg.element.innerHTML), h.model.documentContentSignature(html));
});

test("picker reuses existing definitions without IDs or waiting on pending document saves", async () => {
    const h = host(), html = block('body', '正文 /jz 后') + block('d', '[^7]: 已有脚注');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
    editor.flushPendingTransactions = () => {throw Error('must not flush the document');};
    editor.protyle.wysiwyg.element.insertAdjacentHTML('beforeend', block('unsaved', '尚未保存'));
    const source = slashContext(h, editor); delete h.hostWindow.Lute;
    await h.manager.insert(editor, source);
    const button = h.dialogs.at(-1).element.querySelector('[data-definition-id="d"]');
    assert.match(button.textContent, /已有脚注/); button.click(); await settle();
    assert.equal(h.transactions.length, 0);
    h.dialogs.at(-1).element.querySelector('[data-picker-submit]').click(); await settle();
    assert.equal(h.transactions.length, 1); const tx = h.transactions[0];
    assert.equal(tx.forward.length, 1); assert.equal(tx.forward[0].id, 'body');
    assert.match(tx.forward[0].data, /data-id="d"/); assert.match(tx.forward[0].data, /block-ref sup/);
    assert.equal(h.manager.pendingSelection.focus, false);
    assert.ok(editor.protyle.wysiwyg.element.querySelector('[data-node-id="unsaved"]'));
});

test("picker creates text references from preferences and includes queued definitions when allocating numbers", async () => {
    const h = host(), html = block('body', '正文 /jz 后');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register(); const panel = h.mount();
    panel.querySelector('select option[value="text"]').selected = true;
    panel.querySelector('select').dispatchEvent(new h.document.defaultView.Event('change'));
    editor.protyle.wysiwyg.element.insertAdjacentHTML('beforeend', block('queued-note', '[^1]: 队列中的脚注'));
    await h.manager.insert(editor, slashContext(h, editor));
    confirmNewFootnote(h); await settle();
    assert.equal(h.transactions.length, 1); const tx = h.transactions[0];
    assert.match(tx.forward.at(-1).data, /data-type="sup">\[\^2\]/);
    assert.doesNotMatch(tx.forward.at(-1).data, /block-ref|data-footnote-insertion/);
    assert.match(tx.forward.find(op => op.action === 'insert' && op.data.includes('[^2]:')).data, /\[\^2\]:/);
    assert.equal(h.manager.pendingSelection.focus, true);
});

test("source changes, target removal, readonly and document switches prevent picker writes", async () => {
    for (const change of ['source', 'target', 'switch', 'readonly']) {
        const h = host(), html = block('body', '正文 /jz 后') + block('d', '[^1]: 内容');
        const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
        await h.manager.insert(editor, slashContext(h, editor));
        const dialog = h.dialogs.at(-1);
        if (change === 'source') editor.protyle.wysiwyg.element.firstElementChild.querySelector('[contenteditable]').textContent = 'changed';
        if (change === 'target') {editor.protyle.wysiwyg.element.lastElementChild.remove(); h.setDOM(block('body', '正文 /jz 后'));}
        if (change === 'switch') h.addEditor('other', block('other-body', '另一个文档'));
        if (change === 'readonly') editor.protyle.disabled = true;
        dialog.element.querySelector('[data-definition-id="d"]').click(); await settle();
        dialog.element.querySelector('[data-picker-submit]').click(); await settle();
        assert.equal(h.transactions.length, 0, change); assert.match(dialog.element.querySelector('[data-picker-status]').textContent, /改变|只读|切换/);
    }
});

test("unrelated edits do not invalidate insertion and rejected native transactions restore the slash range", async () => {
    for (const fail of [false, true]) {
        const h = host(), html = block('body', '正文 /jz 后') + block('other', '另一个块');
        const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register();
        await h.manager.insert(editor, slashContext(h, editor));
        editor.protyle.wysiwyg.element.lastElementChild.querySelector('[contenteditable]').textContent = '新的正文';
        h.manager.revision++;
        if (fail) editor.transaction = () => {throw Error('submit failed');};
        confirmNewFootnote(h); await settle();
        assert.equal(h.transactions.length, fail ? 0 : 1);
        const root = editor.protyle.wysiwyg.element;
        assert.match(root.querySelector('[data-node-id="other"]').textContent, /新的正文/);
        if (fail) {assert.match(root.firstElementChild.textContent, /\/jz/); assert.equal(root.querySelectorAll('[data-type="NodeList"]').length, 0);}
    }
});

test("manual refresh defers through composition and duplicate or missing entries cannot be selected", async () => {
    const h = host(), html = block('body', '正文 /jz 后 [^missing]') + block('a', '[^1]: A') + block('b', '[^1]: B');
    const editor = h.addEditor('doc', html); h.setDOM(html); h.manager.register(); const panel = h.mount();
    h.manager.composing = true;
    panel.querySelector('[data-action="refresh"]').click(); assert.equal(h.manager.manualRefreshPending, true);
    h.document.dispatchEvent(new h.document.defaultView.Event('compositionend'));
    assert.equal(h.manager.manualRefreshPending, false);
    await h.manager.insert(editor, slashContext(h, editor));
    const buttons = h.dialogs.at(-1).element.querySelectorAll('[data-definition-id]');
    assert.equal(buttons.length, 3); for (const button of buttons) assert.equal(button.disabled, true);
    assert.equal(h.dialogs.at(-1).element.querySelector('[data-picker-submit]').disabled, false);
});


test("insertion into a queued new paragraph follows native creation without rewriting other blocks", async () => {
    const h = host(), saved = block('existing', '已保存正文'), html = block('body', '正文 /jz 后') + saved;
    const editor = h.addEditor('doc', html); h.setDOM(saved); h.manager.register();
    await h.manager.insert(editor, slashContext(h, editor));
    confirmNewFootnote(h); await settle();
    assert.equal(h.transactions.length, 1);
    const tx = h.transactions[0];
    assert.equal(tx.forward.some(op => op.id === 'existing'), false);
    const nativeCreation = {action: 'insert', id: 'body', data: h.snapshot(html).blocks[0].outerHTML,
        parentID: 'doc', nextID: 'existing'};
    const result = replay(h, h.snapshot(saved).signature, [nativeCreation, ...tx.forward]);
    assert.equal(h.snapshot(result).notes.length, 1);
    assert.equal(h.snapshot(result).notes[0].references.length, 1);
    assert.match(replay(h, result, tx.undo), /正文 \/jz 后/);
});


test("insertion content comparison ignores empty styles and transient wrappers but detects real formatting", () => {
    const h = host(), plain = block('body', '正文 [^1] /jz');
    const decorated = block('body', '正文 <span class="siyuan-footnote-ref" data-siyuan-footnote-enhanced="true" data-preview="预览">[^1]</span> /jz')
        .replace('contenteditable="true"', 'contenteditable="true" style=""');
    assert.equal(h.model.documentContentSignature(plain), h.model.documentContentSignature(decorated));
    assert.notEqual(h.model.documentContentSignature(plain), h.model.documentContentSignature(plain.replace('[^1]', '<b>[^1]</b>')));
    const snapshot = h.snapshot(plain), before = snapshot.container.firstElementChild.outerHTML;
    h.model.documentContentSignature(snapshot.container);
    assert.equal(snapshot.container.firstElementChild.outerHTML, before, 'comparison must remain read-only');
});


function largeSidebarSnapshot(h, count = 1000, paragraphs = 125) {
    const snapshot = h.snapshot(block('d0', '[^1]: 内容'));
    const refs = Array.from({length: paragraphs}, (_, i) => ({blockId: `p${i}`, heading: '章节', excerpt: `第 ${i} 段正文`, kind: 'text', label: '1'}));
    refs.push({...refs[0]});
    snapshot.notes = Array.from({length: count}, (_, i) => ({key: `d${i}`, blockId: `d${i}`, label: String(i + 1),
        content: `脚注内容 ${i}`, references: i === 0 ? refs : [], duplicate: false, missing: false}));
    snapshot.references = refs;
    return snapshot;
}

function scrollListEdge(h, panel, kind, edge = 'end') {
    const root = kind === '脚注候选' ? panel.querySelector('[data-picker-notes]')
        : kind === '脚注' ? panel.querySelector('.siyuan-footnote-sidebar__list') : panel.querySelector('[data-panel-content="notes"]');
    root.getBoundingClientRect = () => ({top: 0, bottom: 200});
    for (const sentinel of panel.querySelectorAll(`[data-list-kind="${kind}"]`)) {
        const near = sentinel.dataset.listEdge === edge;
        sentinel.getBoundingClientRect = () => ({top: near ? 100 : 1000, bottom: near ? 101 : 1001});
    }
    root.dispatchEvent(new h.document.defaultView.Event('scroll'));
}

test('large sidebars render bounded first batches and preserve full counts and automatic scroll loading', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar, snapshot = largeSidebarSnapshot(h);
    sidebar.render(snapshot, '大文档');
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 40);
    assert.equal(panel.querySelectorAll('.siyuan-footnote-sidebar__reference').length, 30);
    assert.match(panel.querySelector('.siyuan-footnote-sidebar__status').textContent, /1000 个脚注 · 126 处引用/);
    assert.equal(panel.querySelector('.siyuan-footnote-sidebar__reference-count').textContent, '125');
    assert.match(panel.querySelector('[data-block-id="p0"]').textContent, /2 次/);
    const first = panel.querySelector('[data-note-key="d0"]');
    scrollListEdge(h, panel, '脚注');
    scrollListEdge(h, panel, '段落');
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 80);
    assert.equal(panel.querySelectorAll('.siyuan-footnote-sidebar__reference').length, 60);
    assert.equal(panel.querySelector('[data-note-key="d0"]'), first);
    panel.querySelector('[data-block-id="p59"]').click();
    assert.equal(h.opens.at(-1), 'p59');
    assert.equal(h.transactions.length, 0);
});

test('unchanged sidebar rows, scroll positions and the native editor survive fresh snapshots', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar; sidebar.render(largeSidebarSnapshot(h), '大文档');
    scrollListEdge(h, panel, '脚注'); scrollListEdge(h, panel, '段落');
    const row = panel.querySelector('[data-note-key="d1"]'), refRow = panel.querySelector('[data-block-id="p1"]');
    const list = panel.querySelector('.siyuan-footnote-sidebar__list'); list.scrollTop = 230;
    const editor = sidebar.protyle, next = largeSidebarSnapshot(h);
    sidebar.render(next, '大文档');
    assert.equal(panel.querySelector('[data-note-key="d1"]'), row);
    assert.equal(panel.querySelector('[data-block-id="p1"]'), refRow);
    assert.equal(list.scrollTop, 230); assert.equal(sidebar.protyle, editor);
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 80);
    next.notes[1] = {...next.notes[1], content: '只更新这一项'};
    sidebar.render(next, '大文档');
    assert.notEqual(panel.querySelector('[data-note-key="d1"]'), row);
    assert.match(panel.querySelector('[data-note-key="d1"]').textContent, /只更新这一项/);
    assert.equal(panel.querySelector('[data-block-id="p1"]'), refRow);
    assert.equal(h.nativeEditors.length, 1);
});

test('selecting a distant note pins only that row and switching documents resets the batch', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar, snapshot = largeSidebarSnapshot(h);
    sidebar.render(snapshot, '大文档'); sidebar.selectNew('d999', false); sidebar.render(snapshot, '大文档');
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 41);
    assert.equal(panel.querySelector('[data-note-key="d999"]').getAttribute('aria-pressed'), 'true');
    assert.equal(sidebar.protyle.wysiwyg.element.firstElementChild.dataset.nodeId, 'd999');
    const small = largeSidebarSnapshot(h, 3); small.rootId = 'other';
    sidebar.render(small, '另一文档');
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 3);
    assert.equal(panel.querySelector('[data-list-kind="脚注"][data-list-edge="end"]').hidden, true);
    sidebar.clear();
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 0);
    assert.equal(panel.querySelectorAll('.siyuan-footnote-sidebar__reference').length, 0);
});

test('scroll observers append batches and disconnect on sidebar suspension and destruction', () => {
    const h = host(), observers = [];
    h.hostWindow.IntersectionObserver = class {
        constructor(callback, options) {this.callback = callback; this.options = options; observers.push(this);}
        observe(target) {this.target = target; this.disconnected = false;}
        disconnect() {this.disconnected = true;}
        intersect() {this.callback([{isIntersecting: true, target: this.target}]);}
    };
    h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar; sidebar.render(largeSidebarSnapshot(h), '大文档');
    observers[0].intersect(); assert.equal(panel.querySelectorAll('[data-note-key]').length, 80);
    sidebar.suspend(); assert.ok(observers.every(observer => observer.disconnected));
    observers[0].intersect(); assert.equal(panel.querySelectorAll('[data-note-key]').length, 80);
    sidebar.resume(); observers[0].intersect(); assert.equal(panel.querySelectorAll('[data-note-key]').length, 120);
    sidebar.destroy(); assert.ok(observers.every(observer => observer.disconnected));
    observers[0].intersect(); assert.equal(panel.querySelectorAll('[data-note-key]').length, 0);
});

test('simultaneous sidebar refreshes share one read and a document switch does not wait for it', async () => {
    const h = host(), html = block('d', '[^1]: 当前文档');
    const main = h.addEditor('doc', html); h.setDOM(html); h.manager.register(); const panel = h.mount(); h.timers.clear();
    const api = h.api.fetchSyncPost; let reads = 0;
    h.api.fetchSyncPost = (...args) => {reads++; return api(...args);};
    const finish = h.deferRead();
    const first = h.manager.refresh(), second = h.manager.refresh();
    assert.equal(reads, 1); finish(html); await Promise.all([first, second]);
    assert.equal(h.timers.size, 0, 'unchanged duplicate refresh must not queue another full read');
    let release;
    h.api.fetchSyncPost = (url, args) => args.id === 'doc' ? new Promise(resolve => {release = resolve;})
        : Promise.resolve({code: 0, data: {dom: block('new-note', '[^2]: 新文档')}});
    const old = h.manager.refresh();
    const other = h.addEditor('other', block('new-note', '[^2]: 新文档'));
    h.emit('switch-protyle', {protyle: other.protyle}); await h.manager.refresh();
    assert.match(panel.querySelector('[data-note-key="new-note"]').textContent, /新文档/);
    release({code: 0, data: {dom: html}}); await old;
    assert.equal(h.manager.snapshot.rootId, 'other');
});


function locateNumber(h, panel, value) {
    const input = panel.querySelector('[data-locate-number]'); input.value = value;
    panel.querySelector('.siyuan-footnote-sidebar__quick-locate').dispatchEvent(new h.document.defaultView.Event('submit', {cancelable: true}));
}

test('number locator reveals an unloaded note without expanding all preceding batches', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar; sidebar.render(largeSidebarSnapshot(h), '大文档');
    locateNumber(h, panel, '  [^1000]  ');
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 80);
    assert.equal(panel.querySelector('[data-note-key="d999"]').getAttribute('aria-pressed'), 'true');
    assert.equal(sidebar.protyle.wysiwyg.element.firstElementChild.dataset.nodeId, 'd999');
    assert.match(panel.querySelector('[data-locate-status]').textContent, /已定位脚注 \[\^1000\]/);
    sidebar.render(largeSidebarSnapshot(h), '大文档');
    assert.equal(panel.querySelector('[data-note-key="d999"]').getAttribute('aria-pressed'), 'true');
    assert.equal(panel.querySelector('[data-locate-number]').value, '  [^1000]  ');
    assert.equal(h.transactions.length, 0);
});

test('number locator accepts plain and bracketed labels and does not change selection on failure', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar; sidebar.render(largeSidebarSnapshot(h, 3), '文档');
    for (const value of ['2', '[2]', '[^2]']) {
        locateNumber(h, panel, value);
        assert.equal(panel.querySelector('[data-note-key="d1"]').getAttribute('aria-pressed'), 'true');
    }
    const editor = sidebar.protyle;
    locateNumber(h, panel, '999');
    assert.match(panel.querySelector('[data-locate-status]').textContent, /未找到编号 999/);
    assert.equal(panel.querySelector('[data-locate-number]').getAttribute('aria-invalid'), 'true');
    assert.equal(sidebar.protyle, editor);
    locateNumber(h, panel, '   '); assert.match(panel.querySelector('[data-locate-status]').textContent, /请输入/);
    panel.querySelector('[data-locate-number]').dispatchEvent(new h.document.defaultView.Event('input'));
    assert.equal(panel.querySelector('[data-locate-status]').hidden, true);
    const snapshot = h.snapshot(block('a', '[^A]: 字母编号')); sidebar.render(snapshot, '文档');
    locateNumber(h, panel, '[^A]'); assert.equal(sidebar.protyle.wysiwyg.element.firstElementChild.dataset.nodeId, 'a');
    snapshot.rootId = 'other'; sidebar.render(snapshot, '另一文档');
    assert.equal(panel.querySelector('[data-locate-number]').value, '');
    assert.equal(panel.querySelector('[data-locate-status]').hidden, true);
});

test('number locator cycles duplicate definitions and locates missing definitions in readonly documents', () => {
    const h = host(), html = block('body', '正文 [^1] [^missing]') + block('a', '[^1]: 第一条') + block('b', '[^1]: 第二条');
    h.addEditor('doc', html); h.manager.register(); const panel = h.mount();
    h.hostWindow.siyuan.config.readonly = true; h.manager.sidebar.render(h.snapshot(html), '文档');
    assert.equal(panel.querySelector('[data-locate-number]').disabled, false);
    assert.equal(panel.querySelector('[data-action="normalize"]').disabled, true);
    for (const id of ['a', 'b', 'a']) {
        locateNumber(h, panel, '1');
        assert.equal(h.manager.sidebar.protyle.wysiwyg.element.firstElementChild.dataset.nodeId, id);
        const native = h.nativeEditors.at(-1); native.options.after(native);
        assert.equal(h.manager.sidebar.protyle.disabled, true);
        assert.match(panel.querySelector('[data-locate-status]').textContent, /有 2 条脚注/);
    }
    locateNumber(h, panel, 'missing');
    assert.equal(h.manager.sidebar.protyle, undefined);
    assert.match(panel.querySelector('[data-locate-status]').textContent, /缺失定义/);
    assert.ok(panel.querySelector('.siyuan-footnote-sidebar__reference[data-block-id="body"]'));
    assert.equal(h.transactions.length, 0);
});

test('number locator respects busy/loading state and composition Enter does not submit', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar;
    assert.equal(panel.querySelector('[data-locate-number]').disabled, true);
    sidebar.render(largeSidebarSnapshot(h, 3), '文档'); sidebar.setBusy(true);
    locateNumber(h, panel, '3'); assert.equal(panel.querySelector('[data-note-key="d0"]').getAttribute('aria-pressed'), 'true');
    assert.equal(panel.querySelector('[data-action="locate-number"]').disabled, true);
    sidebar.setBusy(false);
    const input = panel.querySelector('[data-locate-number]');
    const composing = new h.document.defaultView.Event('keydown', {cancelable: true});
    Object.assign(composing, {key: 'Enter', isComposing: true}); input.dispatchEvent(composing);
    assert.equal(composing.defaultPrevented, true);
    locateNumber(h, panel, '3'); assert.equal(panel.querySelector('[data-note-key="d2"]').getAttribute('aria-pressed'), 'true');
    sidebar.clear(); assert.equal(input.value, ''); assert.equal(input.disabled, true);
});


test('one lookup of 467 loads its surrounding page and later batches cannot push it down', () => {
    const h = host(), observers = [];
    h.hostWindow.IntersectionObserver = class {
        constructor(callback) {this.callback = callback; observers.push(this);}
        observe() {} disconnect() {}
    };
    h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar; sidebar.render(largeSidebarSnapshot(h), '大文档');
    locateNumber(h, panel, '467');
    const rows = () => Array.from(panel.querySelectorAll('[data-note-key]'));
    const target = panel.querySelector('[data-note-key="d466"]');
    assert.equal(rows().length, 120); assert.equal(rows()[0].dataset.noteKey, 'd400');
    assert.equal(rows().indexOf(target), 66);
    // A queued intersection callback may still arrive after programmatic scrolling.
    observers[0].callback([{isIntersecting: true, target: panel.querySelector('[data-list-kind="脚注"][data-list-edge="end"]')}]);
    assert.equal(rows().length, 160); assert.equal(rows().indexOf(target), 66);
    sidebar.render(largeSidebarSnapshot(h), '大文档');
    assert.equal(rows().indexOf(target), 66); assert.equal(target.getAttribute('aria-pressed'), 'true');
    observers[0].callback([{isIntersecting: true, target: panel.querySelector('[data-list-kind="脚注"][data-list-edge="start"]')}]);
    assert.equal(rows()[0].dataset.noteKey, 'd360');
    locateNumber(h, panel, '1');
    assert.equal(rows().length, 80); assert.equal(rows()[0].dataset.noteKey, 'd0');
    assert.equal(panel.querySelector('[data-list-kind="脚注"][data-list-edge="start"]').hidden, true);
    assert.equal(h.transactions.length, 0);
});

test('page-boundary lookups remain in sorted windows with correct loading controls', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    h.manager.sidebar.render(largeSidebarSnapshot(h), '大文档');
    for (const label of ['40', '41', '480', '1000', '467']) {
        locateNumber(h, panel, label);
        const keys = Array.from(panel.querySelectorAll('[data-note-key]'), row => Number(row.dataset.noteKey.slice(1)));
        assert.ok(keys.length >= 40 && keys.length <= 120);
        assert.deepEqual(keys, keys.slice().sort((a, b) => a - b));
        assert.ok(keys.includes(Number(label) - 1));
        assert.equal(panel.querySelector('[data-list-kind="脚注"][data-list-edge="end"]').hidden, label === '1000');
        assert.equal(panel.querySelector(`[data-note-key="d${Number(label) - 1}"]`).getAttribute('aria-pressed'), 'true');
    }
});


test('separate notes and settings panels retain editing state and defer hidden list updates', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    const sidebar = h.manager.sidebar; sidebar.render(largeSidebarSnapshot(h), '大文档');
    const editor = sidebar.protyle, original = panel.querySelector('[data-note-key="d1"]');
    assert.equal(panel.querySelector('[data-panel-content="settings"]').hidden, true);
    assert.ok(panel.querySelector('[data-panel-content="settings"] [data-action="normalize"]'));
    assert.ok(panel.querySelector('[data-panel-content="settings"] [data-action="check-duplicates"]'));
    assert.ok(panel.querySelector('[data-panel-content="notes"] [data-locate-number]'));
    assert.equal(panel.querySelectorAll('[data-load-more], [data-load-earlier]').length, 0);
    panel.querySelector('[data-panel="settings"]').click();
    assert.equal(panel.querySelector('[data-panel-content="notes"]').hidden, true);
    assert.equal(panel.querySelector('[data-panel="settings"]').getAttribute('aria-selected'), 'true');
    const next = largeSidebarSnapshot(h); next.notes[1].content = '新内容';
    sidebar.render(next, '大文档'); scrollListEdge(h, panel, '脚注');
    assert.equal(panel.querySelectorAll('[data-note-key]').length, 40);
    assert.equal(panel.querySelector('[data-note-key="d1"]'), original);
    assert.equal(sidebar.protyle, editor);
    panel.querySelector('[data-panel="notes"]').click();
    assert.notEqual(panel.querySelector('[data-note-key="d1"]'), original);
    assert.match(panel.querySelector('[data-note-key="d1"]').textContent, /新内容/);
    assert.equal(sidebar.protyle, editor); assert.equal(h.transactions.length, 0);
    sidebar.showPanel('settings'); const other = largeSidebarSnapshot(h, 3); other.rootId = 'other';
    sidebar.render(other, '新文档'); assert.equal(sidebar.protyle, undefined);
    sidebar.showPanel('notes'); assert.equal(panel.querySelectorAll('[data-note-key]').length, 3);
});

test('automatic upward loading compensates visual displacement of existing rows', () => {
    const h = host(); h.addEditor('doc', block('body', '正文')); h.manager.register(); const panel = h.mount();
    h.manager.sidebar.render(largeSidebarSnapshot(h), '大文档'); locateNumber(h, panel, '467');
    const list = panel.querySelector('.siyuan-footnote-sidebar__list'); list.scrollTop = 10;
    const anchor = panel.querySelector('[data-note-key="d400"]');
    anchor.getBoundingClientRect = () => ({top: panel.querySelector('[data-note-key="d360"]') ? 2400 : 0});
    scrollListEdge(h, panel, '脚注', 'start');
    assert.ok(panel.querySelector('[data-note-key="d360"]'));
    assert.equal(list.scrollTop, 2410);
    assert.equal(panel.querySelector('[data-note-key="d466"]').getAttribute('aria-pressed'), 'true');
});
