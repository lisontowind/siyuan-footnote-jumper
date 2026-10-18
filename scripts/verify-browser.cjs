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

const modules = Object.fromEntries(["inline", "definitions", "document", "editing", "sidebar", "manager", "index"].map(name => ["./" + name,
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
        const parse = html => {
            const template = document.createElement("template"); template.innerHTML = html;
            if (kernel) for (const anchor of template.content.querySelectorAll('[data-type~="block-ref"]')) {
                // The real kernel clears anchors whose targets do not yet exist.
                if (!find(container, anchor.dataset.id)) {anchor.dataset.id = ""; anchor.dataset.subtype = "";}
            }
            return template;
        };
        for (const op of operations) {
            const existing = find(container, op.id);
            if (op.action === "delete") {if (kernel) existing?.remove();}
            else if (op.action === "update") {
                if (!existing) continue;
                // SiYuan expects callers to update the currently edited block
                // locally; transactions only refresh its other DOM copies.
                const selection = getSelection();
                if (!kernel && selection.rangeCount && existing.contains(selection.getRangeAt(0).startContainer)) continue;
                const template = parse(op.data);
                existing.replaceWith(template.content);
            } else if (op.action === "insert") {
                if (existing) continue;
                const template = parse(op.data);
                const previous = find(container, op.previousID);
                const next = find(container, op.nextID);
                const parent = find(container, op.parentID) || container;
                const selection = getSelection();
                if (previous && !kernel && selection.rangeCount && previous.contains(selection.getRangeAt(0).startContainer)) continue;
                if (previous) previous.after(template.content);
                else if (next) next.before(template.content);
                else if (kernel || !op.previousID) parent.append(template.content);
            } else if (op.action === "move" && existing && kernel) {
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
    h.api = {Protyle,
        Dialog: class {
            constructor(options) {this.options = options; this.element = document.createElement("div");
                this.element.setAttribute("role", "dialog"); this.element.innerHTML = options.content;
                this.element.style.cssText = `position:fixed;z-index:20;top:10%;left:50%;transform:translateX(-50%);width:min(${options.width},95vw);background:white;border:1px solid #ccc;box-shadow:0 10px 50px #0003`;
                document.body.append(this.element); this.element.tabIndex = -1; this.element.focus();}
            destroy() {this.element.remove(); this.options.destroyCallback?.();}
        }, Plugin: class {constructor() {this.name = "test"; this.app = {};}}, getActiveEditor: () => h.active,
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
        jumpEnabled: () => h.jumper.jumpStyleEnabled,
        preferences: () => h.jumper.preferences,
        setPreferences: preferences => h.jumper.setPreferences(preferences),
        liveRefresh: () => h.jumper.liveRefreshEditingBlock,
        setLiveRefresh: enabled => h.jumper.setLiveRefreshEditingBlock(enabled),
        panelAutoRefresh: () => h.jumper?.panelAutoRefresh ?? true,
        setPanelAutoRefresh: enabled => {h.jumper.panelAutoRefresh = enabled; h.jumper.saveSettings();},
        manualRefresh: editor => h.jumper.manualRefresh(editor.protyle),
        checkDuplicates: anchor => h.jumper.checkDuplicateDefinitions(anchor),
        setJumpEnabled: enabled => h.jumper.setEnabled(enabled),
        navigate: async id => h.opened.push(id), tablePending: () => false, changed: () => {}});
    h.jumper = new (load("./index").default)();
    h.jumper.footnoteManager = h.manager;
    h.savedSettings = [];
    h.jumper.saveData = async (name, value) => {h.savedSettings.push({...value});};
    h.mainElement.addEventListener("focusin", () => {h.active = h.main;});
    h.reset = async (html, loaded = html) => {
        h.manager.sidebar.showPanel("notes");
        h.manager.insertionDialog?.destroy();
        id = 0;
        h.manager.sidebar?.invalidateEditor();
        h.manager.previousLabels.clear();
        h.mainElement.innerHTML = loaded; h.kernel.innerHTML = html;
        h.active = h.main; h.transactions = []; h.confirmations = []; h.messages = [];
        h.manager.main = h.main; h.manager.pendingSelection = undefined;
        await h.manager.refresh();
    };
    h.chooseNew = async () => {
        h.manager.insertionDialog?.element.querySelector('[data-picker-create]').click();
        const button = h.manager.insertionDialog?.element.querySelector('[data-picker-submit]');
        if (!button || button.disabled) throw Error("Picker was not ready");
        button.click();
        while (h.manager.busy) await new Promise(resolve => setTimeout(resolve, 0));
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
        const originalEvaluate = page.evaluate.bind(page);
        let evaluateStep = 0;
        page.evaluate = async (expression, arg) => {
            const step = ++evaluateStep;
            let timeout;
            try {return await Promise.race([originalEvaluate(expression, arg), new Promise((_, reject) => {
                timeout = setTimeout(() => reject(Error(`Browser evaluation ${step} timed out: ${String(expression).slice(0, 180)}`)), 15000);
            })]);} finally {clearTimeout(timeout);}
        };
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(`<html lang="zh-CN"><style>
            :root{--b3-theme-on-background:#242a35;--b3-theme-background:#fff;--b3-theme-on-surface:#667085;--b3-theme-primary:#4563cf;--b3-theme-primary-light:#a2b2f4;--b3-theme-primary-lightest:#eef2ff;--b3-theme-surface:#f5f6f8;--b3-border-color:#e3e6eb;--b3-theme-error:#c73b45}
            *{box-sizing:border-box}body{margin:0;font:14px sans-serif;display:flex;height:100vh}.main{flex:1;padding:32px;overflow:auto}.main>[data-node-id]{padding:12px;line-height:1.8}#dock{width:360px;border-left:1px solid #ddd}.block__icons{display:flex;align-items:center;padding:10px;gap:8px}.block__logo{display:flex;align-items:center;gap:5px;font-weight:600}svg{width:16px;height:16px}.fn__flex-1{flex:1}.block__icon{cursor:pointer}.b3-button{padding:6px 10px;border:1px solid #a2b2f4;color:#4563cf;background:#fff;border-radius:4px}.b3-select{padding:4px}.protyle-wysiwyg [contenteditable]{outline:none}.protyle-attr{display:none}
        </style><main class="main protyle-wysiwyg"></main><aside id="dock"></aside></html>`);
        await page.addStyleTag({content: fs.readFileSync(path.join(workspace, "dist", "index.css"), "utf8")});
        // Host styles can hide toolbar buttons until hover, fill SVG paths, and
        // add native checkbox padding. The plugin header must stay self-contained.
        await page.addStyleTag({content: `.block__icons:not(:hover) .block__icon{opacity:0;visibility:hidden} svg{fill:currentColor} input[type="checkbox"]{padding:2px;vertical-align:baseline}`});
        await page.evaluate(setupHost, modules);
        assert.equal(await page.locator('[data-superscript]').isChecked(), true);
        const assertMatchingCards = async () => {
            assert.equal(await page.evaluate(() => {
                const mode = getComputedStyle(document.querySelector('.siyuan-footnote-sidebar__mode'));
                const tools = getComputedStyle(document.querySelector('.siyuan-footnote-sidebar__tools'));
                return ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'paddingTop', 'paddingLeft', 'marginLeft', 'marginRight']
                    .every(property => mode[property] === tools[property])
                    && ['fontSize', 'fontWeight', 'color', 'lineHeight'].every(property =>
                        getComputedStyle(document.querySelector('.siyuan-footnote-sidebar__mode .siyuan-footnote-sidebar__section-title'))[property]
                        === getComputedStyle(document.querySelector('.siyuan-footnote-sidebar__tools .siyuan-footnote-sidebar__section-title'))[property]);
            }), true, 'Reference mode and formatting cards must share their visual styling');
        };
        await assertMatchingCards();
        assert.equal(await page.locator('[data-jump-style]').isVisible(), false);
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole('combobox', {name: '目标脚注写法'}).selectOption('text');

        // Both controls share persisted state. Disabling restores text and
        // native ref styles while preserving native targets and anchors.
        await page.evaluate(async () => {
            const native = '<span data-type="block-ref" data-subtype="s" data-id="d">[1]</span>';
            await h.reset(h.block("body", `正文 [^1] ${native}`) + h.block("d", "[^1]: 内容"));
            h.jumper.registerEditor(h.main.protyle);
            h.jumper.markAllBlocksDirty(); h.jumper.refresh();
            if (!h.mainElement.querySelector('.siyuan-footnote-ref')) throw Error("Text marker not enhanced");
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("switch", {name: "脚注跳转样式"}).uncheck();
        await page.evaluate(async () => {
            h.jumper.refresh();
            if (h.jumper.enabled || h.savedSettings.at(-1).enabled) throw Error("Panel did not persist disabled state");
            if (h.mainElement.querySelector('.siyuan-footnote-ref')) throw Error("Text marker still enhanced");
            const anchor = h.mainElement.querySelector('[data-type~="block-ref"]');
            if (anchor.dataset.id !== "d" || anchor.dataset.subtype !== "s" || anchor.textContent !== "[1]") throw Error("Static target or anchor changed");
            if (anchor.classList.contains('siyuan-footnote-native-ref')) throw Error("Native ref style was not restored");
            const style = getComputedStyle(anchor);
            if (style.verticalAlign !== "baseline" || style.borderBottomStyle !== "none"
                || style.fontSize !== getComputedStyle(anchor.parentElement).fontSize) throw Error("Native ref still uses enhanced style");
            // A later refresh must not reapply plugin styles while disabled.
            h.mainElement.firstElementChild.querySelector('[contenteditable]').innerHTML += ' <span data-type="block-ref" data-subtype="s" data-id="d">[1]</span>';
            h.jumper.markAllBlocksDirty(); h.jumper.refresh();
            if (h.mainElement.querySelector('.siyuan-footnote-native-ref')) throw Error("Disabled style returned after refresh");
            h.jumper.setEnabled(true);
            h.jumper.refresh();
            if (!h.mainElement.querySelector('.siyuan-footnote-ref')) throw Error("Text marker not restored");
            if (h.mainElement.querySelectorAll('.siyuan-footnote-native-ref').length !== 2) throw Error("Native ref style not restored on enable");
            if (!document.querySelector('[data-jump-style]').checked) throw Error("Menu state did not sync to panel");
            if (!h.savedSettings.at(-1).enabled || h.transactions.length) throw Error("Toggle did not save cleanly");
            await h.jumper.ensureDocumentDefinitions("doc");
            window.clearTimeout(h.jumper.refreshTimer);
            h.jumper.refreshTimer = 0; h.jumper.refreshTimerAt = 0;
            h.jumper.dirtyBlocks.clear(); h.jumper.definitionDirtyRoots.clear();
            h.nativeEditors.length = 0;
        });

        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole('combobox', {name: '目标脚注写法'}).selectOption('block');
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
            if (Array.from(block.querySelectorAll('[data-type~="block-ref"]')).some(ref => ref.textContent !== "[^1]")) {
                throw Error("Static refs must use caret brackets by default");
            }
        });

        await page.evaluate(async () => {
            await h.reset(h.block("body", "第一段 [^B] 和 [^B]，接着 [^A]。") + h.block("second", "第二段 [^A]。")
                + h.block("a", '[^A]: <b>保留加粗</b>和<a href="https://example.test">链接</a>。')
                + h.block("b", "[^B]: 第二个定义。") + h.block("unused", "[^unused]: 未引用的说明。"));
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        assert.equal(await page.getByRole('textbox', {name: '脚注编号', exact: true}).isVisible(), false);
        await assertMatchingCards();
        await page.screenshot({path: path.join(artifacts, "settings-desktop.png"), animations: "disabled"});
        await page.getByRole("tab", {name: "设置", exact: true}).press('ArrowLeft');
        assert.equal(await page.getByRole("tab", {name: "脚注", exact: true}).getAttribute('aria-selected'), 'true');
        await page.waitForFunction(() => h.nativeEditors.length === 1);
        const layout = await page.evaluate(() => ({width: document.querySelector("#dock").getBoundingClientRect().width,
            overflow: document.querySelector("#dock").scrollWidth > document.querySelector("#dock").clientWidth}));
        assert.equal(layout.width, 360); assert.equal(layout.overflow, false);
        await page.screenshot({path: path.join(artifacts, "sidebar-desktop.png"), animations: "disabled"});
        const nativeCount = await page.evaluate(() => h.nativeEditors.length);
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.locator('[data-note-key="b"]').click();
        await page.evaluate(() => h.manager.refresh());
        assert.equal(await page.evaluate(() => h.nativeEditors.length), nativeCount);
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.locator('[data-block-id="body"]').click();
        assert.equal(await page.evaluate(() => h.opened[0]), "body");

        await page.evaluate(() => h.manager.normalize({format: "block", renumber: true}));
        await page.evaluate(() => h.confirmations[0].callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /\[\^1\]: 第二个定义/);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /<b>保留加粗<\/b>/);

        // End real table focus/selection, flush pending native input, and use
        // the complete saved table instead of the partial visible row set.
        await page.evaluate(async () => {
            const table = text => h.block("table", `<table><tbody><tr><td contenteditable="true">${text} [^A]</td></tr><tr><td>未加载行 [^A]</td></tr></tbody></table>`, "NodeTable");
            const html = text => h.block("body", "正文 [^A]") + table(text) + h.block("a", "[^A]: 内容");
            await h.reset(html("旧内容"), html("新内容"));
            h.mainElement.querySelectorAll('tr')[1].remove();
            const cell = h.mainElement.querySelector('td');
            const editable = h.mainElement.querySelector('[data-node-id="table"] [contenteditable="true"]');
            editable.focus();
            if (document.activeElement !== editable) throw Error("Table test did not focus its native editing root");
            const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            h.tableBlurred = false; editable.addEventListener("blur", () => {h.tableBlurred = true;});
            h.manager.host.tablePending = () => true;
            h.main.flushPendingTransactions = async () => {h.kernel.innerHTML = html("新内容");};
            await h.manager.normalize({format: "block", renumber: true});
            if (!h.tableBlurred || getSelection().rangeCount) throw Error("Table editing was not ended");
            if (h.confirmations.length !== 1 || h.transactions.length) throw Error("Saved table did not reach review");
            h.confirmations[0].callback();
        });
        await page.waitForFunction(() => h.transactions.length === 1);
        await page.evaluate(() => {
            const table = h.kernel.querySelector('[data-node-id="table"]');
            if (!table.textContent.includes("新内容") || !table.textContent.includes("未加载行")
                || table.querySelectorAll('[data-type~="block-ref"]').length !== 2) throw Error("Table save or unloaded rows lost");
            delete h.main.flushPendingTransactions; h.manager.host.tablePending = () => false;
        });

        // Equivalent native copies carry different view indexes and timestamps.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 [^A]") + h.block("a", "[^A]: 内容", "NodeParagraph", 'data-node-index="40" updated="20261017000000"'));
            const side = h.manager.sidebar.protyle.wysiwyg.element;
            const definition = side.querySelector('[data-node-id="a"]');
            definition.dataset.nodeIndex = "1"; definition.setAttribute("updated", "20261017000001");
            side.querySelector('[contenteditable="true"]').focus();
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-action="normalize"]').click();
        await page.waitForFunction(() => h.confirmations.length === 1);
        await page.evaluate(() => {
            h.mainElement.querySelector('[contenteditable="true"]').focus();
            h.confirmations[0].callback();
        });
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /data-type="NodeList"/);
        assert.match(await page.evaluate(() => h.mainElement.innerHTML), /data-type="block-ref sup"/);

        // A sidebar button can leave the document selection in an updated block.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 [^A] 后 [^B]")
                + h.block("a", "[^A]: <b>A 内容</b>") + h.block("b", "[^B]: B 内容"));
            h.command(2, 2);
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-action="normalize"]').click();
        await page.waitForFunction(() => h.confirmations.length === 1);
        await page.evaluate(() => h.confirmations[0].callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.equal(await page.evaluate(() => h.mainElement.innerHTML), await page.evaluate(() => h.kernel.innerHTML));
        assert.match(await page.evaluate(() => h.main.protyle.wysiwyg.lastHTMLs.body), /\[\^1\]/);
        await page.evaluate(() => h.manager.refresh());
        assert.match(await page.locator('.siyuan-footnote-sidebar__status').textContent(), /2 个脚注 · 2 处引用/);
        await page.evaluate(() => h.replay(h.transactions[0].undo));
        assert.match(await page.evaluate(() => h.mainElement.innerHTML), /\[\^A\]:/);
        assert.equal(await page.locator('.main [data-type="NodeList"]').count(), 0);

        // A synchronous submission failure restores the original nodes and caret.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 [^A]") + h.block("a", "[^A]: 内容"));
            h.command(2, 2);
            h.beforeNormalization = h.mainElement.innerHTML;
            h.beforeCaret = getSelection().anchorNode;
            await h.manager.normalize({format: "block", renumber: true, definitionFormat: "list"});
            const submit = h.main.transaction;
            h.main.transaction = () => {throw Error("整理提交失败");};
            try {
                h.confirmations[0].callback();
                await new Promise(resolve => setTimeout(resolve, 0));
            } finally {h.main.transaction = submit;}
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.equal(await page.evaluate(() => h.mainElement.innerHTML), await page.evaluate(() => h.beforeNormalization));
        assert.equal(await page.evaluate(() => getSelection().anchorNode === h.beforeCaret && getSelection().anchorOffset === 2), true);
        assert.match(await page.evaluate(() => h.messages.at(-1)), /整理提交失败/);

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
        assert.deepEqual(await page.evaluate(() => Array.from(h.kernel.querySelectorAll('[data-type~="block-ref"]'),
            node => [node.dataset.id, node.textContent])), [["b", "[^1]"], ["a", "[^2]"]]);
        await page.evaluate(() => h.replay(h.transactions[0].undo));
        assert.deepEqual(await page.evaluate(() => Array.from(h.kernel.querySelectorAll('[data-type~="block-ref"]'),
            node => [node.dataset.id, node.textContent])), [["li-b", "[2]"], ["a", "[1]"]]);

        // Both definition formats and the explicit number-refresh flow.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 [^A] 后 [^B]")
                + h.block("a", "[^A]: <b>A 内容</b>") + h.block("b", "[^B]: B 内容"));
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-definition-format]').selectOption("list");
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-action="normalize"]').click();
        await page.waitForFunction(() => h.confirmations.length === 1);
        await page.evaluate(() => h.confirmations[0].callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        const listResult = await page.evaluate(() => h.kernel.innerHTML);
        assert.match(listResult, /data-type="NodeList"/);
        assert.doesNotMatch(listResult, /\[\^[^\]]+\]:/);
        assert.match(listResult, /<b>A 内容<\/b>/);
        assert.equal(await page.evaluate(() => h.mainElement.innerHTML), listResult,
            "The loaded editor must reflect deletes and insertion before the host submits normalization");
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
        await page.waitForFunction(() => document.querySelector('.siyuan-footnote-sidebar__status').textContent.includes("序号已变化"));
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-action="refresh-numbers"]').click();
        await page.waitForFunction(() => h.confirmations.length === 2);
        await page.evaluate(() => h.confirmations[1].callback());
        await page.waitForFunction(() => h.transactions.length === 2);
        assert.deepEqual(await page.evaluate(() => Array.from(h.kernel.querySelectorAll('[data-type~="block-ref"]'),
            node => [node.dataset.id, node.textContent])), [["a", "[^2]"], ["b", "[^1]"]]);
        await page.evaluate(() => h.manager.refresh());
        assert.equal(await page.locator('[data-action="refresh-numbers"]').isVisible(), false);
        await page.screenshot({path: path.join(artifacts, "ordered-footnotes.png")});
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-definition-format]').selectOption("literal");
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-action="normalize"]').click();
        await page.waitForFunction(() => h.confirmations.length === 3);
        await page.evaluate(() => h.confirmations[2].callback());
        await page.waitForFunction(() => h.transactions.length === 3);
        assert.equal(await page.evaluate(() => h.kernel.querySelector('[data-type="NodeList"]')), null);
        assert.match(await page.evaluate(() => h.kernel.innerHTML), /\[\^1\]: <b>A 内容<\/b>/);

        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole('combobox', {name: '目标脚注写法'}).selectOption('block');
        // The insertion picker searches every note while rendering adjacent batches.
        await page.evaluate(async () => {
            const notes = Array.from({length: 1000}, (_, i) => h.block(`picker-large-${i + 1}`, `[^${i + 1}]: 动态候选 ${i + 1}`));
            await h.reset(h.block('body', '正文 /jz 末尾') + notes.join(''));
            h.command(3, 6); await h.manager.insert(h.main, h.mainElement.firstElementChild);
            h.firstPickerRow = document.querySelector('[data-definition-id="picker-large-1"]');
        });
        const largePickerList = page.locator('[data-picker-notes]');
        const largePickerSearch = page.getByRole('combobox', {name: '搜索脚注'});
        assert.equal(await largePickerList.getByRole('option').count(), 40);
        assert.match(await page.locator('[data-picker-status]').textContent(), /1000 条脚注/);
        await largePickerList.evaluate(el => {el.scrollTop = el.scrollHeight;});
        await page.waitForFunction(() => document.querySelectorAll('[data-picker-key]').length === 80);
        assert.equal(await page.evaluate(() => h.firstPickerRow === document.querySelector('[data-definition-id="picker-large-1"]')), true);
        await page.locator('[data-definition-id="picker-large-75"]').click();
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        await largePickerList.evaluate(el => {el.scrollTop = el.scrollHeight;});
        await page.waitForFunction(() => document.querySelectorAll('[data-picker-key]').length >= 120);
        assert.equal(await page.locator('[data-definition-id="picker-large-75"]').getAttribute('aria-selected'), 'true');
        await largePickerSearch.fill('[1000]');
        assert.equal(await largePickerList.getByRole('option').count(), 1);
        assert.equal(await largePickerList.getByRole('option').getAttribute('data-definition-id'), 'picker-large-1000');
        await largePickerSearch.fill('');
        assert.equal(await largePickerList.getByRole('option').count(), 40);
        await largePickerSearch.press('ArrowUp');
        assert.equal(await largePickerList.locator('[aria-selected="true"]').getAttribute('data-definition-id'), 'picker-large-1000');
        assert.ok(await largePickerList.getByRole('option').count() <= 120);
        assert.equal(await largePickerList.evaluate(el => {
            const row = el.querySelector('[aria-selected="true"]').getBoundingClientRect();
            const viewport = el.getBoundingClientRect();
            return row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
        }), true, 'Keyboard selection must reveal an unloaded candidate');
        await largePickerSearch.press('ArrowDown');
        for (let i = 0; i < 40; i++) await largePickerSearch.press('ArrowDown');
        assert.equal(await largePickerList.locator('[aria-selected="true"]').getAttribute('data-definition-id'), 'picker-large-41');
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        await page.screenshot({path: path.join(artifacts, 'footnote-picker-dynamic.png'), animations: 'disabled'});
        await page.getByRole('button', {name: '插入脚注', exact: true}).click();
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.equal(await page.evaluate(() => h.transactions[0].forward.length), 1);
        assert.match(await page.evaluate(() => h.mainElement.firstElementChild.innerHTML), /data-id="picker-large-41"/);
        console.log('Large insertion picker passed: 1000 candidates, initial 40 rows, automatic scrolling, full search, cross-batch keyboard navigation and explicit confirmation.');

        // Search keeps focus in the combobox while reusing the saved slash range.
        await page.evaluate(async () => {
            await h.reset(h.block('body', '正文 /jz 末尾') + h.block('a', '[^12]: 第一条说明')
                + h.block('b', '[^2]: ' + '长内容'.repeat(50) + ' needle keyword'));
            h.command(3, 6); await h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        const pickerSearch = page.getByRole('combobox', {name: '搜索脚注'});
        assert.equal(await pickerSearch.evaluate(el => el === document.activeElement), true);
        await pickerSearch.fill('NEEDLE keyword');
        assert.equal(await page.getByRole('option').count(), 1);
        assert.equal(await page.getByRole('option').getAttribute('data-definition-id'), 'b');
        await pickerSearch.fill('[12]');
        assert.equal(await page.getByRole('option').getAttribute('data-definition-id'), 'a');
        await pickerSearch.press('Enter');
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.equal(await page.getByRole('button', {name: '插入脚注', exact: true}).evaluate(el => el === document.activeElement), true);
        await page.getByRole('button', {name: '插入脚注', exact: true}).click();
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.equal(await page.evaluate(() => h.transactions[0].forward.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.firstElementChild.textContent), '正文 [^12] 末尾');

        await page.evaluate(async () => {
            await h.reset(h.block('body', '正文 /jz 末尾') + h.block('a', '[^1]: 原有说明'));
            h.command(3, 6); await h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        await pickerSearch.fill('没有这个脚注');
        await pickerSearch.press('Enter');
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.match(await page.locator('[data-picker-status]').textContent(), /没有匹配/);
        await page.getByRole('textbox', {name: '新脚注内容', exact: true}).fill('<b>直接填写的内容</b> & 第二行\n补充说明');
        await page.screenshot({path: path.join(artifacts, 'footnote-picker-search.png'), animations: 'disabled'});
        await page.getByRole('textbox', {name: '新脚注内容', exact: true}).press('Control+Enter');
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        await page.getByRole('button', {name: '新建脚注', exact: true}).click();
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.equal(await page.evaluate(() => h.kernel.querySelector('[data-node-id="new-1"] b')), null);
        assert.equal(await page.evaluate(() => h.kernel.querySelector('[data-node-id="new-1"] [contenteditable]').textContent), '[^2]: <b>直接填写的内容</b> & 第二行\n补充说明');
        await page.evaluate(() => h.replay(h.transactions[0].undo));
        assert.equal(await page.evaluate(() => h.mainElement.firstElementChild.textContent), '正文 /jz 末尾');
        assert.equal(await page.evaluate(() => h.kernel.querySelector('[data-node-id="new-1"]')), null);

        await page.evaluate(async () => {
            h.command(3, 6); await h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        await pickerSearch.fill('取消时保留正文');
        await pickerSearch.press('Escape');
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await page.evaluate(() => getSelection().toString()), '/jz');

        // Real Range: insert at a nonzero position in an existing paragraph.
        assert.equal(await page.evaluate(() => h.api.Lute), undefined);
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 /脚注 末尾") + h.block("a", "[^1]: 已有脚注。"));
            h.manager.sidebar.showPanel("settings");
            h.command(3, 6);
            await h.plugin.protyleSlash[0].callback(h.main, h.mainElement.firstElementChild);
        });
        await page.waitForFunction(() => !document.querySelector('[data-picker-submit]').disabled);
        await page.screenshot({path: path.join(artifacts, "footnote-picker.png"), animations: "disabled"});
        await page.locator('[data-definition-id="a"]').click();
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.equal(await page.locator('[data-picker-submit]').textContent(), '插入脚注');
        await page.locator('[data-picker-create]').click();
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        assert.equal(await page.locator('[data-picker-submit]').textContent(), '新建脚注');
        await page.screenshot({path: path.join(artifacts, 'footnote-picker-create.png'), animations: 'disabled'});
        await page.locator('[data-picker-submit]').click();
        await page.waitForFunction(() => h.transactions.length === 1 || h.messages.length > 0);
        assert.equal(await page.evaluate(() => h.transactions.length), 1,
            JSON.stringify(await page.evaluate(() => ({messages: h.messages, status: document.querySelector('[data-picker-status]')?.textContent,
                body: h.mainElement.innerHTML, busy: h.manager.busy}))));
        const visibleMarker = await page.evaluate(() => h.mainElement.querySelector('[data-type~="block-ref"][data-id="new-1"]')?.textContent);
        assert.equal(visibleMarker, "[^2]", "The edited paragraph must show the inserted footnote without reloading");
        assert.doesNotMatch(await page.evaluate(() => h.mainElement.textContent), /\/脚注/);
        assert.match(await page.evaluate(() => h.main.protyle.wysiwyg.lastHTMLs.body), /\[\^2\]/);
        await page.evaluate(() => h.manager.refresh());
        await page.waitForFunction(() => h.nativeEditors.at(-1).options.blockId === "new-1" && document.activeElement.closest('[data-footnote-sidebar]'));
        const insertion = await page.evaluate(() => ({html: h.kernel.innerHTML, tx: h.transactions[0]}));
        assert.equal(insertion.tx.forward.length, 3);
        assert.equal(insertion.tx.undo.length, 3);
        assert.match(insertion.html, /正文 <span[^>]+data-id="new-1"[^>]*>\[\^2\]<\/span> 末尾/);
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
            await h.manager.insert(h.main, h.mainElement.firstElementChild); await h.chooseNew();
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.querySelectorAll('[data-type~="block-ref"]').length), 1);
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
            await h.manager.insert(h.main, h.mainElement.firstElementChild); await h.chooseNew();
        });
        assert.equal(await page.evaluate(() => h.transactions.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.children.length), 1);
        assert.equal(await page.evaluate(() => h.mainElement.querySelectorAll('[data-type~="block-ref"]').length), 1);
        assert.equal(await page.evaluate(() => h.kernel.children.length), 4);

        // A synchronous host failure restores the command, selection and local blocks.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "正文 /jz"));
            h.command(3, 6);
            const transaction = h.main.transaction;
            h.main.transaction = () => {throw new Error("宿主事务提交失败");};
            try {await h.manager.insert(h.main, h.mainElement.firstElementChild); await h.chooseNew();}
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
            try {await h.manager.insert(h.main, h.mainElement.firstElementChild); await h.chooseNew();}
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
        // Dialog focus and a moved live selection do not invalidate the saved slash position.
        await page.evaluate(() => h.chooseNew());
        assert.equal(await page.evaluate(() => h.transactions.length), 1);

        await page.evaluate(async () => {
            await h.reset(h.block('body', '正文 /jz 后') + h.block('d', '[^8]: 可以复用'));
            h.main.flushPendingTransactions = () => new Promise(() => {});
            h.mainElement.insertAdjacentHTML('beforeend', h.block('queued', '还没保存的块'));
            h.command(3, 6); await h.manager.insert(h.main, h.mainElement.firstElementChild);
        });
        await page.locator('[data-definition-id="d"]').click();
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        await page.getByRole('button', {name: '插入脚注', exact: true}).click();
        await page.waitForFunction(() => h.transactions.length === 1);
        assert.equal(await page.evaluate(() => h.transactions[0].forward.length), 1);
        assert.match(await page.evaluate(() => h.mainElement.firstElementChild.textContent), /正文 \[\^8\] 后/);
        await page.evaluate(() => {delete h.main.flushPendingTransactions;});

        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole('combobox', {name: '目标脚注写法'}).selectOption('text');
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-live-refresh]').uncheck();
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        assert.equal(await page.locator('[data-action="refresh"]').isVisible(), true);
        await page.evaluate(async () => {
            await h.reset(h.block('body', '正文 [^1]') + h.block('d', '[^1]: 内容'));
            h.command(7, 7); h.jumper.activeBlock = h.mainElement.firstElementChild;
            h.jumper.activeBlockId = 'body'; h.jumper.markAllBlocksDirty(); h.jumper.refresh();
            h.manualCaret = h.jumper.captureSelection(h.mainElement.firstElementChild);
            if (h.mainElement.firstElementChild.querySelector('.siyuan-footnote-ref')) throw Error('Active block refreshed automatically');
        });
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.locator('[data-action="refresh"]').click();
        await page.waitForFunction(() => Boolean(h.mainElement.firstElementChild.querySelector('.siyuan-footnote-ref')));
        assert.deepEqual(await page.evaluate(() => h.jumper.captureSelection(h.mainElement.firstElementChild)),
            await page.evaluate(() => h.manualCaret));
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-live-refresh]').check();
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole('combobox', {name: '目标脚注写法'}).selectOption('block');
        assert.equal(await page.locator('[data-action="refresh"]').isVisible(), true);
        assert.equal(await page.locator('.main .siyuan-footnote-ref').count(), 0);

        const assertHeaderControls = async () => {
            await page.mouse.move(1, 1);
            assert.equal(await page.evaluate(() => {
                const header = document.querySelector('#dock > .block__icons');
                const controls = [header.querySelector('.siyuan-footnote-sidebar__auto-refresh'),
                    header.querySelector('[data-action="refresh"]'), header.querySelector('[data-type="min"]')];
                const bounds = header.getBoundingClientRect();
                const toggle = header.querySelector('[data-panel-auto-refresh]');
                const text = header.querySelector('.siyuan-footnote-sidebar__auto-refresh > span');
                const centerY = element => {const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2;};
                const thumb = getComputedStyle(toggle, '::before');
                const thumbY = toggle.getBoundingClientRect().top + parseFloat(getComputedStyle(toggle).borderTopWidth)
                    + parseFloat(thumb.top) + new DOMMatrix(thumb.transform).m42 + parseFloat(thumb.height) / 2;
                return controls.every((control, index) => {
                    const rect = control.getBoundingClientRect();
                    const style = getComputedStyle(control);
                    return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right
                        && style.visibility === 'visible' && Number(style.opacity) >= .5
                        && Math.abs(centerY(control) - centerY(toggle)) < 1
                        && (index === 0 || rect.left >= controls[index - 1].getBoundingClientRect().right);
                }) && header.scrollWidth <= header.clientWidth
                    && Math.abs(centerY(text) - centerY(toggle)) < 1 && Math.abs(thumbY - centerY(toggle)) < 1
                    && getComputedStyle(toggle).padding === '0px'
                    && controls.slice(1).every(button => getComputedStyle(button.querySelector('svg')).fill === 'none');
            }), true, 'Header controls must remain visible without hover, aligned and unfilled under host CSS');
            for (const name of ['脚注', '设置']) {
                await page.getByRole('tab', {name, exact: true}).click();
                assert.equal(await page.getByRole('switch', {name: '面板自动刷新', exact: true}).isVisible(), true);
                assert.equal(await page.getByRole('button', {name: '刷新脚注面板', exact: true}).isVisible(), true);
                assert.equal(await page.getByRole('button', {name: '关闭脚注侧栏', exact: true}).isVisible(), true);
            }
        };
        for (const width of [260, 360]) {
            await page.locator('#dock').evaluate((element, width) => {element.style.width = width + 'px';}, width);
            await assertHeaderControls();
        }
        await page.getByRole('switch', {name: '面板自动刷新', exact: true}).focus();
        await page.keyboard.press('Space');
        assert.equal(await page.getByRole('switch', {name: '面板自动刷新', exact: true}).isChecked(), false);
        assert.equal(await page.evaluate(() => h.savedSettings.at(-1).panelAutoRefresh), false);
        await page.mouse.move(1, 1);
        await page.locator('#dock > .block__icons').screenshot({path: path.join(artifacts, 'refresh-header-off.png')});
        await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('button', {name: '刷新脚注面板', exact: true}).evaluate(element => element === document.activeElement), true);
        await page.getByRole('switch', {name: '面板自动刷新', exact: true}).check();
        await page.getByRole('button', {name: '刷新脚注面板', exact: true}).waitFor({state: 'visible'});
        await page.locator('#dock > .block__icons').screenshot({path: path.join(artifacts, 'refresh-header-light.png')});
        console.log('Refresh toolbar passed: independent persisted switch, keyboard control and both tabs at 260px/360px.');

        // Closing releases the native editor; reopening restores the selection.
        await page.evaluate(async () => {
            await h.reset(h.block("body", "[^A]") + h.block("a", "[^A]: note"));
            document.querySelector("#dock").style.display = "none";
        });
        await page.waitForFunction(() => h.manager.sidebar.protyle === undefined);
        await page.evaluate(() => h.manager.open());
        await page.waitForFunction(() => Boolean(h.manager.sidebar.protyle));

        // Exercise the new controls and native superscript without applying a
        // second size/vertical offset in the navigation enhancement.
        await page.addStyleTag({content: '.protyle-wysiwyg [data-type~="sup"]{font-size:.75em;vertical-align:super}'});
        await page.evaluate(async () => {
            await h.reset(h.block("body", '<span data-type="strong text" style="color:red">前 [^12] 后</span>') + h.block("d", "[^12]: 内容"));
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("combobox", {name: "目标脚注写法"}).selectOption("block");
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("combobox", {name: "静态块引编号样式"}).selectOption("brackets");
        const blockDefinition = await page.locator('[data-definition-format]').inputValue();
        assert.equal(await page.locator('select option[value="keep"]').count(), 0);
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-superscript]').check();
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("button", {name: "统一格式", exact: true}).click();
        await page.evaluate(() => h.confirmations.at(-1).callback());
        await page.waitForFunction(() => h.transactions.length === 1);
        await page.evaluate(() => {
            const block = h.mainElement.querySelector('[data-node-id="body"]');
            const native = block.querySelector('[data-type~="block-ref"]');
            if (native.textContent !== '[1]' || !native.matches('[data-type~="sup"][data-type~="strong"]')) throw Error('Native sup/style controls were not applied');
            if (native.style.color !== 'red' || native.dataset.id !== 'd') throw Error('Inline style or target lost');
            const before = getComputedStyle(native).fontSize;
            h.jumper.styleNativeFootnotes(block, h.jumper.collectDefinitions(h.mainElement));
            if (native.classList.contains('siyuan-footnote-native-ref') || getComputedStyle(native).fontSize !== before) throw Error('Native sup was enhanced twice');
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("combobox", {name: "目标脚注写法"}).selectOption("text");
        assert.equal(await page.locator('[data-block-label]').isDisabled(), true);
        assert.equal(await page.locator('[data-block-label-field]').isVisible(), false);
        assert.equal(await page.locator('[data-definition-format-field]').isVisible(), false);
        assert.equal(await page.locator('[data-text-format-hint]').isVisible(), true);
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("button", {name: "统一格式", exact: true}).click();
        await page.evaluate(() => h.confirmations.at(-1).callback());
        await page.waitForFunction(() => h.transactions.length === 2);
        await page.evaluate(() => {
            const block = h.mainElement.querySelector('[data-node-id="body"]');
            const sup = block.querySelector('[data-type~="sup"]');
            if (h.kernel.querySelector('[data-type="NodeList"]') || !h.kernel.textContent.includes('[^1]: 内容')) throw Error('Text references must use fixed definitions');
            const before = getComputedStyle(sup).fontSize;
            h.jumper.wrapReferences(block, h.jumper.collectDefinitions(h.mainElement));
            const enhanced = block.querySelector('.siyuan-footnote-ref--native-sup');
            if (!enhanced || enhanced.dataset.preview !== '内容') throw Error('Native sup text navigation missing');
            if (getComputedStyle(enhanced).fontSize !== before || getComputedStyle(enhanced).verticalAlign !== 'baseline') throw Error('Text sup was enhanced twice');
        });
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("combobox", {name: "目标脚注写法"}).selectOption("block");
        assert.equal(await page.locator('[data-block-label-field]').isVisible(), true);
        assert.equal(await page.locator('[data-definition-format-field]').isVisible(), true);
        assert.equal(await page.locator('[data-definition-format]').inputValue(), blockDefinition);
        assert.equal(await page.locator('[data-block-label]').inputValue(), "brackets");
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.getByRole("combobox", {name: "静态块引编号样式"}).selectOption("caret");
        await page.getByRole("tab", {name: "设置", exact: true}).click();
        await page.locator('[data-superscript]').uncheck();

        // Optionally verify the actual Lute shipped with an installed SiYuan.
        if (process.env.FOOTNOTE_LUTE_SCRIPT) {
            await page.addScriptTag({content: fs.readFileSync(process.env.FOOTNOTE_LUTE_SCRIPT, "utf8")});
            await page.evaluate(async () => {
                await h.reset(h.block("body", "正文 /脚注 末尾"));
                h.command(3, 6);
                await h.manager.insert(h.main, h.mainElement.firstElementChild); await h.chooseNew();
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

        // A large document keeps full counts, but creates only the first batches of rows.
        await page.evaluate(async () => {
            const notes = Array.from({length: 1000}, (_, i) => h.block(`large-note-${i}`, `[^${i + 1}]: 脚注内容 ${i + 1}`));
            const body = h.block('large-body', Array.from({length: 1000}, (_, i) => `[^${i + 1}]`).join(' '));
            const paragraphs = Array.from({length: 125}, (_, i) => h.block(`large-ref-${i}`, `被引段落 ${i + 1} [^1]`));
            h.manager.revision++;
            await h.reset(body + paragraphs.join('') + notes.join(''));
        });
        await page.waitForFunction(() => document.querySelectorAll('[data-note-key]').length === 40);
        assert.equal(await page.locator('.siyuan-footnote-sidebar__reference').count(), 30);
        assert.match(await page.locator('.siyuan-footnote-sidebar__status').textContent(), /1000 个脚注 · 1125 处引用/);
        await page.evaluate(() => {
            h.largeRow = document.querySelector('[data-note-key="large-note-0"]');
            h.largeReference = document.querySelector('.siyuan-footnote-sidebar__reference');
            h.largeEditor = h.manager.sidebar.protyle;
            const list = document.querySelector('.siyuan-footnote-sidebar__list'); list.scrollTop = list.scrollHeight;
        });
        await page.waitForFunction(() => document.querySelectorAll('[data-note-key]').length === 80);
        await page.evaluate(() => {
            const panel = document.querySelector('[data-panel-content="notes"]'); panel.scrollTop = panel.scrollHeight;
        });
        await page.waitForFunction(() => document.querySelectorAll('.siyuan-footnote-sidebar__reference').length >= 60);
        await page.evaluate(async () => {
            h.largeRow.focus(); await h.manager.refresh();
            if (document.querySelector('[data-note-key="large-note-0"]') !== h.largeRow) throw Error('Unchanged note DOM was replaced');
            if (document.querySelector('.siyuan-footnote-sidebar__reference') !== h.largeReference) throw Error('Unchanged reference DOM was replaced');
            if (h.manager.sidebar.protyle !== h.largeEditor) throw Error('Native editor was recreated');
            if (document.activeElement !== h.largeRow) throw Error('List focus was lost during refresh');
        });
        const retainedNotes = await page.evaluate(() => ({editor: h.manager.sidebar.protyle === h.largeEditor,
            scroll: document.querySelector('.siyuan-footnote-sidebar__list').scrollTop}));
        await page.getByRole('tab', {name: '设置', exact: true}).click();
        await page.evaluate(() => h.manager.refresh());
        await page.getByRole('tab', {name: '脚注', exact: true}).click();
        assert.equal(await page.evaluate(() => h.manager.sidebar.protyle === h.largeEditor), retainedNotes.editor);
        assert.equal(await page.evaluate(() => document.querySelector('.siyuan-footnote-sidebar__list').scrollTop), retainedNotes.scroll);
        // One lookup must leave the actual row inside both scrolling viewports after lazy-loading callbacks.
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).fill('467');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.locator('[data-action="locate-number"]').click();
        await page.evaluate(async () => {for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);});
        const located467 = await page.evaluate(() => {
            const row = document.querySelector('[data-note-key="large-note-466"]');
            const list = document.querySelector('.siyuan-footnote-sidebar__list').getBoundingClientRect();
            const panel = document.querySelector('#dock').getBoundingClientRect();
            const bounds = row?.getBoundingClientRect();
            return {visible: Boolean(bounds && bounds.top >= Math.max(list.top, panel.top, 0) - 1
                    && bounds.bottom <= Math.min(list.bottom, panel.bottom, innerHeight) + 1),
                rowTop: bounds?.top, rowBottom: bounds?.bottom, listTop: list.top, listBottom: list.bottom,
                selected: row?.getAttribute('aria-pressed'), rendered: document.querySelectorAll('[data-note-key]').length};
        });
        assert.equal(located467.visible, true, `One-click lookup of 467 drifted out of view: ${JSON.stringify(located467)}`);
        assert.equal(located467.selected, 'true');
        const assertLocatedRow = async label => {
            const result = await page.evaluate(label => {
                const row = document.querySelector(`[data-note-key="large-note-${Number(label) - 1}"]`);
                const list = document.querySelector('.siyuan-footnote-sidebar__list').getBoundingClientRect();
                const panel = document.querySelector('#dock').getBoundingClientRect();
                const header = document.querySelector('#dock .block__icons').getBoundingClientRect();
                const bounds = row?.getBoundingClientRect();
                return {visible: Boolean(bounds && bounds.top >= Math.max(list.top, panel.top, header.bottom, 0) - 1
                        && bounds.bottom <= Math.min(list.bottom, panel.bottom, innerHeight) + 1),
                    selected: row?.getAttribute('aria-pressed'), rowTop: bounds?.top, rowBottom: bounds?.bottom,
                    listTop: list.top, listBottom: list.bottom};
            }, label);
            assert.equal(result.visible, true, `Lookup of ${label} left its viewport: ${JSON.stringify(result)}`);
            assert.equal(result.selected, 'true');
        };
        for (const [index, label] of ['40', '41', '467', '480', '1000'].entries()) {
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
            await page.getByRole('textbox', {name: '脚注编号', exact: true}).fill(label);
            if (index % 2) await page.getByRole('textbox', {name: '脚注编号', exact: true}).press('Enter');
            else await page.locator('[data-action="locate-number"]').click();
            await page.evaluate(async () => {
                for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
                await h.manager.refresh();
                for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
            });
            await assertLocatedRow(label);
        }
        await page.setViewportSize({width: 1100, height: 600});
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).fill('467');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).press('Enter');
        await page.evaluate(async () => {for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);});
        await assertLocatedRow('467');
        await page.setViewportSize({width: 1100, height: 850});
        console.log('One-click lookup passed: 40, 41, 467, 480, 1000 stay visible after lazy loading and refresh, including a 600px viewport.');
        // Upward scrolling loads earlier rows without a loading button or viewport drift.
        assert.equal(await page.getByRole('button', {name: /加载/}).count(), 0);
        await page.evaluate(() => {
            const list = document.querySelector('.siyuan-footnote-sidebar__list');
            h.beforeEarlier = Number(list.querySelector('[data-note-key]').dataset.noteKey.split('-').at(-1));
            list.scrollTop = 0;
        });
        await page.waitForFunction(() => Number(document.querySelector('[data-note-key]').dataset.noteKey.split('-').at(-1)) < h.beforeEarlier);
        const anchoredEarlier = await page.evaluate(() => {
            const list = document.querySelector('.siyuan-footnote-sidebar__list');
            const row = document.querySelector(`[data-note-key="large-note-${h.beforeEarlier}"]`);
            return Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top) < 5 && list.scrollTop > 0;
        });
        assert.equal(anchoredEarlier, true, 'Prepending an earlier batch must retain the visible row');
        // Number lookup must reach unloaded rows while retaining bounded rendering.
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).fill('[^1000]');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).press('Enter');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.waitForFunction(() => document.querySelector('[data-note-key="large-note-999"]')?.getAttribute('aria-pressed') === 'true');
        assert.equal(await page.locator('[data-note-key="large-note-999"]').isVisible(), true);
        assert.equal(await page.evaluate(() => h.manager.sidebar.protyle.wysiwyg.element.firstElementChild.dataset.nodeId), 'large-note-999');
        assert.ok(await page.locator('[data-note-key]').count() < 200, 'Lookup must not load all 1000 rows');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).fill('不存在');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.locator('[data-action="locate-number"]').click();
        assert.match(await page.locator('[data-locate-status]').textContent(), /未找到/);
        assert.equal(await page.locator('[data-note-key="large-note-999"]').getAttribute('aria-pressed'), 'true');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.getByRole('textbox', {name: '脚注编号', exact: true}).fill('[1]');
        await page.getByRole("tab", {name: "脚注", exact: true}).click();
        await page.locator('[data-action="locate-number"]').click();
        assert.equal(await page.locator('[data-note-key="large-note-0"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.evaluate(() => h.transactions.length), 0);
        console.log('Large sidebar passed: 1000 notes and 1125 references indexed, initial note/reference rows 40/30, scroll loading and DOM/focus reuse.');
        await page.evaluate(async () => {
            h.manager.revision++;
            await h.reset(h.block('body', '正文 [^1]') + h.block('d', '[^1]: 内容'));
            document.querySelector('[data-panel-content="notes"]').scrollTop = 0;
        });
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
            document.documentElement.style.setProperty("--b3-theme-primary", "#91a7ff");
            document.documentElement.style.setProperty("--b3-theme-on-primary", "#17213e");
            document.documentElement.style.setProperty("--b3-border-color", "#424b5b");
        });
        await assertMatchingCards();
        await assertHeaderControls();
        await page.locator('#dock').evaluate(element => {element.style.width = '260px';});
        await assertHeaderControls();
        await page.locator('#dock > .block__icons').screenshot({path: path.join(artifacts, 'refresh-header-dark.png')});
        await page.locator('#dock').evaluate(element => {element.style.width = '100%';});
        await page.getByRole('tab', {name: '脚注', exact: true}).click();
        await page.screenshot({path: path.join(artifacts, "sidebar-mobile-dark.png"), animations: "disabled"});
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
        console.log("Browser checks passed: definition format conversion, ordered-list reorder warning and number refresh, picker reuse/creation/cancel and saved ranges, pending saves, manual refresh and caret preservation, sidebar selection/navigation, normalization, close/reopen, mobile dock opening and 390px layout.");
    } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
