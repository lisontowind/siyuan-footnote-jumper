// Optional real-browser regression. The SiYuan editor/kernel are host doubles;
// DOM Range, focus, visibility and layout are provided by Chromium.
// FOOTNOTE_PLAYWRIGHT may point to an existing bundled Playwright package.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");
const {chromium} = require(process.env.FOOTNOTE_PLAYWRIGHT || "playwright");
const workspace = path.resolve(__dirname, "..");
const artifacts = process.env.FOOTNOTE_BROWSER_ARTIFACTS || path.join(workspace, "dist", "browser-check");

const modules = Object.fromEntries(["inline", "definitions", "document", "sidebar", "manager", "index"].map(name => ["./" + name,
    ts.transpileModule(fs.readFileSync(path.join(workspace, "src", name + ".ts"), "utf8"), {
        compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
    }).outputText]));

function setupHost(modules) {
    const cache = {};
    const h = window.h = {messages: [], confirmations: [], transactions: [], nativeEditors: [], opened: [],
        frontend: "desktop", defer: false, finish: undefined, listeners: new Map()};
    h.block = (id, text, type = "NodeParagraph", attrs = "") => `<div data-node-id="${id}" data-type="${type}" ${attrs}><div contenteditable="true">${text}</div><div class="protyle-attr" contenteditable="false"></div></div>`;
    h.kernel = document.createElement("div");
    h.mainElement = document.querySelector(".main");
    let id = 0;
    const find = (container, id) => Array.from(container.querySelectorAll("[data-node-id]")).find(node => node.dataset.nodeId === id);
    const apply = (container, operations, kernel) => {
        for (const op of operations) {
            const existing = find(container, op.id);
            if (op.action === "delete") existing?.remove();
            else if (op.action === "update") {
                if (!existing) continue;
                // SiYuan expects callers to update the currently edited block
                // locally; transactions only refresh its other DOM copies.
                const selection = getSelection();
                if (!kernel && selection.rangeCount && existing.contains(selection.getRangeAt(0).startContainer)) continue;
                const template = document.createElement("template"); template.innerHTML = op.data;
                existing.replaceWith(template.content);
            } else if (op.action === "insert") {
                if (existing) continue;
                const template = document.createElement("template"); template.innerHTML = op.data;
                const previous = find(container, op.previousID);
                const next = find(container, op.nextID);
                const parent = find(container, op.parentID) || container;
                const selection = getSelection();
                if (previous && !kernel && selection.rangeCount && previous.contains(selection.getRangeAt(0).startContainer)) continue;
                if (previous) previous.after(template.content);
                else if (next) next.before(template.content);
                else if (kernel || !op.previousID) parent.append(template.content);
            } else if (op.action === "move" && existing) {
                const previous = find(container, op.previousID);
                const parent = find(container, op.parentID) || container;
                if (previous) previous.after(existing);
                else parent.insertBefore(existing, parent.firstChild);
            }
        }
    };
    h.main = {protyle: {block: {rootID: "doc"}, wysiwyg: {element: h.mainElement, lastHTMLs: {}}, disabled: false,
        title: {editElement: {textContent: "脚注回归文档"}}}, transaction(forward, undo) {
        h.transactions.push({forward, undo});
        apply(h.kernel, forward, true); apply(h.mainElement, forward, false);
        for (const cb of h.listeners.get("ws-main") || []) cb({detail: {cmd: "transactions"}});
    }};
    h.main.protyle.getInstance = () => h.main;
    h.replay = operations => {
        apply(h.kernel, operations, true);
        apply(h.mainElement, operations, true);
        h.main.protyle.wysiwyg.lastHTMLs = {};
    };
    h.replay = operations => {
        apply(h.kernel, operations, true);
        apply(h.mainElement, operations, true);
        h.main.protyle.wysiwyg.lastHTMLs = {};
    };
    h.active = h.main;
    h.editors = [h.main];
    class Protyle {
        constructor(app, element, options) {
            this.options = options;
            const wysiwyg = document.createElement("div");
            wysiwyg.className = "protyle-wysiwyg";
            wysiwyg.innerHTML = find(h.kernel, options.blockId)?.outerHTML || h.block(options.blockId, "");
            element.append(wysiwyg);
            this.protyle = {block: {rootID: options.rootId}, wysiwyg: {element: wysiwyg}, getInstance: () => this};
            h.nativeEditors.push(this);
            h.editors.push(this);
            wysiwyg.addEventListener("focusin", () => {h.active = this;});
            wysiwyg.addEventListener("input", () => {
                const block = wysiwyg.querySelector("[data-node-id]");
                find(h.kernel, block.dataset.nodeId)?.replaceWith(block.cloneNode(true));
            });
            setTimeout(() => options.after?.(this), 0);
        }
        destroy() {this.destroyed = true; this.protyle.wysiwyg.element.remove();}
        disable() {this.protyle.disabled = true; this.protyle.wysiwyg.element.querySelector('[contenteditable="true"]').contentEditable = "false";}
        enable() {this.protyle.disabled = false; this.protyle.wysiwyg.element.querySelector('[contenteditable]').contentEditable = "true";}
        resize() {}
        focusBlock(block) {
            const editable = block.querySelector('[contenteditable="true"]');
            editable.focus(); const range = document.createRange(); range.selectNodeContents(editable); range.collapse(false);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }
    }
    // Match the real plugin runtime: Lute is global, not a siyuan module export.
    window.Lute = {NewNodeID: () => `new-${++id}`};
    h.api = {Protyle, Plugin: class {constructor() {this.name = "test"; this.app = {};}}, getActiveEditor: () => h.active,
        getAllEditor: () => h.editors.filter(editor => !editor.destroyed), getFrontend: () => h.frontend,
        showMessage: text => h.messages.push(text), confirm: (title, text, callback) => h.confirmations.push({title, text, callback}),
        fetchSyncPost: async url => {
            if (url === "/api/query/sql") return {code: 0, data: []};
            if (h.defer) return new Promise(resolve => {h.finish = () => {h.defer = false; resolve({code: 0, data: {dom: h.kernel.innerHTML}});};});
            return {code: 0, data: {dom: h.kernel.innerHTML}};
        }};
    const load = name => {
        if (name === "siyuan") return h.api;
        if (name === "./index.scss") return {};
        if (!cache[name]) {
            const exports = cache[name] = {};
            new Function("require", "exports", modules[name])(load, exports);
        }
        return cache[name];
    };
    window.siyuan = {config: {readonly: false}, layout: {rightDock: {data: {testfootnotes: false}, toggleModel() {
        document.querySelector("#dock").style.display = "flex";
    }}}};
    h.plugin = {name: "test", app: {}, eventBus: {
        on(name, cb) {if (!h.listeners.has(name)) h.listeners.set(name, new Set()); h.listeners.get(name).add(cb);},
        off(name, cb) {h.listeners.get(name)?.delete(cb);}},
        addDock(options) {h.dock = options; options.init({element: document.querySelector("#dock")});}};
    h.manager = new (load("./manager").FootnoteManager)(h.plugin, {
        navigate: async id => h.opened.push(id), tablePending: () => false, changed: () => {}});
    h.jumper = new (load("./index").default)();
    h.mainElement.addEventListener("focusin", () => {h.active = h.main;});
    h.reset = async (html, loaded = html) => {
        id = 0;
        h.manager.previousLabels.clear();
        h.mainElement.innerHTML = loaded; h.kernel.innerHTML = html;
        h.active = h.main; h.transactions = []; h.confirmations = []; h.messages = [];
        h.manager.main = h.main; h.manager.pendingSelection = undefined;
        await h.manager.refresh();
    };
    h.command = (start, end) => {
        const editable = h.mainElement.querySelector('[contenteditable="true"]');
        editable.focus();
        const range = document.createRange(); range.setStart(editable.firstChild, start); range.setEnd(editable.firstChild, end);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        h.main.protyle.toolbar = {range};
    };
    h.manager.register();
}

(async () => {
    fs.mkdirSync(artifacts, {recursive: true});
    const browser = await chromium.launch({headless: true, executablePath: process.env.FOOTNOTE_BROWSER_EXECUTABLE});
    try {
        const page = await browser.newPage({viewport: {width: 1100, height: 850}});
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(`<html lang="zh-CN"><style>
            :root{--b3-theme-on-background:#242a35;--b3-theme-background:#fff;--b3-theme-on-surface:#667085;--b3-theme-primary:#4563cf;--b3-theme-primary-light:#a2b2f4;--b3-theme-primary-lightest:#eef2ff;--b3-theme-surface:#f5f6f8;--b3-border-color:#e3e6eb;--b3-theme-error:#c73b45}
            *{box-sizing:border-box}body{margin:0;font:14px sans-serif;display:flex;height:100vh}.main{flex:1;padding:32px;overflow:auto}.main>[data-node-id]{padding:12px;line-height:1.8}#dock{width:360px;border-left:1px solid #ddd}.block__icons{display:flex;align-items:center;padding:10px;gap:8px}.block__logo{display:flex;align-items:center;gap:5px;font-weight:600}svg{width:16px;height:16px}.fn__flex-1{flex:1}.block__icon{cursor:pointer}.b3-button{padding:6px 10px;border:1px solid #a2b2f4;color:#4563cf;background:#fff;border-radius:4px}.b3-select{padding:4px}.protyle-wysiwyg [contenteditable]{outline:none}.protyle-attr{display:none}
        </style><main class="main protyle-wysiwyg"></main><aside id="dock"></aside></html>`);
        await page.addStyleTag({content: fs.readFileSync(path.join(workspace, "dist", "index.css"), "utf8")});
        await page.evaluate(setupHost, modules);

        // Exercise transient rich markers and caret restoration in a real DOM.
        await page.evaluate(() => {
            h.mainElement.innerHTML = h.block("rich", '前 <b>字 [^1</b><i>]</i> 中 [<b>^1</b>] 后 [^1]') + h.block("d", "[^1]: 内容");
            const block = h.mainElement.firstElementChild;
            const text = block.textContent;
            const styled = () => Array.from(block.querySelectorAll("b, i"), node => node.textContent).join("");
            const formatting = styled();
            const tail = block.querySelector('[contenteditable]').lastChild;
            const range = document.createRange(); range.setStart(tail, tail.length); range.collapse(true);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            const bookmark = h.jumper.captureSelection(block);
            const definitions = h.jumper.collectDefinitions(h.mainElement);
            h.jumper.wrapReferences(block, definitions);
            const refs = Array.from(block.querySelectorAll(".siyuan-footnote-ref"));
            if (refs.length !== 3 || refs.some(ref => ref.textContent !== "[^1]")) throw Error("Split markers were not grouped");
            if (styled() !== formatting || block.textContent !== text) throw Error("Rich marker formatting changed");
            h.jumper.restoreSelection(block, bookmark);
            if (h.jumper.captureSelection(block).start !== bookmark.start) throw Error("Rich marker caret moved");
            h.jumper.cleanupBlock(block);
            if (styled() !== formatting || block.textContent !== text) throw Error("Cleanup lost rich marker formatting");
            if (h.jumper.convertFootnoteMarkersToNativeRefs(block, definitions) !== 3) throw Error("Split markers were not converted");
            if (Array.from(block.querySelectorAll('[data-type="block-ref"]')).some(ref => ref.textContent !== "[1]")) {
                throw Error("Static refs must use plain brackets");
            }
        });

        await page.evaluate(async () => {
            await h.reset(h.block("body", "第一段 [^B] 和 [^B]，接着 [^A]。") + h.block("second", "第二段 [^A]。")
                + h.block("a", '[^A]: <b>保留加粗</b>和<a href="https://example.test">链接</a>。')
                + h.block("b", "[^B]: 第二个定义。") + h.block("unused", "[^unused]: 未引用的说明。"));
        });
        await page.waitForFunction(() => h.nativeEditors.length === 1);
        const layout = await page.evaluate(() => ({width: document.querySelector("#dock").getBoundingClientRect().width,
            overflow: document.querySelector("#dock").scrollWidth > document.querySelector("#dock").clientWidth}));
        assert.equal(layout.width, 360); assert.equal(layout.overflow, false);
        await page.screenshot({path: path.join(artifacts, "sidebar-desktop.png")});
        const nativeCount = await page.evaluate(() => h.nativeEditors.length);
        await page.locator('[data-note-key="b"]').click();
        await page.evaluate(() => h.manager.refresh());
        assert.equal(await page.evaluate(() => h.nativeEditors.length), nativeCount);
        await page.locator('[data-block-id="body"]').click();
        assert.equal(await page.evaluate(() => h.opened[0]), "body");

        await page.evaluate(() => h.manager.normalize({format: "block", renumber: true}));
        await page.evaluate(() => h.confirmations[0].callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /\[\^1\]: 第二个定义/);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /<b>保留加粗<\/b>/);

        // Number-only anchors may target the item itself, not its paragraph.
        await page.evaluate(async () => {
            const item = (id, number) => `<div data-node-id="li-${id}" data-type="NodeListItem" data-subtype="o" data-marker="${number}.">${h.block(id, id)}</div>`;
            h.numericOriginal = h.block("body", '<span data-type="block-ref" data-subtype="s" data-id="li-b">[2]</span> '
                + '<span data-type="block-ref" data-subtype="d" data-id="a">[1]</span>')
                + `<div data-node-id="tail" data-type="NodeList" data-subtype="o">${item("a", 1)}${item("b", 2)}</div>`;
            await h.reset(h.numericOriginal);
        });
        assert.match(await page.locator('[data-note-key="b"]').textContent(), /1 处引用/);
        assert.match(await page.locator('[data-block-id="body"]').textContent(), /1 次/);
        await page.evaluate(() => h.manager.normalize({format: "keep", renumber: true, definitionFormat: "literal"}));
        await page.evaluate(() => h.confirmations[0].callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.deepEqual(await page.evaluate(() => Array.from(h.kernel.querySelectorAll('[data-type="block-ref"]'),
            node => [node.dataset.id, node.textContent])), [["b", "[1]"], ["a", "[2]"]]);
        await page.evaluate(() => h.replay(h.transactions[0].undo));
        assert.deepEqual(await page.evaluate(() => Array.from(h.kernel.querySelectorAll('[data-type="block-ref"]'),
            node => [node.dataset.id, node.textContent])), [["li-b", "[2]"], ["a", "[1]"]]);

        // Both definition formats and the explicit number-refresh flow.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 [^A] 后 [^B]")
                + h.block("a", "[^A]: <b>A 内容</b>") + h.block("b", "[^B]: B 内容"));
        });
        await page.locator('[data-definition-format]').selectOption("list");
        await page.locator('[data-action="normalize"]').click();
        await page.waitForFunction(() => h.confirmations.length === 1);
        await page.evaluate(() => h.confirmations[0].callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        const listResult = await page.evaluate(() => h.kernel.innerHTML);
        assert.match(listResult, /data-type="NodeList"/);
        assert.doesNotMatch(listResult, /\[\^[^\]]+\]:/);
        assert.match(listResult, /<b>A 内容<\/b>/);
        await page.evaluate(async () => {
            for (const root of [h.kernel, h.mainElement]) {
                const list = root.querySelector('[data-type="NodeList"]');
                const items = Array.from(list.children).filter(node => node.dataset.type === "NodeListItem");
                list.insertBefore(items[1], items[0]);
                Array.from(list.children).filter(node => node.dataset.type === "NodeListItem").forEach((item, i) => {
                    item.dataset.marker = `${i + 1}.`; item.querySelector('.protyle-action').textContent = `${i + 1}.`;
                });
            }
            await h.manager.refresh();
        });
        await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("序号已变化"));
        await page.locator('[data-action="refresh-numbers"]').click();
        await page.waitForFunction(() => h.confirmations.length === 2);
        await page.evaluate(() => h.confirmations[1].callback());
        await page.waitForFunction(() => h.transactions.length === 2);
        assert.deepEqual(await page.evaluate(() => Array.from(h.kernel.querySelectorAll('[data-type="block-ref"]'),
            node => [node.dataset.id, node.textContent])), [["a", "[2]"], ["b", "[1]"]]);
        await page.evaluate(() => h.manager.refresh());
        assert.equal(await page.locator('[data-action="refresh-numbers"]').isVisible(), false);
        await page.screenshot({path: path.join(artifacts, "ordered-footnotes.png")});
        await page.locator('[data-definition-format]').selectOption("literal");
        await page.locator('[data-action="normalize"]').click();
        await page.waitForFunction(() => h.confirmations.length === 3);
        await page.evaluate(() => h.confirmations[2].callback());
        await page.waitForFunction(() => h.transactions.length === 3);
        assert.equal(await page.evaluate(() => h.kernel.querySelector('[data-type="NodeList"]')), null);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /\[\^1\]: <b>A 内容<\/b>/);

        // Real Range: insert at a nonzero position in an existing paragraph.
        assert.equal(await page.evaluate(() => h.api.Lute), undefined);
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 /脚注 末尾") + h.block("a", "[^1]: 已有脚注。"));
            h.command(3, 6);
            await h.plugin.protyleSlash[0].callback(h.main, h.mainElement.firstElementChild);
        });
        assert.deepEqual(await page.evaluate(() => h.messages.filter(message => /NewNodeID|生成器/.test(message))), []);
        await page.waitForFunction(() => h.transactions.length === 1);
        const visibleMarker = await page.evaluate(() => h.mainElement.querySelector('[data-type="block-ref"][data-id="new-1"]')?.textContent);
        assert.equal(visibleMarker, "[2]", "The edited paragraph must show the inserted footnote without reloading");
        assert.doesNotMatch(await page.evaluate(() => h.mainElement.textContent), /\/脚注/);
        assert.match(await page.evaluate(() => h.main.protyle.wysiwyg.lastHTMLs.body), /\[2\]/);
        await page.evaluate(() => h.manager.refresh());
        await page.waitForFunction(() => h.nativeEditors.at(-1).options.blockId === "new-1" && document.activeElement.closest('[data-footnote-sidebar]'));
        const insertion = await page.evaluate(() => ({html: h.kernel.innerHTML, tx: h.transactions[0]}));
        assert.equal(insertion.tx.forward.length, 3);
        assert.equal(insertion.tx.undo.length, 3);
        assert.match(insertion.html, /正文 <span[^>]+data-id="new-1"[^>]*>\[2\]<\/span> 末尾/);
        await page.evaluate(() => h.replay(h.transactions[0].undo));
        assert.match(await page.evaluate(() => h.mainElement.textContent), /正文 \/脚注 末尾/);
        assert.equal(await page.evaluate(() => h.mainElement.querySelector('[data-id="new-1"]')), null);
        await page.evaluate(() => h.replay(h.transactions[0].forward));
        assert.equal(await page.evaluate(() => h.mainElement.querySelectorAll('[data-id="new-1"]').length), 1);

        // When the source is the document's last block, the host also skips
        // inserting after the active paragraph. Both new blocks must exist locally.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "末段 /jz"));
            h.command(3, 6);
            await h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.querySelectorAll('[data-type="block-ref"]').length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.children.length), 3);
        assert.equal(await page.evaluate(() => h.mainElement.querySelectorAll('[data-type="NodeHeading"]').length), 1);
        assert.doesNotMatch(await page.evaluate(() => h.mainElement.textContent), /\/jz/);
        await page.evaluate(() => h.replay(h.transactions[0].undo));
        assert.equal(await page.evaluate(() => h.mainElement.children.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.textContent), "末段 /jz");

        // Do not append the definition beside the source when the true tail is unloaded.
        await page.evaluate(async () => {
            const source = h.block("body", "正文 /jz");
            await h.reset(source + h.block("unloaded-tail", "未加载的文末"), source);
            h.command(3, 6);
            await h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.children.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.querySelectorAll('[data-type="block-ref"]').length), 1);
        assert.equal(await page.evaluate(() => h.kernel.children.length), 4);

        // A synchronous host failure restores the command, selection and local blocks.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 /jz"));
            h.command(3, 6);
            const transaction = h.main.transaction;
            h.main.transaction = () => {throw new Error("宿主事务提交失败");};
            try {await h.manager.insert(h.main, h.mainElement.firstElementChild);}
            finally {h.main.transaction = transaction;}
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.equal(await page.evaluate(() => h.mainElement.textContent), "正文 /jz");
        assert.equal(await page.evaluate(() => h.mainElement.children.length), 1);
        assert.equal(await page.evaluate(() => getSelection().toString()), "/jz");
        assert.match(await page.evaluate(() => h.messages.at(-1)), /宿主事务提交失败/);

        // An unavailable global generator fails clearly before any transaction.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 /脚注 末尾"));
            h.command(3, 6);
            const lute = window.Lute;
            delete window.Lute;
            try {await h.manager.insert(h.main, h.mainElement.firstElementChild);}
            finally {window.Lute = lute;}
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.match(await page.evaluate(() => h.messages.at(-1)), /生成器尚未就绪/);

        // Move the browser selection while the full-document read is pending.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 /jz 末尾"));
            h.command(3, 6); h.defer = true;
            h.work = h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        await page.waitForFunction(() => Boolean(h.finish));
        await page.evaluate(() => {h.command(0, 0); h.finish();});
        await page.evaluate(() => h.work);
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.match(await page.evaluate(() => h.messages.at(-1)), /光标位置已改变/);

        // Closing releases the native editor; reopening restores the selection.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "[^A]") + h.block("a", "[^A]: note"));
            document.querySelector("#dock").style.display = "none";
        });
        await page.waitForFunction(() => h.manager.sidebar.protyle === undefined);
        await page.evaluate(() => h.manager.open());
        await page.waitForFunction(() => Boolean(h.manager.sidebar.protyle));

        // Optionally verify the actual Lute shipped with an installed SiYuan.
        if (process.env.FOOTNOTE_LUTE_SCRIPT) {
            await page.addScriptTag({content: fs.readFileSync(process.env.FOOTNOTE_LUTE_SCRIPT, "utf8")});
            await page.evaluate(async () => {
                await h.reset(h.block("body", "正文 /脚注 末尾"));
                h.command(3, 6);
                await h.manager.insert(h.main, h.mainElement.firstElementChild);
            });
            const tx = await page.evaluate(() => h.transactions[0]);
            assert.ok(tx, "Insertion should use the installed SiYuan Lute without a module export");
            const ids = tx.forward.filter(op => op.action === "insert").map(op => op.id);
            assert.equal(ids.length, 2);
            assert.equal(new Set(ids).size, 2);
            for (const id of ids) assert.match(id, /^\d{14}-[a-z0-9]{7}$/);
            assert.equal(tx.undo.length, 3);
            console.log("Installed SiYuan Lute check passed: real block IDs generated and insertion submitted.");
        }

        await page.setViewportSize({width: 390, height: 844});
        await page.evaluate(() => {
            h.frontend = "browser-mobile";
            document.querySelector(".main").style.display = "none";
            document.querySelector("#dock").style.width = "100%";
            document.documentElement.style.setProperty("--b3-theme-background", "#20252d");
            document.documentElement.style.setProperty("--b3-theme-on-background", "#e7eaf0");
            document.documentElement.style.setProperty("--b3-theme-on-surface", "#adb5c4");
            document.documentElement.style.setProperty("--b3-theme-surface", "#303744");
            document.documentElement.style.setProperty("--b3-theme-primary-lightest", "#303d64");
            document.documentElement.style.setProperty("--b3-theme-primary-light", "#657dc6");
        });
        await page.screenshot({path: path.join(artifacts, "sidebar-mobile-dark.png")});
        assert.equal(await page.evaluate(() => document.querySelector("#dock").scrollWidth > 390), false);
        await page.evaluate(() => {
            const panel = document.createElement("section");
            panel.id = "sidebarRight";
            panel.className = "side-panel";
            panel.style.cssText = "position:fixed;right:0;top:0;width:390px;height:100vh;transform:translateX(100%);background:var(--b3-theme-background)";
            const tabs = document.createElement("div");
            tabs.innerHTML = '<button data-type="sidebar-testfootnotes-tab">脚注</button>';
            tabs.addEventListener("click", event => {h.mobileOpen = event.detail;});
            panel.append(tabs, document.querySelector("#dock"));
            document.body.append(panel);
            h.manager.observeVisibility(); h.manager.updateVisibility();
        });
        await page.waitForFunction(() => h.manager.sidebar.protyle === undefined);
        await page.evaluate(() => h.manager.open());
        await page.waitForFunction(() => h.mobileOpen === "testfootnotes" && Boolean(h.manager.sidebar.protyle));
        await page.evaluate(() => h.manager.destroy());
        assert.equal(errors.length, 0, errors.join("\n"));
        console.log("Browser checks passed: definition format conversion, ordered-list reorder warning and number refresh, Range insertion, caret-change guard, sidebar selection/navigation, normalization, close/reopen, mobile dock opening and 390px layout.");
    } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
