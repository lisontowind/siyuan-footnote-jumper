import {fetchSyncPost, Protyle} from "siyuan";
import {cleanFootnoteDOM, documentContentSignature} from "./document";

export const TABLE_SAVE_MESSAGE = "表格内容尚未保存完成，请稍后重试";

function tableSignature(block: HTMLElement) {
    const table = block.querySelector("table");
    if (!table) return undefined;
    const fragment = document.createDocumentFragment();
    fragment.append(table.cloneNode(true));
    cleanFootnoteDOM(fragment);
    return documentContentSignature(fragment);
}

/** Finish native table input and await the host's save barrier before reading
 * the complete kernel table. Never persist a possibly virtualized DOM copy. */
export async function flushDocumentEdits(editors: Protyle[], assertCurrent: () => void,
    tablePending: (block: HTMLElement) => boolean) {
    assertCurrent();
    const instances = Array.from(new Set(editors.filter(Boolean)));
    const roots = instances.map((editor) => editor.protyle.block.rootID);
    const check = () => {
        assertCurrent();
        if (instances.some((editor, index) => editor.protyle.block.rootID !== roots[index]
            || !editor.protyle.wysiwyg.element.isConnected)) throw new Error("当前文档已切换，请重新执行");
    };
    const selection = window.getSelection?.();
    const tables: {editor: Protyle; block: HTMLElement; pending: boolean}[] = [];
    for (const editor of instances) {
        for (const block of Array.from(editor.protyle.wysiwyg.element.querySelectorAll<HTMLElement>('[data-type="NodeTable"]'))) {
            if (block.dataset.type !== "NodeTable" || block.closest('[data-type="NodeBlockQueryEmbed"]')) continue;
            tables.push({editor, block, pending: tablePending(block) || Boolean(selection?.anchorNode && block.contains(selection.anchorNode))});
        }
    }
    const inTable = (node?: Node | null) => node && tables.some(({block}) => block.contains(node));
    const selectedInTable = inTable(selection?.anchorNode);
    const active = document.activeElement as HTMLElement;
    if (inTable(active) || (selectedInTable && instances.some((editor) => editor.protyle.wysiwyg.element.contains(active)))) active?.blur();
    // Toolbar clicks can leave the native selection in a table after blur.
    // Leave paragraph selections alone so slash insertion keeps its range.
    if (selectedInTable) selection.removeAllRanges();
    try {
        for (const editor of instances) {
            const flushable = editor as Protyle & {flushPendingTransactions?: () => Promise<void>};
            await flushable.flushPendingTransactions?.();
            check();
        }
    } catch (error) {
        check();
        throw new Error("保存编辑内容失败，请重试");
    }
    // Older hosts lack a save barrier. Wait for native autosave and verify full
    // table content rather than mistaking an active/display-dirty flag for it.
    const fallback = tables.filter(({editor, pending}) => pending
        && typeof (editor as Protyle & {flushPendingTransactions?: unknown}).flushPendingTransactions !== "function");
    for (let attempt = 0; fallback.length && attempt < 11; attempt++) {
        check();
        let saved = true;
        for (const {block} of fallback) {
            const response = await fetchSyncPost("/api/block/getBlockDOM", {id: block.dataset.nodeId});
            check();
            if (response.code !== 0 || typeof response.data?.dom !== "string") throw new Error("读取表格保存状态失败，请重试");
            const template = document.createElement("template");
            template.innerHTML = response.data.dom;
            const current = Array.from(template.content.querySelectorAll<HTMLElement>('[data-node-id]'))
                .find((item) => item.dataset.nodeId === block.dataset.nodeId);
            const signature = tableSignature(block);
            if (!current || signature === undefined || tableSignature(current) !== signature) saved = false;
        }
        if (saved) return;
        if (attempt < 10) await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    if (fallback.length) throw new Error(TABLE_SAVE_MESSAGE);
}
