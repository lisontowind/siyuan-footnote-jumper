// English tutorial plates. Live UI labels are translated only in this renderer;
// the plugin itself still uses Chinese. No production strings are changed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.FOOTNOTE_PLAYWRIGHT || 'playwright');
const {styles, setupHost, modules, root} = require('./render-guide.cjs');
const output = path.join(root, 'assets', 'guide', 'en_US');
const css = styles + `
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:21px}
    .plate{width:1280px;padding:40px 44px;min-height:760px}
    h1{font-size:38px;letter-spacing:-.6px}h2{font-size:24px;line-height:1.35}
    .subtitle{font-size:21px}.footer{font-size:15px;line-height:1.6}
    .live-row{gap:36px}.live-copy{padding-top:12px}
    .live-slot #dock.siyuan-footnote-sidebar{width:460px;zoom:1.15}
    .picker-slot{width:590px}.callout p{font-size:21px;line-height:1.6}
    .callout strong{font-size:24px}.mock{font-size:22px;line-height:1.7}
    .notes{font-size:21px;line-height:1.8}.hint{font-size:20px}
    .settings span{font-size:18px}.card{padding:24px}.strip{font-size:21px}
    #dock .siyuan-footnote-sidebar__field{gap:10px}
    #dock .siyuan-footnote-sidebar__check{white-space:normal}
    #dock [data-reference-format-field] select{min-width:175px}
`;

const labels = {
    '脚注':'Footnotes', '设置':'Settings', '自动刷新':'Auto refresh', '当前文档':'Current document',
    '定位':'Locate', '脚注原块':'Original footnote', '自动保存':'Auto save', '被引段落':'Referring paragraphs',
    '定位脚注原块':'Locate original footnote', '脚注偏好':'Footnote preferences',
    '设置后续插入的写法，也可整理当前文档。':'Set the style for future insertions or normalize this document.',
    '引用写法':'Reference style', '静态块引':'Static block reference', '文本标记':'Text marker',
    '用于后续插入；已有脚注通过「统一格式」转换。':'Applies to future insertions. Use Normalize format to convert existing footnotes.',
    '脚注跳转样式':'Footnote navigation styling', '编辑块实时刷新':'Refresh while editing a block',
    '用于正文文本标记的匹配、跳转、预览和上标；关闭编辑块实时刷新后，离开编辑块时自动匹配。面板列表由右上角「自动刷新」单独控制。':'Match, navigate, preview, and style body text markers. With live matching off, markers update when you leave the edited block. Auto refresh controls the panel separately.',
    '格式整理':'Format normalization', '定义格式':'Definition format', '文末有序列表':'Final ordered list',
    '[^编号]: 内容':'[^number]: content', '块引编号':'Block reference label', '[^编号]':'[^number]', '[编号]':'[number]',
    '文本标记固定使用 [^编号]: 内容，避免列表重排改变对应关系。':'Text markers use explicit definitions so list reordering cannot change their numbers.',
    '连续编号':'Sequential numbering', '引用使用上标':'Superscript references', '统一格式':'Normalize format',
    '确认后应用于当前文档，支持撤销。':'Apply to the current document after confirmation. Supports undo.',
    '刷新序号':'Refresh numbers', '文档检查':'Document checks',
    '查找重复编号，定位需要处理的脚注。':'Find duplicate numbers and locate conflicting definitions.',
    '检查重复脚注编号':'Check duplicate footnote numbers', '未引用':'Unreferenced',
    '插入脚注':'Insert footnote', '新建脚注':'Create footnote', '取消':'Cancel',
    '↑ ↓ 选择 · Enter 前往确认 · Esc 取消':'↑ ↓ Select · Enter focuses confirm · Esc cancels',
    '＋ 新建一条脚注':'+ Create a new footnote', '新脚注内容（可选）':'New footnote content (optional)',
    '编号自动分配，留空可在侧栏补充。':'Numbers are assigned automatically. Leave blank to edit later in the sidebar.',
    '输入编号或内容，搜索已有脚注':'Search existing footnotes by number or content',
    '填写新脚注内容，编号自动分配':'Enter content; a number will be assigned automatically',
    '按编号定位，如 12':'Find by number, e.g. 12',
    '当前文档没有引用此脚注。':'No references to this footnote in the current document.',
    '选择脚注后，查看引用它的正文段落。':'Select a footnote to view its referring paragraphs.',
};

async function translateLive(page) {
    await page.evaluate(labels => {
        const translate = value => {
            const text = value.trim();
            if (labels[text]) return value.replace(text, labels[text]);
            return value
                .replace(/已定位脚注 (.+)。/g, 'Located footnote $1.')
                .replace(/(\d+) 个脚注 · (\d+) 处引用/g, '$1 footnotes · $2 references')
                .replace(/(\d+) 处引用/g, '$1 references')
                .replace(/ · (\d+) 次/g, (_, count) => ` · ${count} ${count === '1' ? 'reference' : 'references'}`)
                .replace(/共 (\d+) 条脚注，选择已有脚注或新建。/g, '$1 footnotes. Select one or create a new footnote.')
                .replace(/格式不符合偏好：(.+)。请点击“统一格式”。/g, (_, issues) =>
                    'Format differs from preferences: ' + issues.split('、').map(issue => labels[issue] || ({'引用上标':'Superscript references'}[issue]) || issue).join(', ') + '. Use Normalize format.');
        };
        const walker = document.createTreeWalker(document.querySelector('.plate'), NodeFilter.SHOW_TEXT);
        const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) node.nodeValue = translate(node.nodeValue);
        for (const element of document.querySelectorAll('[placeholder], [title], [aria-label]')) {
            for (const attr of ['placeholder', 'title', 'aria-label']) {
                if (element.hasAttribute(attr)) element.setAttribute(attr, translate(element.getAttribute(attr)));
            }
        }
    }, labels);
}

const callout = (n, title, text) => `<div class="callout"><span class="number">${n}</span><div><strong>${title}</strong><p>${text}</p></div></div>`;
const liveFooter = 'Guide illustration using the plugin layout • UI labels translated for this guide; the plugin interface is currently Chinese.';
const diagramFooter = 'Workflow diagram • English guide to Footnote Jumper';

async function plate(page, step, title, subtitle, content, live = false) {
    await page.setContent(`<html lang="en"><meta charset="utf-8"><style>${css}</style><div class="plate">
        <div class="eyebrow">${step}</div><h1>${title}</h1><div class="subtitle">${subtitle}</div>
        ${content}<div class="footer">${live ? liveFooter : diagramFooter}</div></div></html>`);
}

async function livePlate(page, step, title, subtitle, copy, picker = false) {
    await plate(page, step, title, subtitle, `<div class="live-row"><div class="live-copy">${copy}</div><div class="live-slot">
        <aside id="dock" ${picker ? 'style="position:absolute;left:-10000px"' : ''}></aside>${picker ? '<div class="picker-slot"></div>' : ''}
        </div></div><main class="main protyle-wysiwyg"></main>`, true);
    await page.addStyleTag({content:fs.readFileSync(path.join(root, 'dist', 'index.css'), 'utf8')});
    await page.addStyleTag({content:css});
    await page.evaluate(setupHost, modules);
    await page.evaluate(async picker => {
        h.main.protyle.title.editElement.textContent = 'Reading notes';
        await h.reset(h.block('title', 'Reading notes', 'NodeHeading', 'data-subtype="h2"')
            + h.block('body', 'Add background to explain this concept [^1].' + (picker ? ' /jz' : ''))
            + h.block('second', 'The same concept appears again [^1].')
            + h.block('a', '[^1]: <b>Background</b> without interrupting the main text.')
            + h.block('unused', '[^2]: Additional context, not yet referenced.'));
    }, picker);
    await page.waitForFunction(() => document.querySelector('[data-note-key="a"]'));
}

async function save(page, filename, live = false) {
    if (live) await translateLive(page);
    await page.evaluate(() => document.fonts.ready);
    const problems = await page.evaluate(() => {
        const plate = document.querySelector('.plate').getBoundingClientRect();
        const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
        const overflow = Array.from(document.querySelectorAll('.card,.mock,.strip,.live-copy,#dock button,#dock input,#dock select,[role=dialog] button,[role=dialog] textarea'))
            .filter(visible).filter(node => node.scrollWidth > node.clientWidth + 2 || node.getBoundingClientRect().right > plate.right + 1)
            .map(node => node.textContent || node.getAttribute('placeholder'));
        const panels = Array.from(document.querySelectorAll('#dock .siyuan-footnote-sidebar__panel:not([hidden])'))
            .filter(node => node.scrollHeight > node.clientHeight + 2).map(node => node.dataset.panelContent);
        const untranslated = document.querySelector('.plate').innerText.match(/[\u3400-\u9fff]+/g) || [];
        return {overflow, panels, untranslated};
    });
    assert.deepEqual(problems, {overflow:[], panels:[], untranslated:[]}, `${filename}: readable, complete English plate`);
    await page.locator('.plate').screenshot({path:path.join(output, filename)});
    console.log(`Rendered en_US/${filename}`);
}

(async () => {
    fs.mkdirSync(output, {recursive:true});
    const browser = await chromium.launch({headless:true, executablePath:process.env.FOOTNOTE_BROWSER_EXECUTABLE});
    try {
        const page = await browser.newPage({viewport:{width:1280,height:1100},deviceScaleFactor:1});
        await livePlate(page, '01 / INSERT A FOOTNOTE', 'Reuse a footnote, or write a new one',
            'Body paragraph or heading → slash menu → Insert footnote → select and confirm.',
            callout(1, 'Open the slash menu', 'Type / and search for footnote or jz.<br>Choose Insert footnote.')
            + callout(2, 'Search existing footnotes', 'Find a number or phrase. Select a result,<br>then click Insert footnote to reuse it.')
            + callout(3, 'Create with content', 'Choose Create a new footnote, enter<br>content, and click Create footnote.')
            + '<div class="strip">Default: a native superscript block reference <code>[^number]</code>.<br>Only confirmation writes to the note.</div>', true);
        await page.evaluate(async () => {
            const editable = h.mainElement.querySelector('[data-node-id="body"] [contenteditable="true"]');
            const range = document.createRange(); range.setStart(editable.firstChild, editable.textContent.length - 3); range.setEnd(editable.firstChild, editable.textContent.length);
            getSelection().removeAllRanges(); getSelection().addRange(range); h.main.protyle.toolbar = {range};
            await h.manager.insert(h.main, h.mainElement.querySelector('[data-node-id="body"]'));
            document.querySelector('.picker-slot').append(document.querySelector('[role="dialog"]'));
            document.querySelector('#dock').style.display = 'none';
        });
        await page.waitForFunction(() => !document.querySelector('[data-picker-create]').disabled);
        await page.locator('[data-picker-create]').click();
        await page.locator('[data-picker-content]').fill('Add background to help explain the concept in the main text.');
        await save(page, '01-insert.png', true);

        await livePlate(page, '02 / FOOTNOTES PANEL', 'Find by number. Edit the original footnote.',
            'Open Footnotes from the right dock. Switch between Footnotes and Settings.',
            callout(1, 'Jump straight to a number', 'Enter 1, [^1], or [1], then press Enter<br>or click Locate. Distant items load directly.')
            + callout(2, 'Check content and references', 'See reference counts and missing,<br>duplicate, or unreferenced footnotes.')
            + callout(3, 'Edit in place, with auto save', 'Use SiYuan rich text. For explicit<br>definitions, keep the [^number]: prefix.')
            + callout(4, 'Find referring paragraphs', 'Click a body excerpt to return to its<br>location, or locate the original footnote.')
            + '<div class="strip">Switching panels preserves the selected footnote and editing state.</div>');
        await page.locator('[data-note-key="a"]').click();
        await page.locator('[data-locate-number]').fill('1');
        await page.locator('[data-action="locate-number"]').click();
        await save(page, '02-sidebar.png', true);

        await livePlate(page, '07 / SETTINGS PANEL', 'Choose preferences, then normalize',
            'Preferences are saved immediately. Existing content changes after confirmation.',
            callout(1, 'Set the reference style', 'New references use this preference.<br>Static block references are the default.')
            + callout(2, 'Choose definitions and labels', 'Use a final ordered list or explicit<br>definitions; choose [^number] or [number].')
            + callout(3, 'Review and confirm', 'Sequential numbering and superscript<br>are enabled by default. One undo restores.')
            + callout(4, 'Check for conflicts', 'Review format hints or check duplicate<br>numbers before normalizing.')
            + '<div class="strip">Text marker mode shows navigation and live-matching options and uses explicit definitions.</div>');
        await page.locator('[data-panel="settings"]').click();
        await save(page, '07-settings.png', true);

        await plate(page, '03 / TEXT MARKER NAVIGATION', 'Preview, follow, and return to the body',
            'Enable Footnote navigation styling for text markers. Block references use native SiYuan interactions.',
            `<div class="row"><div class="card"><h2><span class="number">1</span>Hover to preview</h2><div class="mock">Explain a concept<span class="marker">[^1]</span><div class="preview"><div class="label">Footnote content</div>Additional context.<br>Scroll long footnotes<br>or select their text.</div></div><p class="hint">No need to scroll to the end.</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">2</span>Click to locate</h2><div class="mock"><div class="note-title">End of document · Footnotes</div><div style="border-left:3px solid #3266cf;padding-left:12px;background:#edf4ff"><code>[^1]:</code><br>Additional context.</div></div><p class="hint">Unloaded definitions are loaded and brought into view.</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">3</span>Return to reading</h2><div class="mock">Back to the passage<span class="marker">[^1]</span><div class="return">↩ Return to body [^1]</div></div><p class="hint">The bottom-right button returns to the most recently clicked reference.</p></div></div>
            <div class="strip">Both text markers and footnote block references support previews. Plain text <code>[1]</code> is not a block reference; create one with Insert footnote or format conversion.</div>`);
        await save(page, '03-navigation.png');

        await plate(page, '04 / NORMALIZE FORMAT', 'Number footnotes by their first appearance',
            'Settings → choose target format → Normalize format → review scope and numbering → confirm.',
            `<div class="settings"><span>Static block references</span><span>Final ordered list</span><span>Labels: [^number]</span><span>☑ Sequential numbering</span><span>☑ Superscript</span></div>
            <div class="row"><div class="card"><div class="label">BEFORE · Explicit definitions + text markers</div><div class="line">B comes first <code>[^8]</code>, then A <code>[^3]</code>.</div><div class="line">B is referenced again <code>[^8]</code>.</div><div class="notes"><div><code>[^3]:</code> Content of A</div><div><code>[^8]:</code> Content of B</div><div><code>[^9]:</code> Unreferenced content</div></div></div><div class="arrow">→</div>
            <div class="card"><div class="label">AFTER · Static block references + final list</div><div class="line">B comes first <span class="marker">[^1]</span>, then A <span class="marker">[^2]</span>.</div><div class="line">B is referenced again <span class="marker">[^1]</span>.</div><div class="notes"><div>1. Content of B</div><div>2. Content of A</div><div>3. Unreferenced content</div></div></div></div>
            <div class="strip">Repeated references share one number. Unreferenced definitions go last.<br>Rich text and content are preserved; one undo restores the operation.</div>`);
        await save(page, '04-normalize.png');

        await plate(page, '05 / REFRESH NUMBERS', 'Reordered the list? Refresh the body labels.',
            'Refresh numbers follows the current list order and preserves the original reference targets.',
            `<div class="row"><div class="card"><h2><span class="number">1</span>Original order</h2><div class="mock">Body refers to A <span class="marker">[^1]</span><div class="notes"><div>1. Content of A</div><div>2. Content of B</div></div></div><p class="hint">The reference targets A.</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">2</span>List reordered</h2><div class="mock">Label still shows <span class="marker">[^1]</span><div class="notes"><div>1. Content of B</div><div>2. Content of A</div></div></div><p class="hint warning">Numbers changed. Refresh needed.</p><div class="menu">Refresh numbers → Confirm</div></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">3</span>Label updated</h2><div class="mock">Body refers to A <span class="marker">[^2]</span><div class="notes"><div>1. Content of B</div><div>2. Content of A</div></div></div><p class="hint success">Still targets A. List order is kept.</p></div></div>
            <div class="strip">To reorder footnotes by first appearance in the body and start numbering from 1, use Normalize format with Sequential numbering enabled.</div>`);
        await save(page, '05-refresh.png');

        await plate(page, '06 / NORMALIZE AFTER TABLE EDITING', 'Finish table editing, save, then normalize',
            'Applies to Normalize format and Refresh numbers in the Settings panel.',
            `<div class="row"><div class="card"><h2><span class="number">1</span>Start the action</h2><div class="mock"><div class="note-title">A reference was edited in a table</div>Additional context <code>[^1]</code><div class="menu">Click Normalize format</div></div><p class="hint">The table editing selection ends automatically. Usually no need to click outside the table.</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">2</span>Wait for saving</h2><div class="mock"><div class="label">SiYuan native save</div>Read the complete table.<br>Check that saving finished.</div><p class="hint">Includes rows that have not loaded on screen, so no table content is missed.</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">3</span>Confirm and apply</h2><div class="mock"><div class="note-title">Review scope, format, and numbers</div>Confirm → Apply changes<div class="menu">Supports a single undo</div></div><p class="hint">If content changes during confirmation, check and confirm again.</p></div></div>
            <div class="save-barrier">If saving fails or cannot be confirmed, the action stops and prompts you to retry after saving.<br>Finish input-method composition before starting normalization.</div>`);
        await save(page, '06-save.png');
    } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
