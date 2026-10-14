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
    vm.runInNewContext(source, {exports, require: (id) => imports[id], console, ...globals}, {filename: name});
    return exports;
}
const definitions = compile("definitions.ts", {});
const block = (id, text, type = "NodeParagraph") =>
    `<div data-node-id="${id}" data-type="${type}"><div contenteditable="true">${text}</div></div>`;

function host() {
    const {document, window} = parseHTML("<html><body></body></html>");
    // LinkeDOM supplies real nodes, selectors, cloning and HTML serialization.
    // Its TreeWalker ignores filters, so apply the browser filter contract here.
    const nativeWalker = document.createTreeWalker.bind(document);
    document.createTreeWalker = (root, whatToShow, filter) => {
        const walker = nativeWalker(root, whatToShow);
        return {currentNode: root, nextNode() {
            let node;
            while ((node = walker.nextNode())) {
                if (!filter || filter.acceptNode(node) === 1) {
                    this.currentNode = node;
                    return node;
                }
            }
            return null;
        }};
    };
    const editors = [], messages = [], opens = [], menus = [], confirmations = [], transactions = [], requests = [];
    const timers = new Map();
    let timerId = 0, now = Date.now(), active, documentDOM = "", sqlRows = [];
    class HostDate extends Date { static now() { return now; } }
    const hostWindow = {
        setTimeout: (callback, delay) => {const id = ++timerId; timers.set(id, {callback, delay}); return id;},
        clearTimeout: (id) => timers.delete(id), getSelection: () => null,
    };
    const api = {
        Plugin: class {constructor() {this.name = "test"; this.app = {};}},
        Menu: class {constructor() {this.items = []; menus.push(this);} addItem(item) {this.items.push(item);} open() {}},
        getAllEditor: () => editors,
        getActiveEditor: () => active,
        getFrontend: () => "desktop",
        openTab: async ({doc}) => opens.push(doc.id),
        showMessage: (message) => messages.push(message),
        confirm: (title, text, callback) => confirmations.push({title, text, callback}),
        fetchSyncPost: async (url, args) => {
            requests.push({url, args});
            if (url === "/api/block/getBlockDOM") return {code: 0, data: {dom: documentDOM}};
            return {code: 0, data: typeof sqlRows === "function" ? await sqlRows(args.stmt) : sqlRows};
        },
    };
    const Plugin = compile("index.ts", {siyuan: api, "./definitions": definitions, "./inline": compile("inline.ts", {}),
        "./manager": {FootnoteManager: class {}}, "./index.scss": {}}, {
        document, window: hostWindow, Date: HostDate, Node: window.Node, HTMLElement: window.HTMLElement,
        NodeFilter: {SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2},
    }).default;
    const plugin = new Plugin();
    plugin.positionTooltip = () => {};
    const addEditor = (rootID, html = "") => {
        const element = document.createElement("div");
        element.className = "protyle-wysiwyg";
        element.innerHTML = html;
        document.body.append(element);
        const editor = {protyle: {block: {rootID}, wysiwyg: {element}},
            transaction: (forward, undo) => transactions.push({forward, undo})};
        editors.push(editor);
        active = editor;
        plugin.registerEditor(editor.protyle);
        return element;
    };
    return {plugin, document, addEditor, messages, opens, menus, confirmations, transactions, requests, timers, api,
        setDOM: (html) => {documentDOM = html;}, setRows: (rows) => {sqlRows = rows;},
        advance: (ms) => {now += ms;}, setActive: (index) => {active = editors[index];},
        runTimer: (id) => {const timer = timers.get(id); timers.delete(id); timer?.callback();}};
}

test("duplicate definitions survive SQL page boundaries with stable candidates", async () => {
    const rows = Array.from({length: 257}, (_, i) => ({id: String(i).padStart(5, "0"),
        content: `[^${i === 256 ? 0 : i}]: note ${i}`}));
    const result = await definitions.readDocumentDefinitions("doc", async (stmt) => {
        const cursor = stmt.match(/AND id > '([^']*)'/)[1];
        return rows.filter((row) => row.id > cursor).slice(0, 256);
    });
    assert.deepEqual(Array.from(result.get("0").candidates, (candidate) => candidate.blockId), ["00000", "00256"]);
});

test("loading, editing and renaming duplicates do not hide the unloaded candidate", async () => {
    const h = host();
    h.setRows([{id: "a", content: "[^1]: first"}, {id: "b", content: "[^1]: second"}]);
    const editor = h.addEditor("doc", block("a", "[^1]: edited"));
    await h.plugin.ensureDocumentDefinitions("doc");
    assert.equal(h.plugin.collectDefinitions(editor).get("1").candidates.length, 2);
    editor.querySelector('[contenteditable="true"]').textContent = "[^2]: renamed";
    const merged = h.plugin.collectDefinitions(editor);
    assert.equal(merged.get("1").blockId, "b");
    assert.equal(merged.get("1").candidates, undefined);
    assert.equal(merged.get("2").content, "renamed");
});

test("duplicate markers warn and offer explicit navigation; code and containers are not definitions", async () => {
    const h = host();
    const editor = h.addEditor("doc", block("body", "正文 [^1]")
        + `<div data-node-id="list" data-type="NodeList">${block("a", "[^1]: first")}</div>`
        + block("b", "[^1]: &lt;img src=x onerror=alert(1)&gt;")
        + block("code", "[^1]: code", "NodeCodeBlock"));
    h.setRows([]);
    const defs = h.plugin.collectDefinitions(editor);
    assert.equal(defs.get("1").candidates.length, 2);
    h.plugin.wrapReferences(editor.querySelector('[data-node-id="body"]'), defs);
    const ref = editor.querySelector(".siyuan-footnote-ref");
    assert.equal(ref.classList.contains("siyuan-footnote-ref--conflict"), true);
    assert.match(ref.dataset.preview, /重复（2 处）/);
    ref.getBoundingClientRect = () => ({left: 0, bottom: 0});
    await h.plugin.jumpToDefinition("1", ref);
    assert.equal(h.opens.length, 0);
    assert.equal(h.menus[0].items.length, 2);
    assert.ok(h.menus[0].items[1].label.includes("&lt;img"));
    h.menus[0].items[1].click();
    await Promise.resolve();
    assert.deepEqual(h.opens, ["b"]);
});

test("full-document conversion covers unloaded nested paragraphs and cleans undo DOM", async () => {
    const h = host();
    const loaded = block("body", '最新 <span class="siyuan-footnote-ref" data-siyuan-footnote-enhanced="true" data-footnote-id="1">[^1]</span> 和 [^missing]');
    const editor = h.addEditor("doc", loaded);
    const html = block("body", "旧正文 [^1]")
        + `<div data-node-id="list" data-type="NodeList">${block("unloaded", "未加载 [^1]")}</div>`
        + block("definition", "[^1]: note") + block("code", "[^1]", "NodeCodeBlock")
        + block("existing", '<span data-type="block-ref" data-id="definition">[^1]</span>');
    h.setDOM(html);
    await h.plugin.confirmAddNativeBlockRefs();
    assert.equal(h.confirmations.length, 1);
    assert.match(h.confirmations[0].text, /2 个脚注标记/);
    assert.match(h.confirmations[0].text, /尚未加载/);
    assert.equal(h.transactions.length, 0);
    const reviewed = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
    await h.plugin.addNativeBlockRefs("doc", reviewed);
    const transaction = h.transactions[0];
    assert.deepEqual(Array.from(transaction.forward, (operation) => operation.id), ["body", "unloaded"]);
    assert.equal(transaction.undo.length, 2);
    assert.match(transaction.forward[0].data, /最新/);
    assert.match(transaction.forward[0].data, /data-type="block-ref"/);
    assert.match(transaction.forward[0].data, /\[\^missing\]/);
    for (const operation of [...transaction.forward, ...transaction.undo]) {
        assert.doesNotMatch(operation.data, /siyuan-footnote|data-footnote/);
    }
    assert.match(transaction.undo[0].data, /最新 \[\^1\]/);
    assert.equal(editor.innerHTML, loaded);
});

test("conversion skips conflicting labels and leaves definition blocks unchanged", async () => {
    const h = host();
    const editor = h.addEditor("doc");
    h.setDOM(block("body", "[^1] [^2] [^missing]") + block("a", "[^1]: first")
        + block("b", "[^1]: second") + block("c", "[^2]: unique"));
    const updates = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].referenceCount, 1);
    assert.match(updates[0].operation.data, /\[\^1\]/);
    assert.match(updates[0].operation.data, /data-id="c"/);
});

test("embedded document text cannot supply definitions or enter a full-document transaction", async () => {
    const h = host();
    const embedded = `<div data-node-id="embed" data-type="NodeBlockQueryEmbed">`
        + block("foreign-definition", "[^1]: other document") + block("foreign-body", "[^2]") + "</div>";
    const editor = h.addEditor("doc", block("body", "[^1] [^2]") + embedded);
    h.setDOM(block("body", "[^1] [^2]") + block("own-definition", "[^2]: own note"));
    assert.equal(h.plugin.collectDefinitions(editor).has("1"), false);
    const foreign = editor.querySelector('[data-node-id="foreign-body"]');
    h.plugin.wrapReferences(foreign, h.plugin.collectDefinitions(editor));
    assert.equal(foreign.querySelector(".siyuan-footnote-ref"), null);
    const updates = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].operation.id, "body");
    assert.equal(updates[0].referenceCount, 1);
});

test("virtualized tables use complete kernel rows; editing tables prevents stale overwrites", async () => {
    const h = host();
    const table = (cells) => block("table", `<table><tbody>${cells}</tbody></table>`, "NodeTable");
    const row = (text) => `<tr><td>${text}</td></tr>`;
    const editor = h.addEditor("doc", table(row("first [^1]")));
    h.setDOM(table(row("first [^1]") + row("unloaded row [^1]")) + block("def", "[^1]: note"));
    const updates = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
    assert.equal(updates[0].referenceCount, 2);
    assert.match(updates[0].operation.data, /unloaded row/);
    h.plugin.activeBlock = editor.firstElementChild;
    await assert.rejects(h.plugin.readDocumentBlocks("doc", editor), /结束表格编辑/);
    assert.equal(h.transactions.length, 0);
});

test("confirmation rechecks changed body and changed targets before submitting any transaction", async () => {
    for (const change of ["body", "target"]) {
        const h = host();
        const editor = h.addEditor("doc");
        h.setDOM(block("body", "[^1]") + block("a", "[^1]: original"));
        const reviewed = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
        h.setDOM(change === "body" ? block("body", "edited [^1]") + block("a", "[^1]: original")
            : block("body", "[^1]") + block("b", "[^1]: replacement"));
        await h.plugin.addNativeBlockRefs("doc", reviewed);
        assert.equal(h.transactions.length, 0);
        assert.match(h.messages[0], /已改变/);
        assert.equal(h.plugin.isAddingNativeBlockRefs, false);
    }
});

test("switching editors during full-document preparation or confirmation prevents writes", async () => {
    const h = host();
    const editor = h.addEditor("doc");
    h.setDOM(block("body", "[^1]") + block("a", "[^1]: note"));
    const reviewed = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
    let finish;
    h.api.fetchSyncPost = async () => new Promise((resolve) => {finish = resolve;});
    const applying = h.plugin.addNativeBlockRefs("doc", reviewed);
    h.addEditor("other");
    finish({code: 0, data: {dom: block("body", "[^1]") + block("a", "[^1]: note")}});
    await applying;
    assert.equal(h.transactions.length, 0);
    assert.equal(h.plugin.isAddingNativeBlockRefs, false);
});

test("body updates keep both definition caches and refresh only the affected editor", async () => {
    const h = host();
    const a = h.addEditor("A", block("body-a", "plain text"));
    const b = h.addEditor("B", block("body-b", "other text"));
    await Promise.all([h.plugin.ensureDocumentDefinitions("A"), h.plugin.ensureDocumentDefinitions("B")]);
    const aCache = h.plugin.documentDefinitions.get("A"), bCache = h.plugin.documentDefinitions.get("B");
    h.plugin.definitionDirtyRoots.clear();
    h.plugin.dirtyBlocks.clear();
    const scanned = [];
    const collect = h.plugin.collectDefinitions.bind(h.plugin);
    h.plugin.collectDefinitions = (element) => {scanned.push(element); return collect(element);};
    h.plugin.handleKernelMessage({detail: {cmd: "transactions", data: [{rootID: "A", doOperations: [
        {action: "update", id: "body-a", data: block("body-a", "new text")},
    ]}]}});
    h.plugin.refresh();
    assert.equal(h.plugin.documentDefinitions.get("A"), aCache);
    assert.equal(h.plugin.documentDefinitions.get("B"), bCache);
    assert.deepEqual(scanned, [a]);
    assert.equal(h.plugin.dirtyBlocks.has(b.firstElementChild), false);
    assert.equal(h.requests.filter(({url}) => url === "/api/query/sql").length, 2);
});

test("definition changes invalidate only their document; unknown and sync messages invalidate all", async () => {
    const h = host();
    h.addEditor("A", block("def-a", "[^1]: A"));
    h.addEditor("B", block("def-b", "[^1]: B"));
    h.setRows((stmt) => [{id: stmt.includes("'A'") ? "def-a" : "def-b", content: "[^1]: indexed"}]);
    await Promise.all([h.plugin.ensureDocumentDefinitions("A"), h.plugin.ensureDocumentDefinitions("B")]);
    const bCache = h.plugin.documentDefinitions.get("B");
    h.plugin.handleKernelMessage({detail: {cmd: "transactions", data: [{doOperations: [
        {action: "update", id: "def-a", data: block("def-a", "ordinary text")},
    ]}]}});
    assert.equal(h.plugin.documentDefinitions.has("A"), false);
    assert.equal(h.plugin.documentDefinitions.get("B"), bCache);
    await h.plugin.ensureDocumentDefinitions("A");
    h.plugin.handleKernelMessage({detail: {cmd: "transactions", data: [{doOperations: [{action: "delete", id: "unknown"}]}]}});
    assert.equal(h.plugin.documentDefinitions.size, 0);
    await Promise.all([h.plugin.ensureDocumentDefinitions("A"), h.plugin.ensureDocumentDefinitions("B")]);
    h.plugin.handleKernelMessage({detail: {cmd: "syncFinish"}});
    assert.equal(h.plugin.documentDefinitions.size, 0);
});

test("early SQL responses retain an automatic delayed requery after indexing catches up", async () => {
    const h = host();
    h.addEditor("doc", block("body", "plain text"));
    h.setRows([{id: "tail", content: "[^1]: old"}]);
    await h.plugin.ensureDocumentDefinitions("doc");
    h.plugin.handleKernelMessage({detail: {cmd: "transactions"}});
    await h.plugin.ensureDocumentDefinitions("doc");
    h.runTimer(h.plugin.refreshTimer);
    assert.ok(h.plugin.refreshTimer);
    assert.equal(h.timers.get(h.plugin.refreshTimer).delay, 1000);
    h.setRows([{id: "tail", content: "[^2]: renamed"}]);
    h.advance(1001);
    h.runTimer(h.plugin.refreshTimer);
    await h.plugin.ensureDocumentDefinitions("doc");
    const stored = h.plugin.documentDefinitions.get("doc").definitions;
    assert.equal(stored.has("1"), false);
    assert.equal(stored.get("2").content, "renamed");
});

test("native footnote styling keeps block identity and is removed from both transaction directions", () => {
    const h = host();
    const editor = h.addEditor("doc", block("body", '<span data-type="block-ref" data-subtype="s" data-id="def">[^1]</span> [^1]'
        + '<span data-type="block-ref" data-id="ordinary">ordinary</span>') + block("def", "[^1]: note"));
    const body = editor.firstElementChild;
    const defs = h.plugin.collectDefinitions(editor);
    h.plugin.styleNativeFootnotes(body, defs);
    assert.equal(body.querySelectorAll(".siyuan-footnote-native-ref").length, 1);
    assert.equal(body.querySelector(".siyuan-footnote-native-ref").dataset.id, "def");
    assert.equal(body.querySelector('[data-id="ordinary"]').className, "");
    const updates = h.plugin.prepareNativeBlockRefUpdates(editor);
    assert.equal(updates.length, 1);
    assert.doesNotMatch(updates[0].operation.data, /siyuan-footnote-native-ref/);
    assert.doesNotMatch(updates[0].undoOperation.data, /siyuan-footnote-native-ref/);
    assert.match(updates[0].undoOperation.data, /data-type="block-ref"/);
    h.plugin.cleanupEnhancements();
    assert.equal(body.querySelectorAll(".siyuan-footnote-native-ref").length, 0);
    assert.equal(body.querySelector('[data-id="def"]').textContent, "[^1]");
});

test("native sidebar edits are excluded from transient enhancement and active-block tracking", () => {
    const h = host();
    const editor = h.addEditor("doc", block("def", "[^1]: note"));
    const wrapper = h.document.createElement("aside");
    wrapper.setAttribute("data-footnote-sidebar", "true");
    editor.replaceWith(wrapper);
    wrapper.append(editor);
    h.plugin.dirtyBlocks.clear();
    h.plugin.markEditorDirty(editor);
    assert.equal(h.plugin.dirtyBlocks.size, 0);
    assert.equal(h.plugin.getBlockFromNode(editor.firstElementChild), undefined);
    h.plugin.handleProtyleLoaded({detail: {protyle: {block: {rootID: "doc"}, wysiwyg: {element: editor}}}});
    assert.equal(h.plugin.dirtyBlocks.size, 0);
});

const tailList = (id = "tail") => `<div data-node-id="${id}" data-type="NodeList" data-subtype="o"><div data-node-id="item" data-type="NodeListItem" data-subtype="o" data-marker="1.">${block("note", "列表脚注")}</div></div>`;

test("numeric native anchors to unloaded footnote items receive the same styling as definition paragraphs", async () => {
    const h = host();
    const body = block("body", '<span data-type="block-ref" data-subtype="s" data-id="item">[1]</span> '
        + '<span data-type="block-ref" data-subtype="d" data-id="note">[1]</span> '
        + '<span data-type="block-ref" data-id="ordinary">[1]</span>');
    h.setDOM(body + tailList()); h.setRows([]);
    const editor = h.addEditor("doc", body);
    await h.plugin.ensureDocumentDefinitions("doc");
    const definitions = h.plugin.collectDefinitions(editor);
    assert.equal(definitions.get("1").itemId, "item");
    h.plugin.styleNativeFootnotes(editor.firstElementChild, definitions);
    assert.deepEqual(Array.from(editor.querySelectorAll(".siyuan-footnote-native-ref"), ref => ref.dataset.id), ["item", "note"]);
    assert.deepEqual(Array.from(editor.querySelectorAll(".siyuan-footnote-native-ref"), ref => ref.textContent), ["[1]", "[1]"]);
    h.plugin.cleanupBlock(editor.firstElementChild);
    assert.equal(editor.querySelector(".siyuan-footnote-native-ref"), null);
    assert.equal(editor.querySelectorAll('[data-type="block-ref"]').length, 3);
});

test("unloaded terminal ordered lists supply previews and native conversion targets", async () => {
    const h = host();
    const html = `<div data-node-id="doc" data-type="NodeDocument">${block("body", "正文 [^1]") + tailList()}</div>`;
    h.setDOM(html); h.setRows([]);
    const editor = h.addEditor("doc", block("body", "正文 [^1]"));
    await h.plugin.ensureDocumentDefinitions("doc");
    const defs = h.plugin.collectDefinitions(editor);
    assert.equal(defs.get("1").content, "列表脚注");
    assert.equal(defs.get("1").blockId, "note");
    const updates = h.plugin.prepareNativeBlockRefUpdates(editor, await h.plugin.readDocumentBlocks("doc", editor));
    assert.equal(updates.length, 1);
    assert.match(updates[0].operation.data, /data-id="note"/);
    await h.plugin.jumpToDefinition("1", editor.firstElementChild);
    assert.equal(h.opens.at(-1), "note");
});

test("paged body lists cannot replace the cached terminal-list index", async () => {
    const h = host(); h.setDOM(block("body", "[^1]") + tailList()); h.setRows([]);
    const editor = h.addEditor("doc", tailList("body-list").replaceAll("note", "ordinary"));
    await h.plugin.ensureDocumentDefinitions("doc");
    assert.equal(h.plugin.collectDefinitions(editor).get("1").blockId, "note");
});

test("explicit definitions suppress terminal-list recognition in complete and paged indexes", async () => {
    const h = host(); h.setDOM(block("literal", "[^1]: 显式脚注") + tailList());
    h.setRows([{id: "literal", content: "[^1]: 显式脚注"}]);
    const editor = h.addEditor("doc", tailList());
    await h.plugin.ensureDocumentDefinitions("doc");
    const defs = h.plugin.collectDefinitions(editor);
    assert.equal(defs.size, 1); assert.equal(defs.get("1").blockId, "literal");
    assert.equal(defs.get("1").candidates, undefined);
});

test("split rich markers each become one live reference and retain formatting after cleanup", () => {
    const h = host();
    const editor = h.addEditor("doc", block("body", '前 <b data-type="strong">字 [^1</b><i>]</i> 中 [<b>^1</b>] 后 [^1]')
        + block("d", "[^1]: note"));
    const body = editor.querySelector('[data-node-id="body"]');
    const before = body.textContent;
    const formatting = () => Array.from(body.querySelectorAll("b, i"), node => node.textContent).join("");
    const styledText = formatting();
    h.plugin.wrapReferences(body, h.plugin.collectDefinitions(editor));
    const refs = Array.from(body.querySelectorAll(".siyuan-footnote-ref"));
    assert.equal(refs.length, 3);
    assert.deepEqual(refs.map(r => r.textContent), ["[^1]", "[^1]", "[^1]"]);
    assert.ok(refs.every(r => r.dataset.preview === "note"));
    assert.equal(body.textContent, before);
    assert.equal(formatting(), styledText);
    h.plugin.cleanupBlock(body);
    assert.equal(body.querySelector(".siyuan-footnote-ref"), null);
    assert.equal(body.textContent, before);
    assert.equal(formatting(), styledText);
    h.plugin.wrapReferences(body, h.plugin.collectDefinitions(editor));
    assert.equal(body.querySelectorAll(".siyuan-footnote-ref").length, 3);
    assert.equal(h.plugin.convertFootnoteMarkersToNativeRefs(body, h.plugin.collectDefinitions(editor)), 3);
    assert.deepEqual(Array.from(body.querySelectorAll('[data-type="block-ref"]'), r => [r.dataset.id, r.textContent]),
        [["d", "[1]"], ["d", "[1]"], ["d", "[1]"]]);
    assert.equal(body.textContent, before.replace(/\[\^1\]/g, "[1]"));
});

test("live parsing does not join markers across code, cells, line breaks or native refs", () => {
    const h = host();
    const editor = h.addEditor("doc", block("body", '[^<code>1</code>] [^<br>1] [^<span data-type="block-ref" data-id="ordinary">1</span>]')
        + block("table", '<table><tr><td>[^</td><td>1]</td><td>[^<b>1</b>]</td></tr></table>', "NodeTable")
        + block("d", "[^1]: note"));
    const definitions = h.plugin.collectDefinitions(editor);
    const body = editor.querySelector('[data-node-id="body"]');
    h.plugin.wrapReferences(body, definitions);
    assert.equal(body.querySelectorAll(".siyuan-footnote-ref").length, 0);
    assert.equal(h.plugin.convertFootnoteMarkersToNativeRefs(body, definitions), 0);
    const table = editor.querySelector('[data-node-id="table"]');
    h.plugin.wrapReferences(table, definitions);
    assert.equal(table.querySelectorAll(".siyuan-footnote-ref").length, 1);
    assert.equal(h.plugin.convertFootnoteMarkersToNativeRefs(table, definitions), 1);
});
