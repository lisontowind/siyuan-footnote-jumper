export interface StoredDefinition {
    id: string;
    content: string;
    blockId: string;
    candidates?: DefinitionCandidate[];
    listId?: string;
    itemId?: string;
}

export type DefinitionCandidate = Omit<StoredDefinition, "candidates">;

// Keep every candidate so loading, renaming or deleting one definition cannot
// silently hide another definition with the same label.
export function indexDefinitions(candidates: DefinitionCandidate[]) {
    const grouped = new Map<string, Map<string, DefinitionCandidate>>();
    for (const candidate of candidates) {
        if (!grouped.has(candidate.id)) {
            grouped.set(candidate.id, new Map());
        }
        grouped.get(candidate.id)!.set(candidate.blockId, candidate);
    }
    const definitions = new Map<string, StoredDefinition>();
    for (const [id, group] of grouped) {
        const entries = Array.from(group.values()).sort((a, b) => a.blockId.localeCompare(b.blockId));
        definitions.set(id, entries.length > 1 ? {...entries[0], candidates: entries} : entries[0]);
    }
    return definitions;
}

interface DefinitionRow {
    id: string;
    content: string;
}

export function parseDefinition(text: string) {
    const match = text.replace(/\u00a0/g, " ").trim().match(/^\[\^([^\]\s:]+)\]:\s*([\s\S]*)$/);
    return match ? {id: match[1], content: match[2].trim() || "空脚注"} : undefined;
}

/** Only direct items of the terminal ordered list qualify. Explicit definitions
 * take precedence over lists throughout the document; never mix both indexes. */
export function readOrderedDefinitions(root: HTMLElement | DocumentFragment, rootId?: string): DefinitionCandidate[] {
    const all = Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))
        .filter((block) => !block.closest('[data-type="NodeBlockQueryEmbed"]'));
    const scopeId = rootId || all.find((block) => block.dataset.type === "NodeDocument")?.dataset.nodeId;
    const top = all.filter((block) => {
        const parent = block.parentElement?.closest<HTMLElement>("[data-node-id]");
        return block.dataset.nodeId !== scopeId && (!parent || parent.dataset.nodeId === scopeId);
    });
    const result: DefinitionCandidate[] = [];
    for (const list of top.slice().reverse()) {
        if (list.dataset.type === "NodeParagraph" && !list.textContent?.trim()) continue;
        if (list.dataset.type !== "NodeList" || list.dataset.subtype !== "o") break;
        const items = (Array.from(list.children) as HTMLElement[]).filter((child) => child.dataset.type === "NodeListItem");
        const first = Number(items[0]?.dataset.marker?.match(/^(\d+)[.)]$/)?.[1] || "1");
        items.forEach((item, i) => {
            const block = (Array.from(item.children) as HTMLElement[]).find((child) => child.dataset.type === "NodeParagraph");
            if (!block?.dataset.nodeId) return;
            const content = (block.querySelector('[contenteditable="true"]') || block).textContent?.replace(/\u00a0/g, " ").trim();
            result.push({id: String(first + i), content: content || "空脚注", blockId: block.dataset.nodeId,
                listId: list.dataset.nodeId, itemId: item.dataset.nodeId});
        });
        break;
    }
    return result;
}

// An explicit LIMIT avoids SiYuan's configured search limit. Page by unique block ID
// so documents with many footnotes do not need one unbounded response.
export async function readDocumentDefinitions(
    rootId: string,
    query: (stmt: string) => Promise<DefinitionRow[]>,
    readTail?: () => Promise<DefinitionCandidate[]>,
) {
    const candidates: DefinitionCandidate[] = [];
    const quote = (value: string) => value.replace(/'/g, "''");
    const pageSize = 256;
    let cursor = "";
    while (true) {
        const rows = await query(`SELECT id, content FROM blocks WHERE root_id = '${quote(rootId)}'`
            + " AND type IN ('p', 'h') AND content LIKE '%[^%]:%'"
            + ` AND id > '${quote(cursor)}' ORDER BY id LIMIT ${pageSize}`);
        for (const row of rows) {
            const definition = parseDefinition(row.content);
            if (definition) {
                candidates.push({...definition, blockId: row.id});
            }
        }
        if (rows.length < pageSize) {
            return indexDefinitions(candidates.length || !readTail ? candidates : await readTail());
        }
        const nextCursor = rows[rows.length - 1].id;
        if (nextCursor <= cursor) {
            throw new Error("Footnote query did not advance");
        }
        cursor = nextCursor;
    }
}
