import type {IOperation} from "siyuan";
import {parseDefinition, readOrderedDefinitions} from "./definitions";
import {replaceTextRun, visitInline} from "./inline";
export {replaceTextRun} from "./inline";

export const NATIVE_REF_CLASS = "siyuan-footnote-native-ref";
const BLOCK_TYPES = ["NodeParagraph", "NodeHeading", "NodeTable"];

export interface FootnoteReference {
    label: string;
    kind: "text" | "block";
    blockId: string;
    targetId?: string;
    definitionId?: string;
    heading: string;
    excerpt: string;
    order: number;
    start?: number;
    end?: number;
    native?: HTMLElement;
    run?: Text[];
}

export interface IndexedFootnote {
    key: string;
    label: string;
    blockId?: string;
    content: string;
    references: FootnoteReference[];
    duplicate: boolean;
    missing: boolean;
    listId?: string;
    itemId?: string;
}

export interface DocumentSnapshot {
    rootId: string;
    container: DocumentFragment;
    blocks: HTMLElement[];
    topLevel: HTMLElement[];
    notes: IndexedFootnote[];
    references: FootnoteReference[];
    signature: string;
    pending: boolean;
    definitionFormat: "literal" | "list";
    staleReferenceCount: number;
}

export interface NormalizationOptions {
    format: "block" | "text" | "keep";
    renumber: boolean;
    definitionFormat?: "literal" | "list";
}

export interface FootnoteTransaction {
    forward: IOperation[];
    undo: IOperation[];
    mapping: {from: string; to: string; blockId: string}[];
    referenceCount: number;
}

export function cleanFootnoteDOM(root: HTMLElement | DocumentFragment) {
    // Native references retain their identity; only text enhancements unwrap.
    for (const ref of Array.from(root.querySelectorAll<HTMLElement>('[data-siyuan-footnote-enhanced]'))) {
        ref.replaceWith(...Array.from(ref.childNodes));
    }
    const elements = Array.from(root.querySelectorAll<HTMLElement>("*"));
    if (root.nodeType === 1) elements.unshift(root as HTMLElement);
    for (const element of elements) {
        element.classList.remove(NATIVE_REF_CLASS, "siyuan-footnote-definition", "siyuan-footnote-definition--highlight");
        if (!element.className) element.removeAttribute("class");
        element.removeAttribute("data-footnote-id");
        element.removeAttribute("data-preview");
    }
    for (const caret of Array.from(root.querySelectorAll("wbr"))) caret.remove();
    root.normalize();
}

/** Compare content across native editing copies without view/save metadata.
 * Keep IDs, hierarchy, rich text, reference targets and custom attributes. */
export function documentContentSignature(dom: string | DocumentFragment) {
    let root: DocumentFragment;
    if (typeof dom === "string") {
        const template = document.createElement("template");
        template.innerHTML = dom;
        root = template.content;
    } else root = dom;
    const ignored = new Set(["updated", "data-node-index", "data-render", "contenteditable", "spellcheck"]);
    const visit = (node: Node): unknown => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1) return undefined;
        const element = node as HTMLElement;
        if (element.tagName === "WBR" || element.classList.contains("protyle-attr")) return undefined;
        const attributes = Array.from(element.attributes).filter((attribute) => !ignored.has(attribute.name))
            .map((attribute) => {
                let value = attribute.value;
                if (attribute.name === "class") value = value.split(/\s+/)
                    .filter((name) => name && [NATIVE_REF_CLASS, "siyuan-footnote-definition",
                        "siyuan-footnote-definition--highlight", "protyle-wysiwyg--select"].indexOf(name) < 0).sort().join(" ");
                return [attribute.name, value];
            }).filter(([name, value]) => name !== "class" || value)
            .sort((a, b) => a[0].localeCompare(b[0]));
        return [element.tagName, attributes, Array.from(element.childNodes, visit).filter((child) => child !== undefined)];
    };
    return JSON.stringify(Array.from(root.childNodes, visit).filter((child) => child !== undefined));
}

export function isFootnoteBlock(block: HTMLElement) {
    return BLOCK_TYPES.indexOf(block.dataset.type) >= 0
        && !block.closest('[data-type="NodeBlockQueryEmbed"]');
}

export function blockText(block: HTMLElement) {
    if (block.dataset.type === "NodeTable") {
        return Array.from(block.querySelectorAll("td, th")).map((cell) => cell.textContent || "").join(" | ").replace(/\u00a0/g, " ");
    }
    return (block.querySelector('[contenteditable="true"]') || block).textContent?.replace(/\u00a0/g, " ") || "";
}

function definition(block: HTMLElement) {
    return ["NodeParagraph", "NodeHeading"].indexOf(block.dataset.type) >= 0
        ? parseDefinition(blockText(block)) : undefined;
}

export function buildDocumentSnapshot(rootId: string, dom: string, overlays: HTMLElement[] = [], ignoredTargets = new Set<string>(),
    previousLabels = new Map<string, string>()) {
    const template = document.createElement("template");
    template.innerHTML = dom;
    const container = template.content;
    const kernelNodes = new Map(Array.from(container.querySelectorAll<HTMLElement>("[data-node-id]"))
        .filter((block) => !block.closest('[data-type="NodeBlockQueryEmbed"]'))
        .map((block) => [block.dataset.nodeId, block]));
    const kernelBlocks = new Map(Array.from(kernelNodes).filter(([, block]) => isFootnoteBlock(block)));
    const ranks = new Map(Array.from(kernelBlocks.keys()).map((id, i) => [id, i]));
    let pending = false;
    for (const editor of overlays) {
        const visibleNodes = Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]"))
            .filter((block) => !block.closest('[data-type="NodeBlockQueryEmbed"]'));
        const isolatedEditor = Boolean(editor.closest("[data-footnote-sidebar]"));
        for (const node of visibleNodes) {
            const original = kernelNodes.get(node.dataset.nodeId);
            if (!original) {pending = true; continue;}
            // Containers can be partially loaded. Compare metadata and ancestry,
            // never replace them with a potentially truncated editing copy.
            if (node.dataset.type !== original.dataset.type
                || node.dataset.subtype !== original.dataset.subtype
                || node.dataset.marker !== original.dataset.marker
                || (!isolatedEditor && (node.parentElement?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId || rootId)
                    !== (original.parentElement?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId || rootId))) pending = true;
        }
        const loaded = visibleNodes.filter(isFootnoteBlock);
        let previousRank = -1;
        for (const block of loaded) {
            const rank = ranks.get(block.dataset.nodeId);
            if (rank !== undefined) {
                // Unsaved moves cannot borrow the kernel's previous document order.
                if (rank < previousRank) pending = true;
                previousRank = rank;
            }
        }
        for (const block of loaded) {
            const original = kernelBlocks.get(block.dataset.nodeId);
            if (!original) {pending = true; continue;}
            // Virtualized tables always come from the full kernel DOM.
            if (block.dataset.type === "NodeTable") continue;
            const clone = block.cloneNode(true) as HTMLElement;
            original.replaceWith(clone);
            kernelBlocks.set(block.dataset.nodeId, clone);
        }
    }
    cleanFootnoteDOM(container);
    const all = Array.from(container.querySelectorAll<HTMLElement>("[data-node-id]"));
    const allIds = new Set(all.map((block) => block.dataset.nodeId));
    const blocks = all.filter(isFootnoteBlock);
    const topLevel = all.filter((block) => {
        const parent = block.parentElement?.closest<HTMLElement>("[data-node-id]");
        return block.dataset.nodeId !== rootId && (!parent || parent.dataset.nodeId === rootId);
    });
    let definitions = blocks.map((block) => ({block, parsed: definition(block), listId: undefined as string,
        itemId: undefined as string})).filter((item) => item.parsed);
    const definitionFormat = definitions.length ? "literal" : "list";
    const blocksById = new Map(blocks.map((block) => [block.dataset.nodeId, block]));
    if (!definitions.length) definitions = readOrderedDefinitions(container, rootId).map((note) => ({
        block: blocksById.get(note.blockId),
        parsed: {id: note.id, content: note.content}, listId: note.listId, itemId: note.itemId,
    })).filter((item) => item.block);
    const byBlock = new Map<string, IndexedFootnote>();
    const byLabel = new Map<string, IndexedFootnote[]>();
    for (const {block, parsed, listId, itemId} of definitions) {
        const note: IndexedFootnote = {key: block.dataset.nodeId, blockId: block.dataset.nodeId,
            label: parsed.id, content: parsed.content, references: [], duplicate: false, missing: false, listId, itemId};
        byBlock.set(note.blockId, note);
        if (!byLabel.has(note.label)) byLabel.set(note.label, []);
        byLabel.get(note.label).push(note);
    }
    for (const notes of byLabel.values()) for (const note of notes) note.duplicate = notes.length > 1;
    const byTarget = new Map(byBlock);
    for (const note of byBlock.values()) if (note.itemId) byTarget.set(note.itemId, note);
    // Stored labels keep text markers attached to their original definitions
    // after list items move, until the user explicitly refreshes the numbers.
    const textTargets = new Map<string, IndexedFootnote[]>();
    for (const {block} of definitions) {
        const note = byBlock.get(block.dataset.nodeId);
        const label = note.listId
            ? block.getAttribute("custom-footnote-label") || previousLabels.get(note.blockId) || note.label
            : note.label;
        if (!textTargets.has(label)) textTargets.set(label, []);
        textTargets.get(label).push(note);
    }
    for (const targets of textTargets.values()) if (targets.length > 1) for (const note of targets) note.duplicate = true;
    const missing = new Map<string, IndexedFootnote>();
    const definitionBlocks = new Set<string>();
    for (const item of definitions) {
        definitionBlocks.add(item.block.dataset.nodeId);
        if (item.listId) for (const block of Array.from(item.block.parentElement.querySelectorAll<HTMLElement>("[data-node-id]"))) {
            definitionBlocks.add(block.dataset.nodeId);
        }
    }
    const references: FootnoteReference[] = [];
    let heading = "";
    const add = (ref: FootnoteReference, targets: IndexedFootnote[]) => {
        references.push(ref);
        if (!targets.length) {
            const key = ref.kind === "block" ? `missing-block:${ref.targetId}` : `missing-label:${ref.label}`;
            if (!missing.has(key)) missing.set(key, {key, label: ref.label, content: "未找到脚注定义",
                references: [], duplicate: false, missing: true});
            targets = [missing.get(key)];
        }
        for (const target of targets) target.references.push(ref);
    };
    for (const block of blocks) {
        if (block.dataset.type === "NodeHeading") heading = blockText(block).trim();
        if (definitionBlocks.has(block.dataset.nodeId)) continue;
        const common = {blockId: block.dataset.nodeId, heading, excerpt: blockText(block).trim().slice(0, 180)};
        visitInline(block, (nodes) => {
            const text = nodes.map((node) => node.data).join("");
            const regex = /\[\^([^\]\s:]+)\]/g;
            let match: RegExpExecArray;
            while ((match = regex.exec(text))) add({...common, label: match[1], kind: "text",
                order: references.length, start: match.index, end: match.index + match[0].length, run: nodes},
            textTargets.get(match[1]) || []);
        }, (native) => {
            if (ignoredTargets.has(native.dataset.id)) return;
            // SiYuan can reference either a list item or its definition paragraph.
            // The displayed anchor may be [1], [^1], or a native dynamic anchor.
            const anchor = native.textContent?.trim();
            // Older conversions could save a native anchor while its target was
            // temporarily deleted. Repair only empty targets with an exact label.
            const orphanLabel = !native.dataset.id && anchor?.match(/^\[\^?([^\]\s:]+)\]$/)?.[1];
            const recovered = orphanLabel && byLabel.get(orphanLabel);
            const target = byTarget.get(native.dataset.id) || (recovered?.length === 1 ? recovered[0] : undefined);
            const marker = native.textContent?.trim().match(/^\[\^([^\]\s:]+)\]$/);
            // A marker-shaped broken native ref is diagnosable; arbitrary refs stay native.
            if (!target && !marker) return;
            if (!target && allIds.has(native.dataset.id)) return;
            add({...common, label: target?.label || marker[1], kind: "block", targetId: native.dataset.id,
                definitionId: target?.blockId, order: references.length, native}, target ? [target] : []);
        });
    }
    const notes = [...byBlock.values(), ...missing.values()].sort((a, b) =>
        (a.references[0]?.order ?? Infinity) - (b.references[0]?.order ?? Infinity));
    // Includes structure and non-footnote blocks so moves and appends invalidate reviews.
    const signature = Array.from(container.childNodes).map((node) =>
        node.nodeType === 1 ? (node as HTMLElement).outerHTML : node.textContent).join("");
    const staleReferenceCount = notes.filter((note) => !note.missing).reduce((count, note) => count
        + note.references.filter((ref) => ref.kind === "text" ? ref.label !== note.label
            : ref.native.textContent?.trim() !== `[^${note.label}]`
                && ref.native.textContent?.trim() !== `[${note.label}]`).length, 0);
    return {rootId, container, blocks, topLevel, notes, references, signature, pending,
        definitionFormat, staleReferenceCount} as DocumentSnapshot;
}

export function createNativeReference(label: string, targetId: string) {
    const ref = document.createElement("span");
    ref.dataset.type = "block-ref";
    ref.dataset.subtype = "s";
    ref.dataset.id = targetId;
    ref.textContent = `[${label}]`;
    return ref;
}

export function prepareNormalization(snapshot: DocumentSnapshot, options: NormalizationOptions,
    newId?: () => string): FootnoteTransaction {
    if (snapshot.pending) throw new Error("文档仍有待保存的块，请等待保存后重试");
    if (snapshot.notes.some((note) => note.duplicate || note.missing)) {
        throw new Error("存在重复编号或缺失定义，请先在侧栏定位并处理");
    }
    const before = new Map(snapshot.blocks.map((block) => [block.dataset.nodeId, block.outerHTML]));
    const labels = new Map<string, string>();
    const byLabel = new Map<string, IndexedFootnote>();
    for (const note of snapshot.notes) for (const ref of note.references) {
        if (ref.kind === "text") byLabel.set(ref.label, note);
    }
    const byBlock = new Map(snapshot.notes.map((note) => [note.blockId, note]));
    const mapping = snapshot.notes.map((note, i) => {
        const to = options.renumber ? String(i + 1) : note.label;
        labels.set(note.blockId, to);
        return {from: note.label, to, blockId: note.blockId};
    });
    // Apply text replacements right-to-left so offsets remain valid, including swaps.
    for (const ref of snapshot.references.slice().reverse()) {
        const note = ref.kind === "block" ? byBlock.get(ref.definitionId || ref.targetId) : byLabel.get(ref.label);
        const label = labels.get(note.blockId);
        const kind = options.format === "keep" ? ref.kind : options.format;
        const replacement = kind === "block" ? createNativeReference(label, note.blockId)
            : document.createTextNode(`[^${label}]`);
        if (ref.native) {
            if (kind === "block") {
                // Unwrapping a terminal list removes its item IDs. Point native
                // refs at the preserved paragraph before those items disappear.
                if (!ref.native.dataset.id || options.definitionFormat === "literal" && note.listId) ref.native.dataset.id = note.blockId;
                ref.native.dataset.subtype = "s";
                ref.native.textContent = `[${label}]`;
            } else ref.native.replaceWith(replacement);
        } else replaceTextRun(ref.run, ref.start, ref.end, replacement);
    }
    for (const block of snapshot.blocks) {
        const note = byBlock.get(block.dataset.nodeId);
        if (!note || note.listId || labels.get(note.blockId) === note.label) continue;
        const nodes: Text[] = [];
        const gather = (node: Node) => {
            if (node.nodeType === 3) nodes.push(node as Text);
            else for (const child of Array.from(node.childNodes)) gather(child);
        };
        gather(block.querySelector('[contenteditable="true"]') || block);
        const text = nodes.map((node) => node.data).join("");
        const match = text.match(/^\s*\[\^([^\]\s:]+)\]:/);
        if (!match) throw new Error("脚注定义已改变，请重试");
        const start = match[0].indexOf("[^") + 2;
        replaceTextRun(nodes, start, start + note.label.length, document.createTextNode(labels.get(note.blockId)));
    }
    if (options.definitionFormat) return normalizeDefinitionLayout(snapshot, options, labels, before, mapping, newId);
    const forward: IOperation[] = [], undo: IOperation[] = [];
    for (const block of snapshot.blocks) {
        if (block.outerHTML === before.get(block.dataset.nodeId)) continue;
        forward.push({action: "update", id: block.dataset.nodeId, data: block.outerHTML});
        undo.push({action: "update", id: block.dataset.nodeId, data: before.get(block.dataset.nodeId)});
    }
    return {forward, undo, mapping, referenceCount: snapshot.references.length};
}

function textNodes(block: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const gather = (node: Node) => {
        if (node.nodeType === 3) nodes.push(node as Text);
        else for (const child of Array.from(node.childNodes)) gather(child);
    };
    gather(block.querySelector('[contenteditable="true"]') || block);
    return nodes;
}

function normalizeDefinitionLayout(snapshot: DocumentSnapshot, options: NormalizationOptions, labels: Map<string, string>,
    before: Map<string, string>, mapping: FootnoteTransaction["mapping"], newId?: () => string): FootnoteTransaction {
    // Reconstruct original top-level HTML using the unmodified leaf blocks.
    const original = snapshot.topLevel.map((block) => {
        const clone = block.cloneNode(true) as HTMLElement;
        for (const leaf of Array.from(clone.querySelectorAll<HTMLElement>("[data-node-id]"))) {
            if (before.has(leaf.dataset.nodeId)) {
                const template = document.createElement("template");
                template.innerHTML = before.get(leaf.dataset.nodeId);
                leaf.replaceWith(template.content);
            }
        }
        return {id: block.dataset.nodeId, html: before.get(block.dataset.nodeId) || clone.outerHTML};
    });
    if (!snapshot.notes.length) return {forward: [], undo: [], mapping, referenceCount: 0};
    const alloc = () => {
        if (!newId) throw new Error("思源块 ID 生成器尚未就绪，请重试");
        return newId();
    };
    const destination = Array.from(snapshot.container.querySelectorAll<HTMLElement>("[data-node-id]"))
        .find((block) => block.dataset.nodeId === snapshot.rootId) || snapshot.container;
    const notes = options.renumber ? snapshot.notes : snapshot.notes.slice().sort((a, b) => Number(a.label) - Number(b.label));
    if (options.definitionFormat === "list" && !options.renumber
        && notes.some((note, i) => !/^[1-9]\d*$/.test(note.label) || (i > 0 && Number(note.label) !== Number(notes[i - 1].label) + 1))) {
        throw new Error("转为有序列表需要连续数字编号，请勾选连续编号");
    }
    const make = (type: string, className: string) => {
        const node = document.createElement("div");
        node.dataset.nodeId = alloc(); node.dataset.type = type; node.className = className;
        node.dataset.subtype = "o";
        return node;
    };
    let list: HTMLElement;
    if (options.definitionFormat === "list") {
        // Reuse an existing terminal list so repeated normalization is a no-op.
        const existing = snapshot.notes[0]?.listId;
        list = existing ? snapshot.topLevel.find((block) => block.dataset.nodeId === existing) : undefined;
        if (!list) list = make("NodeList", "list");
    }
    const items: HTMLElement[] = [];
    const touchedContainers = new Set<HTMLElement>();
    const blocks = new Map(snapshot.blocks.map((block) => [block.dataset.nodeId, block]));
    for (const note of notes) {
        const block = blocks.get(note.blockId);
        let ancestor = block.parentElement;
        while (ancestor) {
            if (["NodeListItem", "NodeList", "NodeBlockquote", "NodeSuperBlock"].indexOf(ancestor.dataset.type) >= 0) touchedContainers.add(ancestor);
            ancestor = ancestor.parentElement;
        }
        const nodes = textNodes(block);
        const prefix = nodes.map((node) => node.data).join("").match(/^\s*\[\^([^\]\s:]+)\]:\s*/);
        if (!note.listId && prefix) replaceTextRun(nodes, 0, prefix[0].length, document.createTextNode(""));
        if (options.definitionFormat === "literal") {
            const editable = block.querySelector('[contenteditable="true"]') || block;
            editable.insertBefore(document.createTextNode(`[^${labels.get(note.blockId)}]: `), editable.firstChild);
        }
        if (options.definitionFormat === "list") block.setAttribute("custom-footnote-label", labels.get(note.blockId));
        else block.removeAttribute("custom-footnote-label");
        const oldItem = note.listId ? block.parentElement : undefined;
        const unit = oldItem?.dataset.type === "NodeListItem" ? oldItem : block;
        if (options.definitionFormat === "list") {
            if (block.dataset.type === "NodeHeading") {
                block.dataset.type = "NodeParagraph";
                block.removeAttribute("data-subtype");
                block.classList.remove("h1", "h2", "h3", "h4", "h5", "h6");
                block.classList.add("p");
            }
            const item = unit === block ? make("NodeListItem", "li") : unit;
            item.dataset.marker = `${labels.get(note.blockId)}.`;
            item.dataset.subtype = "o";
            let action = item.querySelector<HTMLElement>(":scope > .protyle-action");
            if (!action) {action = document.createElement("div"); action.className = "protyle-action";
                action.setAttribute("draggable", "true"); item.insertBefore(action, item.firstChild);}
            action.textContent = item.dataset.marker;
            if (unit === block) item.append(block);
            items.push(item);
        } else {
            // Keep extra paragraphs/nested content when unwrapping a list item.
            const children = unit === block ? [block] : (Array.from(unit.children) as HTMLElement[])
                .filter((child) => child.hasAttribute("data-node-id"));
            if (note.listId) for (const child of children) destination.append(child);
            if (unit !== block) unit.remove();
        }
    }
    if (list) {for (const item of items) list.append(item); destination.append(list);}
    for (const container of touchedContainers) {
        if (!container.querySelector("[data-node-id]")) container.remove();
    }
    const after = Array.from(snapshot.container.querySelectorAll<HTMLElement>("[data-node-id]"))
        .filter((block) => {const parent = block.parentElement?.closest<HTMLElement>("[data-node-id]");
            return block.dataset.nodeId !== snapshot.rootId && (!parent || parent.dataset.nodeId === snapshot.rootId);});
    const forward: IOperation[] = [], undo: IOperation[] = [];
    const originalById = new Map(original.map((block) => [block.id, block]));
    const afterById = new Map(after.map((block) => [block.dataset.nodeId, block]));
    // Remove source blocks before inserting their IDs under the destination list.
    for (const old of original) if (!afterById.has(old.id)) forward.push({action: "delete", id: old.id});
    for (const block of after) {
        const old = originalById.get(block.dataset.nodeId);
        if (old && old.html !== block.outerHTML) forward.push({action: "update", id: old.id, data: block.outerHTML});
    }
    after.forEach((block, i) => {
        if (!originalById.has(block.dataset.nodeId)) forward.push({action: "insert", id: block.dataset.nodeId,
            data: block.outerHTML, parentID: snapshot.rootId, previousID: after[i - 1]?.dataset.nodeId});
    });
    const surviving = original.filter((old) => afterById.has(old.id)).map((old) => old.id);
    const survivingIds = new Set(surviving);
    const reordered = after.filter((block) => survivingIds.has(block.dataset.nodeId)).map((block) => block.dataset.nodeId);
    if (surviving.join() !== reordered.join()) after.forEach((block, i) => {
        if (survivingIds.has(block.dataset.nodeId)) forward.push({action: "move", id: block.dataset.nodeId,
            parentID: snapshot.rootId, previousID: after[i - 1]?.dataset.nodeId});
    });
    for (const block of after) if (!originalById.has(block.dataset.nodeId)) undo.push({action: "delete", id: block.dataset.nodeId});
    original.forEach((old, i) => {
        const next = afterById.get(old.id);
        if (!next) undo.push({action: "insert", id: old.id, data: old.html, parentID: snapshot.rootId,
            previousID: original[i - 1]?.id,
            nextID: i === 0 ? original.slice(1).find((block) => afterById.has(block.id))?.id : undefined});
        else if (next.outerHTML !== old.html) undo.push({action: "update", id: old.id, data: old.html});
    });
    if (surviving.join() !== reordered.join()) original.forEach((old, i) => undo.push({action: "move", id: old.id,
        parentID: snapshot.rootId, previousID: original[i - 1]?.id}));
    const originalDOM = document.createElement("template");
    originalDOM.innerHTML = original.map((block) => block.html).join("");
    return {forward: writeReferencesLast(forward, snapshot.container),
        undo: writeReferencesLast(undo, originalDOM.content), mapping, referenceCount: snapshot.references.length};
}

function writeReferencesLast(operations: IOperation[], desired: DocumentFragment) {
    if (!operations.length) return operations;
    const references = Array.from(desired.querySelectorAll<HTMLElement>("[data-node-id]"))
        .filter((block) => isFootnoteBlock(block) && block.querySelector('[data-type~="block-ref"]'));
    const ids = new Set(references.map((block) => block.dataset.nodeId));
    // The kernel validates block-ref targets when parsing each operation, even
    // inside a single transaction. Restore all targets before parsing anchors.
    // Reapply leaf refs inside inserted/updated containers for the same reason.
    return operations.filter((operation) => operation.action !== "update" || !ids.has(operation.id))
        .concat(references.map((block) => ({action: "update", id: block.dataset.nodeId, data: block.outerHTML})));
}

export function nextFootnoteLabel(snapshot: DocumentSnapshot) {
    const used = new Set([...snapshot.notes.map((note) => note.label), ...snapshot.references.map((ref) => ref.label)]);
    let value = 1;
    while (used.has(String(value))) value++;
    return String(value);
}

export function prepareInsertion(snapshot: DocumentSnapshot, sourceId: string, start: number, end: number,
    command: string, newId: () => string): FootnoteTransaction & {definitionId: string; label: string} {
    if (snapshot.pending) throw new Error("文档仍有待保存的块，请等待保存后重试");
    const source = snapshot.blocks.find((block) => block.dataset.nodeId === sourceId);
    if (!source || source.dataset.type === "NodeTable" || snapshot.notes.some((note) => note.blockId === sourceId) || definition(source)) {
        throw new Error("请在正文段落或标题中插入脚注");
    }
    const nodes: Text[] = [];
    const gather = (node: Node) => {
        if (node.nodeType === 3) nodes.push(node as Text);
        else for (const child of Array.from(node.childNodes)) gather(child);
    };
    gather(source.querySelector('[contenteditable="true"]') || source);
    if (nodes.map((node) => node.data).join("").slice(start, end) !== command) {
        throw new Error("正文或插入位置已改变，请重新执行斜杠菜单");
    }
    const ordered = snapshot.notes.filter((note) => note.listId);
    const label = ordered.length ? String(Math.max(...ordered.map((note) => Number(note.label))) + 1) : nextFootnoteLabel(snapshot);
    if (ordered.length && snapshot.notes.some((note) => note.missing && note.label === label)) {
        throw new Error("下一个列表序号已有缺失引用，请先修复后再插入");
    }
    const definitionId = newId();
    const oldHTML = source.outerHTML;
    replaceTextRun(nodes, start, end, createNativeReference(label, definitionId));
    const referenceUpdate: IOperation = {action: "update", id: sourceId, data: source.outerHTML};
    const forward: IOperation[] = [];
    const undo: IOperation[] = [{action: "update", id: sourceId, data: oldHTML}];
    const makeBlock = (id: string, heading: boolean, text: string) => {
        const block = document.createElement("div");
        block.dataset.nodeId = id;
        block.dataset.type = heading ? "NodeHeading" : "NodeParagraph";
        block.className = heading ? "h2" : "p";
        if (heading) block.dataset.subtype = "h2";
        const editable = document.createElement("div");
        editable.setAttribute("contenteditable", "true");
        editable.setAttribute("spellcheck", "false");
        editable.textContent = text;
        block.append(editable);
        const attrs = document.createElement("div");
        attrs.className = "protyle-attr";
        attrs.setAttribute("contenteditable", "false");
        block.append(attrs);
        return block.outerHTML;
    };
    const tail = snapshot.topLevel;
    if (ordered.length) {
        const last = ordered.slice().sort((a, b) => Number(b.label) - Number(a.label))[0];
        const list = tail.find((block) => block.dataset.nodeId === last.listId);
        const oldList = list.outerHTML;
        const template = document.createElement("template");
        template.innerHTML = makeBlock(definitionId, false, "");
        const block = template.content.firstElementChild as HTMLElement;
        block.setAttribute("custom-footnote-label", label);
        const item = document.createElement("div");
        item.dataset.nodeId = newId(); item.dataset.type = "NodeListItem";
        item.dataset.subtype = "o"; item.dataset.marker = `${label}.`; item.className = "li";
        const action = document.createElement("div"); action.className = "protyle-action";
        action.setAttribute("draggable", "true"); action.textContent = `${label}.`;
        item.append(action, block); list.append(item);
        forward.push({action: "update", id: list.dataset.nodeId, data: list.outerHTML});
        undo.unshift({action: "update", id: list.dataset.nodeId, data: oldList});
        return {forward: [...forward, referenceUpdate], undo, mapping: [], referenceCount: 1, label, definitionId};
    }
    // Reuse only a terminal top-level h2 section: no later h1/h2 ends it.
    let section = -1;
    tail.forEach((block, i) => {
        if (block.dataset.type !== "NodeHeading") return;
        const level = Number((block.dataset.subtype || "h1").slice(1));
        if (level <= 2) section = level === 2 && blockText(block).trim() === "脚注" ? i : -1;
    });
    let previousID = tail[tail.length - 1]?.dataset.nodeId;
    const insert = (id: string, html: string) => {
        forward.push({action: "insert", id, data: html, parentID: snapshot.rootId, previousID});
        undo.unshift({action: "delete", id});
        previousID = id;
    };
    if (section < 0) {
        const headingId = newId();
        insert(headingId, makeBlock(headingId, true, "脚注"));
    }
    insert(definitionId, makeBlock(definitionId, false, `[^${label}]: `));
    return {forward: [...forward, referenceUpdate], undo, mapping: [], referenceCount: 1, label, definitionId};
}

/** Apply normalization to loaded blocks before submitting the host transaction.
 * SiYuan leaves the active update and ordinary-editor deletes/moves to callers.
 * Missing insertion anchors belong to the kernel's unloaded document region. */
export function applyNormalizationToEditor(root: HTMLElement, transaction: FootnoteTransaction, rootId: string) {
    const find = (id: string) => Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))
        .find((block) => block.dataset.nodeId === id && !block.closest('[data-type="NodeBlockQueryEmbed"]'));
    // Validate before making any changes, including operations for unloaded blocks.
    const parsed = new Map<IOperation, HTMLElement>();
    for (const operation of transaction.forward) {
        if (operation.action !== "update" && operation.action !== "insert") continue;
        const template = document.createElement("template");
        template.innerHTML = operation.data;
        const element = template.content.firstElementChild as HTMLElement;
        if (template.content.childElementCount !== 1 || element?.dataset.nodeId !== operation.id) {
            throw new Error("脚注事务内容无效，请重新整理");
        }
        parsed.set(operation, element);
    }
    const restore: (() => void)[] = [];
    const remember = (element: HTMLElement) => {
        const parent = element.parentNode, next = element.nextSibling;
        restore.push(() => parent.insertBefore(element, next?.parentNode === parent ? next : null));
    };
    const rollback = () => {for (const undo of restore.slice().reverse()) undo();};
    try {
        for (const operation of transaction.forward) {
            const existing = find(operation.id);
            if (operation.action === "delete") {
                if (existing) {remember(existing); existing.remove();}
            } else if (operation.action === "update") {
                if (!existing) continue;
                const replacement = parsed.get(operation);
                restore.push(() => replacement.replaceWith(existing));
                existing.replaceWith(replacement);
            } else if (operation.action === "insert" || operation.action === "move") {
                if (operation.action === "insert" && existing) continue;
                const element = operation.action === "move" ? existing : parsed.get(operation);
                if (!element) continue;
                const previous = operation.previousID && find(operation.previousID);
                const next = operation.nextID && find(operation.nextID);
                const parent = operation.parentID === rootId ? find(rootId) || root : find(operation.parentID);
                // Do not append after a predecessor which is currently unloaded.
                if (operation.previousID ? !previous : operation.nextID ? !next : !parent) continue;
                if (existing) remember(existing);
                else restore.push(() => element.remove());
                if (previous) previous.after(element);
                else if (next) next.before(element);
                else {
                    const first = Array.from(parent.children).find((child) => child.hasAttribute("data-node-id"));
                    parent.insertBefore(element, first || null);
                }
            }
        }
    } catch (error) {rollback(); throw error;}
    return {rollback};
}

/** Materialize the editing copy before SiYuan submits the atomic transaction.
 * The host deliberately skips updating the block containing the current range.
 * Insertions whose predecessor is unloaded remain the kernel/loader's job. */
export function applyInsertionToEditor(root: HTMLElement, transaction: FootnoteTransaction,
    sourceId: string, definitionId: string) {
    const find = (id: string) => Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))
        .find((block) => block.dataset.nodeId === id && !block.closest('[data-type="NodeBlockQueryEmbed"]'));
    const parse = (html: string, id: string) => {
        const template = document.createElement("template");
        template.innerHTML = html;
        const element = template.content.firstElementChild as HTMLElement;
        if (template.content.childElementCount !== 1 || element?.dataset.nodeId !== id) {
            throw new Error("脚注事务内容无效，请重新插入");
        }
        return element;
    };
    const source = find(sourceId);
    const update = transaction.forward.find((operation) => operation.action === "update" && operation.id === sourceId);
    if (!source?.isConnected || typeof update?.data !== "string") throw new Error("正文或插入位置已改变，请重新执行");
    const replacement = parse(update.data, sourceId);
    const reference = Array.from(replacement.querySelectorAll<HTMLElement>('[data-type~="block-ref"]'))
        .find((ref) => ref.dataset.id === definitionId);
    if (!reference) throw new Error("脚注事务缺少正文标识，请重新插入");
    // Parse everything first so validation cannot leave a half-written editor.
    const inserts = transaction.forward.filter((operation) => operation.action === "insert")
        .map((operation) => ({operation, element: parse(operation.data, operation.id)}));
    const updates = transaction.forward.filter((operation) => operation.action === "update" && operation.id !== sourceId)
        .map((operation) => ({original: find(operation.id), element: parse(operation.data, operation.id)}));
    const inserted: HTMLElement[] = [];
    const rollback = () => {
        for (const element of inserted.slice().reverse()) element.remove();
        for (const {original, element} of updates) if (original && element.parentNode) element.replaceWith(original);
        if (replacement.parentNode) replacement.replaceWith(source);
    };
    try {
        source.replaceWith(replacement);
        for (const {original, element} of updates) original?.replaceWith(element);
        for (const {operation, element} of inserts) {
            if (find(operation.id)) continue;
            const previous = operation.previousID && find(operation.previousID);
            if (!previous) continue;
            previous.after(element);
            inserted.push(element);
        }
    } catch (error) {rollback(); throw error;}
    return {reference, rollback};
}
