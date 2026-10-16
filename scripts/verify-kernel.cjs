// Optional integration check against a real, isolated SiYuan kernel.
// FOOTNOTE_KERNEL overrides the locally installed executable. No user notebook is opened.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const https = require("node:https");
const net = require("node:net");
const {spawn} = require("node:child_process");
const {randomBytes} = require("node:crypto");
const assert = require("node:assert/strict");
const ts = require("typescript");
const {parseHTML} = require("linkedom");
const {document, window} = parseHTML("<html><body></body></html>");
const workspace = path.resolve(__dirname, "..");
const cache = {};
function load(name) {
    if (cache[name]) return cache[name];
    const exports = cache[name] = {};
    const source = ts.transpileModule(fs.readFileSync(path.join(workspace, "src", name + ".ts"), "utf8"), {
        compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
    }).outputText;
    vm.runInNewContext(source, {exports, require: name => load(name.replace("./", "")), document,
        Node: window.Node, HTMLElement: window.HTMLElement});
    return exports;
}
const model = load("document");
const nodeID = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + randomBytes(4).toString("hex").slice(0, 7);
const paragraph = (id, text, type = "NodeParagraph") => `<div data-node-id="${id}" data-type="${type}" class="${type === "NodeHeading" ? "h3" : "p"}"${type === "NodeHeading" ? ' data-subtype="h3"' : ""}><div contenteditable="true">${text}</div></div>`;
const ref = (id, label) => `<span data-type="block-ref" data-subtype="s" data-id="${id}">${label}</span>`;
function canonical(dom) {
    const root = document.createElement("div"); root.innerHTML = dom;
    const visit = node => {
        if (node.nodeType === 3) return node.textContent;
        if (node.classList.contains("protyle-attr") || node.classList.contains("protyle-action")) return;
        return [node.tagName, Array.from(node.attributes).filter(attr => !["updated", "data-node-index"].includes(attr.name))
            .map(attr => [attr.name, attr.value]).sort((a, b) => a[0].localeCompare(b[0])),
            Array.from(node.childNodes, visit).filter(value => value !== undefined)];
    };
    return Array.from(root.childNodes, visit);
}
(async () => {
    const artifacts = path.join(workspace, "dist", "kernel-check");
    fs.mkdirSync(artifacts, {recursive: true});
    const dir = fs.mkdtempSync(path.join(artifacts, "run-"));
    const home = path.join(dir, "home"), data = path.join(dir, "workspace");
    fs.mkdirSync(home); fs.mkdirSync(data);
    const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, "127.0.0.1", () => {
        const port = server.address().port; server.close(() => resolve(port));
    });});
    let logs = "";
    const kernel = spawn(process.env.FOOTNOTE_KERNEL || "C:\\Program Files\\SiYuan\\resources\\kernel\\SiYuan-Kernel.exe",
        ["--workspace", data, "--home-dir", home, "serve", "--port", String(port), "--safe-mode"], {windowsHide: true});
    const api = (name, body = {}) => new Promise((resolve, reject) => {
        const request = https.request(`https://127.0.0.1:${port}/api/${name}`, {
            method: "POST", rejectUnauthorized: false, headers: {"Content-Type": "application/json"},
        }, response => {
            let text = ""; response.on("data", data => text += data);
            response.on("end", () => {try {const value = JSON.parse(text);
                assert.equal(value.code, 0, `${name}: ${text}`); resolve(value.data);
            } catch (error) {reject(error);}});
        });
        request.on("error", reject); request.end(JSON.stringify(body));
    });
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error("Kernel startup timeout: " + logs)), 30000);
            const output = data => {logs += data; if (logs.includes("kernel booted")) {clearTimeout(timeout); resolve();}};
            kernel.stdout.on("data", output); kernel.stderr.on("data", output);
            kernel.once("error", error => {clearTimeout(timeout); reject(error);});
            kernel.once("exit", code => {clearTimeout(timeout); reject(Error(`Kernel exited ${code}: ${logs}`));});
        });
        const notebook = (await api("notebook/createNotebook", {name: "footnote-regression"})).notebook.id;
        const submit = (forward, undo) => api("transactions", {reqId: Date.now(), session: "footnote-regression",
            app: "footnote-regression", transactions: [{doOperations: forward, undoOperations: undo}]});
        const read = async id => (await api("block/getBlockDOM", {id})).dom;
        const cycle = async (id, options, prepare) => {
            const before = await read(id), snapshot = model.buildDocumentSnapshot(id, before);
            const tx = prepare ? prepare(snapshot) : model.prepareNormalization(snapshot, options, nodeID);
            assert.ok(tx.forward.length);
            await submit(tx.forward, tx.undo);
            const after = await read(id);
            const assertTargets = async dom => {
                const root = document.createElement("div"); root.innerHTML = dom;
                for (const anchor of root.querySelectorAll('[data-type~="block-ref"]')) {
                    assert.ok(anchor.dataset.id, "kernel must retain each native anchor target");
                    assert.ok((await api("block/getBlockDOM", {id: anchor.dataset.id})).dom, "native anchor resolves");
                }
            };
            await assertTargets(after);
            const undone = await api("transactions/undo", {rootID: id, app: "footnote-regression", session: "footnote-regression"});
            if (undone.failed) fs.writeFileSync(path.join(dir, "failed.json"), JSON.stringify({before, tx, after, undone}, null, 2));
            assert.ok(!undone.failed && undone.doOperations.length, JSON.stringify(undone));
            const restored = await read(id);
            assert.deepEqual(canonical(restored), canonical(before), "native undo restores original content, block IDs and hierarchy");
            await assertTargets(restored);
            const redone = await api("transactions/redo", {rootID: id, app: "footnote-regression", session: "footnote-regression"});
            assert.ok(!redone.failed && redone.doOperations.length);
            const replayed = await read(id);
            assert.deepEqual(canonical(replayed), canonical(after), "native redo restores the conversion");
            await assertTargets(replayed);
        };
        const insertionCycle = async (id, body) => {
            const root = document.createElement("div"); root.innerHTML = await read(id);
            const source = root.querySelector(`[data-node-id="${body}"]`);
            const editable = source.querySelector('[contenteditable="true"]');
            editable.append(document.createTextNode(" /jz"));
            const end = editable.textContent.length;
            await submit([{action: "update", id: body, data: source.outerHTML}]);
            await cycle(id, undefined, snapshot => model.prepareInsertion(snapshot, body, end - 3, end, "/jz", nodeID));
        };
        for (const layout of ["plain", "nested", "definitions-only", "definition-first"]) {
            const id = await api("filetree/createDocWithMd", {notebook, path: "/" + layout, markdown: "测试"});
            const body = nodeID(), a = nodeID(), b = nodeID(), quote = nodeID();
            const content = paragraph(body, `正文 ${ref(a, "[^A]")} [^B]`);
            const definitionA = paragraph(a, "[^A]: <strong>A 内容</strong>", layout === "nested" ? "NodeHeading" : "NodeParagraph");
            const definitionB = paragraph(b, `[^B]: B 内容 ${ref(a, "见 A")}`);
            let html = content + definitionA + definitionB;
            if (layout === "nested") html = content + `<div data-node-id="${quote}" data-type="NodeBlockquote" class="bq">${definitionA}${definitionB}</div>`;
            if (layout === "definitions-only") html = definitionA + definitionB;
            if (layout === "definition-first") html = definitionA + content + definitionB;
            const old = document.createElement("div"); old.innerHTML = await read(id);
            const root = document.createElement("div"); root.innerHTML = html;
            await submit([...Array.from(old.children, element => ({action: "delete", id: element.dataset.nodeId})),
                ...Array.from(root.children, (element, index) => ({action: "insert", id: element.dataset.nodeId,
                    data: element.outerHTML, parentID: id, previousID: root.children[index - 1]?.dataset.nodeId}))]);
            await submit(Array.from(root.querySelectorAll('[data-type="NodeParagraph"], [data-type="NodeHeading"]'))
                .filter(element => element.querySelector('[data-type~="block-ref"]'))
                .map(element => ({action: "update", id: element.dataset.nodeId, data: element.outerHTML})));
            await cycle(id, {format: "block", renumber: true, definitionFormat: "list"});
            if (layout === "plain") {
                const damaged = document.createElement("div"); damaged.innerHTML = await read(id);
                const source = damaged.querySelector(`[data-node-id="${body}"]`);
                const anchor = source.querySelector('[data-type~="block-ref"]');
                const expected = anchor.dataset.id;
                anchor.dataset.id = ""; anchor.dataset.subtype = "";
                await submit([{action: "update", id: body, data: source.outerHTML}]);
                const tx = model.prepareNormalization(model.buildDocumentSnapshot(id, await read(id)),
                    {format: "keep", renumber: false, definitionFormat: "list"}, nodeID);
                await submit(tx.forward, tx.undo);
                const repaired = document.createElement("div"); repaired.innerHTML = await read(id);
                assert.equal(repaired.querySelector('[data-type~="block-ref"]').dataset.id, expected);
                console.log("Kernel empty-target recovery passed");
                await insertionCycle(id, body);
            }
            await cycle(id, {format: "block", renumber: true, definitionFormat: "literal"});
            if (layout === "plain") await insertionCycle(id, body);
            console.log(`Kernel conversion/undo/redo passed: ${layout}`);
        }
        console.log("Kernel insertion/undo/redo passed: literal and list");
    } catch (error) {
        fs.writeFileSync(path.join(dir, "kernel.log"), logs); throw error;
    } finally {kernel.kill();}
})().catch(error => {console.error(error); process.exitCode = 1;});
