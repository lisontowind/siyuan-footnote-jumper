// Render the illustrated README. The sidebar uses the actual plugin in the
// existing browser host; the other plates are explicitly labelled diagrams.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");
const {chromium} = require(process.env.FOOTNOTE_PLAYWRIGHT || "playwright");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "assets", "guide");
const hostSource = fs.readFileSync(path.join(__dirname, "verify-browser.cjs"), "utf8");
const hostStart = hostSource.indexOf("function setupHost(modules) {");
const hostEnd = hostSource.indexOf("\n(async () =>", hostStart);
assert.ok(hostStart >= 0 && hostEnd > hostStart, "Browser host was not found");
const setupHost = new Function(`return (${hostSource.slice(hostStart, hostEnd).trim()});`)();
const modules = Object.fromEntries(["inline", "definitions", "document", "editing", "sidebar", "manager", "index"].map(name => ["./" + name,
    ts.transpileModule(fs.readFileSync(path.join(root, "src", name + ".ts"), "utf8"), {
        compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
    }).outputText]));

const styles = `
    :root{--b3-theme-on-background:#253448;--b3-theme-background:#fff;--b3-theme-on-surface:#63758a;--b3-theme-primary:#3266cf;--b3-theme-primary-light:#adc6f7;--b3-theme-primary-lightest:#edf4ff;--b3-theme-surface:#f4f7fb;--b3-border-color:#dce4ef;--b3-theme-error:#bc4545}
    *{box-sizing:border-box}body{margin:0;background:#f1f5fa;color:#253448;font:22px 'Microsoft YaHei','Segoe UI',sans-serif}
    .plate{padding:38px 42px;width:1120px;min-height:680px;position:relative}
    .eyebrow{font-size:15px;letter-spacing:2px;color:#3266cf;font-weight:700;margin-bottom:10px}
    h1{margin:0 0 12px;font-size:36px;letter-spacing:-1px}h2{font-size:24px;margin:0 0 20px}
    .subtitle{font-size:20px;color:#63758a;line-height:1.6;margin-bottom:28px}.row{display:flex;gap:20px;align-items:stretch}
    .card{background:#fff;border:1px solid #dce4ef;border-radius:16px;padding:26px;flex:1;min-width:0}
    .number{display:inline-grid;place-items:center;background:#3266cf;color:#fff;width:34px;height:34px;border-radius:50%;font-size:20px;font-weight:700;margin-right:9px;vertical-align:middle}
    .tag{font-size:16px;color:#63758a;margin-bottom:16px}.mock{border:1px solid #dce4ef;background:#f8fafd;border-radius:10px;padding:20px;line-height:1.9;font-size:22px}
    .marker{color:#3266cf;font-weight:700;font-size:17px;vertical-align:super}.command{border-bottom:2px solid #3266cf;color:#3266cf}
    .menu{margin-top:18px;border:1px solid #adc6f7;border-radius:8px;background:#edf4ff;padding:12px 15px;font-size:20px;color:#3266cf}
    .hint{font-size:18px;color:#63758a;line-height:1.7;margin:20px 0 0}.arrow{font-size:30px;color:#3266cf;align-self:center;flex:none}
    .strip{margin-top:24px;border-left:4px solid #3266cf;border-radius:0 9px 9px 0;background:#e6eefb;padding:17px 22px;font-size:20px;line-height:1.6}
    .footer{margin-top:25px;font-size:15px;color:#7a899b}.label{font-size:17px;font-weight:600;color:#3266cf;margin-bottom:13px}
    code{font-family:Consolas,'Microsoft YaHei',monospace;font-size:.95em;background:#edf2f8;padding:2px 4px;border-radius:4px}
    .line{margin-bottom:15px;line-height:1.8}.notes{margin-top:26px;padding-top:20px;border-top:1px solid #dce4ef;font-size:22px;line-height:2}
    .note-title{font-size:18px;color:#63758a;font-weight:600;margin-bottom:7px}.success{color:#247653;font-weight:600}.warning{color:#a66319}
    .settings{display:flex;gap:10px;margin:0 0 24px;flex-wrap:wrap}.settings span{background:#e7effd;color:#3266cf;border-radius:6px;padding:8px 13px;font-size:19px}
    .preview{background:#f4f7fb;border:1px solid #dce4ef;border-radius:8px;margin-top:22px;padding:17px;font-size:20px;line-height:1.7;box-shadow:0 6px 18px #21395412}
    .return{margin-top:30px;display:inline-block;background:#f4f7fb;border:1px solid #cbd7e8;border-radius:7px;padding:10px 15px;font-size:18px}
    .callout{display:flex;gap:13px;margin:0 0 27px;align-items:flex-start}.callout .number{flex:none}.callout strong{font-size:24px;display:block;margin-bottom:9px}.callout p{font-size:20px;color:#63758a;line-height:1.7;margin:0}
    #dock{width:500px;border:1px solid #dce4ef;border-radius:12px;overflow:hidden;flex:none;background:#fff}
    .main{display:none}.block__icons{display:flex;align-items:center;padding:13px 15px;gap:8px;background:#f8fafd;border-bottom:1px solid #dce4ef}
    .block__logo{display:flex;align-items:center;font-weight:600;gap:5px}.fn__flex-1{flex:1}svg{width:18px;height:18px}.block__icon{cursor:pointer;background:transparent;border:0;color:#63758a}
    .b3-button{padding:7px 11px;border:1px solid #adc6f7;color:#3266cf;background:#fff;border-radius:5px;font:inherit}.b3-select{padding:4px;font:inherit;border:1px solid #cbd7e8;border-radius:4px}
    .protyle-attr{display:none}[contenteditable]{outline:none}
    /* Enlarge the complete live panel uniformly; keep its actual layout and typography. */
    #dock.siyuan-footnote-sidebar{zoom:1.25;width:400px;height:auto}
    .siyuan-footnote-sidebar__editor [data-node-id]{padding:8px 16px;line-height:1.8}
    .pin{display:inline-grid;place-items:center;width:21px;height:21px;border-radius:50%;background:#3266cf;color:#fff;font:700 13px 'Segoe UI';margin-right:6px;vertical-align:middle;flex:none}
    .siyuan-footnote-sidebar__display-toggle > span{display:flex;align-items:center}
    .save-barrier{margin-top:24px;border:1px solid #e8ccaa;background:#fff8ee;color:#87551b;border-radius:10px;padding:18px 22px;font-size:20px;line-height:1.7}
    .live-row{display:flex;gap:28px;align-items:flex-start}.live-copy{flex:1;padding:20px 0}.live-slot{flex:none}
    .live-slot #dock.siyuan-footnote-sidebar{height:auto;zoom:1.15;width:410px}
    .live-slot .siyuan-footnote-sidebar__panel{flex:none;overflow:visible}
    .b3-text-field{font:inherit;padding:8px 10px;border:1px solid #cbd7e8;border-radius:5px;background:#fff;color:inherit}
    .picker-slot{width:570px;flex:none}.picker-slot [role=dialog]{position:static!important;transform:none!important;width:100%!important;border:1px solid #dce4ef!important;border-radius:12px;overflow:hidden;box-shadow:0 6px 24px #21395412!important;font-size:16px}
    .picker-slot .siyuan-footnote-picker{padding:24px}.picker-slot .b3-text-field{width:100%}
`;

async function render(page, filename, html) {
    await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style>${html}</html>`);
    await page.evaluate(() => document.fonts.ready);
    // Catch clipped text and unintended horizontal overflow before saving.
    const overflowing = await page.evaluate(() => Array.from(document.querySelectorAll('.card,.mock,.strip'))
        .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className));
    assert.deepEqual(overflowing, [], `${filename}: horizontal overflow`);
    await page.locator('.plate').screenshot({path: path.join(output, filename)});
}

async function livePage(page, eyebrow, title, subtitle, copy, slot = '<aside id="dock"></aside>', command = false) {
    await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><div class="plate">
        <div class="eyebrow">${eyebrow}</div><h1>${title}</h1><div class="subtitle">${subtitle}</div>
        <div class="live-row"><div class="live-copy">${copy}</div><div class="live-slot">${slot}</div></div>
        <main class="main protyle-wysiwyg"></main><div class="footer">当前插件界面 · 使用浏览器模拟思源宿主，实际外观随主题变化</div></div></html>`);
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'dist','index.css'),'utf8')});
    await page.addStyleTag({content:styles});
    await page.evaluate(setupHost, modules);
    await page.evaluate(async command => {
        h.main.protyle.title.editElement.textContent = '阅读笔记';
        await h.reset(h.block('title','阅读笔记','NodeHeading','data-subtype="h2"')
            + h.block('body','理解概念时，可以补充背景 [^1]。' + (command ? ' /jz' : ''))
            + h.block('second','再次提到同一个概念 [^1]。')
            + h.block('a','[^1]: <b>背景说明</b>，不打断正文阅读。')
            + h.block('unused','[^2]: 尚未引用的补充内容。'));
    }, command);
    await page.waitForFunction(() => document.querySelector('[data-note-key="a"]'));
}

async function saveLive(page, filename) {
    await page.evaluate(() => document.fonts.ready);
    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('#dock button, #dock input, #dock select, [role=dialog] button, [role=dialog] textarea'))
        .filter(node => node.getClientRects().length && (node.getBoundingClientRect().right > document.querySelector('.plate').getBoundingClientRect().right || node.scrollWidth > node.clientWidth + 2))
        .map(node => node.getAttribute('aria-label') || node.textContent));
    assert.deepEqual(clipped, [], `${filename}: controls must be readable`);
    const hiddenBottom = await page.evaluate(() => Array.from(document.querySelectorAll('#dock .siyuan-footnote-sidebar__panel:not([hidden])'))
        .filter(panel => panel.scrollHeight > panel.clientHeight + 2).map(panel => panel.dataset.panelContent));
    assert.deepEqual(hiddenBottom, [], `${filename}: the whole panel must be visible`);
    await page.locator('.plate').screenshot({path:path.join(output,filename)});
}

module.exports = {styles, setupHost, modules, root};

if (require.main === module) (async () => {
    fs.mkdirSync(output, {recursive: true});
    const browser = await chromium.launch({headless: true, executablePath: process.env.FOOTNOTE_BROWSER_EXECUTABLE});
    try {
        const page = await browser.newPage({viewport: {width:1120,height:940},deviceScaleFactor:1});
        const callout = (n, title, text) => '<div class="callout"><span class="number">'+n+'</span><div><strong>'+title+'</strong><p>'+text+'</p></div></div>';
        const pickerCopy = callout(1,'在正文输入 /脚注','也可搜索 footnote 或 jz，<br>选择“插入脚注”打开右侧弹窗。')
            + callout(2,'搜索已有脚注','按编号或内容搜索，点击或用上下键选中，<br>再点击“插入脚注”确认复用。')
            + callout(3,'新建并填写内容','选择“新建一条脚注”，填写内容，<br>点击“新建脚注”；编号自动分配。')
            + '<div class="strip">默认插入原生上标块引 <code>[^编号]</code>；新文档默认创建文末有序列表。<br>仅点击确认按钮后才写入笔记。</div>';
        await livePage(page,'01 / 插入脚注','先选择已有脚注，或填写新内容','正文段落或标题 → 斜杠菜单 → 插入脚注 → 选择后确认。',pickerCopy,
            '<aside id="dock" style="position:absolute;left:-10000px"></aside><div class="picker-slot"></div>', true);
        await page.evaluate(async () => {
            // Use the body rather than the heading as the command source.
            const editable = h.mainElement.querySelector('[data-node-id="body"] [contenteditable="true"]');
            const range = document.createRange(); range.setStart(editable.firstChild, editable.textContent.length - 3); range.setEnd(editable.firstChild, editable.textContent.length);
            getSelection().removeAllRanges(); getSelection().addRange(range); h.main.protyle.toolbar = {range};
            await h.manager.insert(h.main, h.mainElement.querySelector('[data-node-id="body"]'));
            document.querySelector('.picker-slot').append(document.querySelector('[role="dialog"]'));
            document.querySelector('#dock').style.display = 'none';
        });
        await page.waitForFunction(() => !document.querySelector('[data-picker-create]').disabled);
        await page.locator('[data-picker-create]').click();
        await page.locator('[data-picker-content]').fill('这里补充背景，帮助理解正文中的概念。');
        await saveLive(page,'01-insert.png');

        await livePage(page,'02 / 脚注面板','按编号查找，直接编辑原脚注','从右侧停靠栏打开“脚注”，在“脚注 / 设置”间切换。',
            callout(1,'按编号直接定位','输入 1、[^1] 或 [1]，按 Enter 或点“定位”。<br>远处条目也可直接选中并显示。')
            + callout(2,'查看内容与引用次数','列表标明缺失、重复、未引用状态。<br>长列表滚动时自动加载相邻批次。')
            + callout(3,'编辑原块，自动保存','支持思源富文本；显式定义请保留<br>开头的 [^编号]:。')
            + callout(4,'定位被引段落','查看正文摘要与同段引用次数；<br>点击条目回正文，或定位脚注原块。')
            + '<div class="strip">切换到“设置”后再返回，<br>保留所选脚注和编辑状态。</div>');
        await page.locator('[data-note-key="a"]').click();
        await page.locator('[data-locate-number]').fill('1');
        await page.locator('[data-action="locate-number"]').click();
        await saveLive(page,'02-sidebar.png');

        await livePage(page,'07 / 设置面板','先设引用偏好，再确认统一格式','切换偏好会保存设置；已有脚注在确认“统一格式”后转换。',
            callout(1,'引用写法控制后续插入','默认静态块引；也可选择文本标记。')
            + callout(2,'选择定义格式和块引编号','块引可用文末有序列表或显式定义，<br>编号可选 [^编号] 或 [编号]。')
            + callout(3,'确认整理当前文档','连续编号、引用使用上标默认勾选；<br>核对确认框后执行，支持一次撤销。')
            + callout(4,'检查文档中的冲突','格式不符会提示；重复编号可单独检查。')
            + '<div class="strip">选择“文本标记”后，显示跳转与实时刷新开关；定义固定为 <code>[^编号]: 内容</code>。</div>');
        await page.locator('[data-panel="settings"]').click();
        await saveLive(page,'07-settings.png');

        await render(page,'03-navigation.png',`<div class="plate"><div class="eyebrow">03 / 文本标记的预览与跳转</div><h1>先预览，再跳转，读完回正文</h1><div class="subtitle">开启“脚注跳转样式”后适用于 <code>[^编号]</code>；块引沿用思源原生交互。</div>
            <div class="row">
                <div class="card"><h2><span class="number">1</span>悬停预览</h2><div class="mock">概念需说明<span class="marker">[^1]</span><div class="preview"><div class="label">脚注内容</div>这里是补充说明。<br>长脚注可滚动，<br>也可选取文字。</div></div><p class="hint">不用先滚动到文末。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">2</span>点击定位</h2><div class="mock"><div class="note-title">文末 · 脚注</div><div style="border-left:3px solid #3266cf;padding-left:12px;background:#edf4ff"><code>[^1]:</code><br>这里是补充说明。</div></div><p class="hint">长文末尾尚未加载时，<br>也能加载并定位定义。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">3</span>返回原处</h2><div class="mock">回到原正文<span class="marker">[^1]</span><div class="return">↩ 返回正文 [^1]</div></div><p class="hint">点击右下角“返回正文”；<br>多次引用时返回最近点击处。</p></div>
            </div><div class="strip">文本标记与脚注块引都能预览。普通文本 <code>[1]</code> 不是块引，请用“插入脚注”或格式转换创建。</div><div class="footer">操作示意 · 已有原生上标保留，插件提供文本标记的临时跳转样式</div></div>`);

        await render(page,'04-normalize.png',`<div class="plate"><div class="eyebrow">04 / 统一格式</div><h1>按正文首次引用顺序，统一为 1、2、3…</h1><div class="subtitle">侧栏“设置”面板选择目标格式 → 点击“统一格式” → 核对影响范围与编号变化 → 确认。</div>
            <div class="settings"><span>引用写法：静态块引</span><span>定义格式：文末有序列表</span><span>块引编号：[^编号]</span><span>☑ 连续编号 · 引用使用上标</span></div>
            <div class="row"><div class="card"><div class="label">整理前 · 显式定义 + 文本标记</div><div class="line">先提到乙 <code>[^8]</code>，再提到甲 <code>[^3]</code>。</div><div class="line">再次提到乙 <code>[^8]</code>。</div><div class="notes"><div><code>[^3]:</code> 甲的内容</div><div><code>[^8]:</code> 乙的内容</div><div><code>[^9]:</code> 未引用的内容</div></div></div><div class="arrow">→</div>
            <div class="card"><div class="label">整理后 · 静态块引 + 文末有序列表</div><div class="line">先提到乙 <span class="marker">[^1]</span>，再提到甲 <span class="marker">[^2]</span>。</div><div class="line">再次提到乙 <span class="marker">[^1]</span>。</div><div class="notes"><div>1. 乙的内容</div><div>2. 甲的内容</div><div>3. 未引用的内容</div></div></div></div>
            <div class="strip">同一脚注的多处引用共用编号；未引用定义排在末尾。内容和富文本保留，可一次撤销恢复。</div><div class="footer">前后对照示意 · 静态块引可选择定义格式；文本标记固定使用显式定义</div></div>`);

        await render(page,'05-refresh.png',`<div class="plate"><div class="eyebrow">05 / 刷新序号</div><h1>列表调了顺序，正文编号也要刷新</h1><div class="subtitle">“刷新序号”保留当前列表顺序与原引用目标，只让正文显示对应当前编号。</div>
            <div class="row"><div class="card"><h2><span class="number">1</span>原来的对应关系</h2><div class="mock">正文引用甲 <span class="marker">[^1]</span><div class="notes"><div>1. 甲的内容</div><div>2. 乙的内容</div></div></div><p class="hint">引用指向甲的内容。</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">2</span>列表重排后</h2><div class="mock">正文仍显示 <span class="marker">[^1]</span><div class="notes"><div>1. 乙的内容</div><div>2. 甲的内容</div></div></div><p class="hint warning">序号已变化，请刷新序号</p><div class="menu">刷新序号 → 确认</div></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">3</span>显示编号更新</h2><div class="mock">正文引用甲 <span class="marker">[^2]</span><div class="notes"><div>1. 乙的内容</div><div>2. 甲的内容</div></div></div><p class="hint success">仍指向甲，列表顺序不变。</p></div></div>
            <div class="strip">如果要按正文首次引用顺序重新排列并从 1 编号，请使用勾选“连续编号”的“统一格式”。</div><div class="footer">操作示意 · 静态块引的显示编号不会随列表重排自动变化</div></div>`);
        await render(page,'06-save.png',`<div class="plate"><div class="eyebrow">06 / 表格编辑后整理</div><h1>自动结束表格编辑，保存后继续整理</h1><div class="subtitle">适用于“设置”面板中的“统一格式”和“刷新序号”。</div>
            <div class="row">
                <div class="card"><h2><span class="number">1</span>发起操作</h2><div class="mock"><div class="note-title">刚在表格中编辑了引用</div>补充说明 <code>[^1]</code><div class="menu">点击“统一格式”</div></div><p class="hint">自动结束表格编辑选区，<br>通常无须手动移出表格。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">2</span>等待保存</h2><div class="mock"><div class="label">等待思源原生保存</div>读取完整表格，<br>核对保存状态。</div><p class="hint">包含尚未加载的表格行，<br>避免只处理屏幕中的内容。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">3</span>确认后执行</h2><div class="mock"><div class="note-title">核对范围、格式与编号</div>确认 → 完成整理<div class="menu">支持一次撤销恢复</div></div><p class="hint">确认期间内容若有变化，<br>需要重新检查并确认。</p></div>
            </div><div class="save-barrier">保存失败或无法确认保存完成：停止操作并提示重试，等待保存后再试。<br>中文输入法：请先完成组合输入，再执行整理。</div><div class="footer">操作流程示意 · 不同思源版本的保存等待方式可能不同</div></div>`);
        console.log('Rendered 7 tutorial images in assets/guide/.');
    } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
