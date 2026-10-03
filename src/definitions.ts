export interface StoredDefinition {
    id: string;
    content: string;
    blockId: string;
}

interface DefinitionRow {
    id: string;
    content: string;
}

export function parseDefinition(text: string) {
    const match = text.replace(/\u00a0/g, " ").trim().match(/^\[\^([^\]\s:]+)\]:\s*([\s\S]*)$/);
    return match ? {id: match[1], content: match[2].trim() || "空脚注"} : undefined;
}

// An explicit LIMIT avoids SiYuan's configured search limit. Page by unique block ID
// so documents with many footnotes do not need one unbounded response.
export async function readDocumentDefinitions(
    rootId: string,
    query: (stmt: string) => Promise<DefinitionRow[]>,
) {
    const definitions = new Map<string, StoredDefinition>();
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
                definitions.set(definition.id, {...definition, blockId: row.id});
            }
        }
        if (rows.length < pageSize) {
            return definitions;
        }
        const nextCursor = rows[rows.length - 1].id;
        if (nextCursor <= cursor) {
            throw new Error("Footnote query did not advance");
        }
        cursor = nextCursor;
    }
}
