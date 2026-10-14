const EXCLUDED = 'code, pre, script, style, textarea, input, [data-type~="code"], [data-type="NodeBlockQueryEmbed"], [data-siyuan-footnote-enhanced]';

export function readMarkers(nodes: Text[]) {
    const text = nodes.map((node) => node.data).join("");
    const regex = /\[\^([^\]\s:]+)\]/g;
    const matches: RegExpExecArray[] = [];
    let match: RegExpExecArray;
    while ((match = regex.exec(text))) matches.push(match);
    return matches;
}

// Formatting may divide a marker across nodes. Code, native refs, cells and
// nested blocks always separate runs so markers cannot cross those boundaries.
export function visitInline(block: HTMLElement, onRun: (nodes: Text[]) => void,
    onNative: (ref: HTMLElement) => void = () => {}) {
    if (block.closest('[data-type="NodeBlockQueryEmbed"], code, pre, [data-type~="code"]')) return;
    let run: Text[] = [];
    const flush = () => {if (run.length) onRun(run); run = [];};
    const walk = (node: Node) => {
        if (node.nodeType === 3) {run.push(node as Text); return;}
        if (node.nodeType !== 1) return;
        const element = node as HTMLElement;
        if (element !== block && (element.matches(EXCLUDED) || element.hasAttribute("data-node-id")
            || element.classList.contains("protyle-attr"))) {flush(); return;}
        if (element.matches('[data-type~="block-ref"]')) {flush(); onNative(element); return;}
        const boundary = ["TD", "TH", "BR"].indexOf(element.tagName) >= 0;
        if (boundary) flush();
        // Collect first; callbacks may change the tree when a run ends.
        for (const child of Array.from(node.childNodes)) walk(child);
        if (boundary) flush();
    };
    walk(block);
    flush();
}

export function replaceTextRun(nodes: Text[], start: number, end: number, replacement: Node) {
    let offset = 0;
    let inserted = false;
    for (const node of nodes) {
        const length = node.data.length;
        const from = Math.max(0, start - offset);
        const to = Math.min(length, end - offset);
        if (!inserted && start >= offset && (start < offset + length
            || (node === nodes[nodes.length - 1] && start === offset + length))) {
            const tail = node.ownerDocument.createTextNode(node.data.slice(from));
            node.data = node.data.slice(0, from);
            node.parentNode.insertBefore(tail, node.nextSibling);
            node.parentNode.insertBefore(replacement, tail);
            tail.data = tail.data.slice(Math.max(0, to - from));
            inserted = true;
        } else if (to > from && end > offset) {
            node.data = node.data.slice(0, from) + node.data.slice(to);
        }
        offset += length;
    }
    if (!inserted) throw new Error("无法恢复脚注插入位置，请重试");
}

/** Wrap one marker while retaining its rich inline content. Split only the
 * boundary ancestors; each marker remains one clickable element. */
export function wrapTextRun(nodes: Text[], start: number, end: number, wrapper: HTMLElement) {
    let offset = 0, first: Text, last: Text, from = 0, to = 0;
    for (const node of nodes) {
        const length = node.data.length;
        if (!first && start >= offset && start < offset + length) {first = node; from = start - offset;}
        if (end > offset && end <= offset + length) {last = node; to = end - offset; break;}
        offset += length;
    }
    if (!first || !last) throw new Error("无法恢复脚注标记位置");
    const same = first === last;
    const selected = first.ownerDocument.createTextNode(first.data.slice(from, same ? to : undefined));
    const tail = last.ownerDocument.createTextNode(last.data.slice(to));
    last.parentNode.insertBefore(tail, last.nextSibling);
    if (!same) last.data = last.data.slice(0, to);
    first.data = first.data.slice(0, from);
    first.parentNode.insertBefore(selected, first.nextSibling);
    let left: Node = selected, right: Node = same ? selected : last;
    let common = left.parentElement;
    while (!common.contains(right)) common = common.parentElement;
    while (left.parentElement !== common) {
        const parent = left.parentElement;
        const clone = parent.cloneNode(false);
        parent.parentNode.insertBefore(clone, parent.nextSibling);
        while (left) {const next = left.nextSibling; clone.appendChild(left); left = next;}
        left = clone;
    }
    while (right.parentElement !== common) {
        const parent = right.parentElement;
        const clone = parent.cloneNode(false);
        parent.parentNode.insertBefore(clone, parent);
        while (parent.firstChild) {
            const child = parent.firstChild;
            clone.appendChild(child);
            if (child === right) break;
        }
        right = clone;
    }
    common.insertBefore(wrapper, left);
    while (left) {
        const next = left.nextSibling;
        wrapper.appendChild(left);
        if (left === right) break;
        left = next;
    }
}
