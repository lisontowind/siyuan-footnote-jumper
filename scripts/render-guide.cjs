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

(async () => {
    fs.mkdirSync(output, {recursive: true});
    const browser = await chromium.launch({headless: true, executablePath: process.env.FOOTNOTE_BROWSER_EXECUTABLE});
    try {
        const page = await browser.newPage({viewport: {width:1120,height:940},deviceScaleFactor:1});
        await render(page, '01-insert.png', `<div class="plate">
            <div class="eyebrow">01 / 快速开始</div><h1>一处插入，同时创建引用与脚注</h1>
            <div class="subtitle">在正文段落或标题中使用斜杠菜单，再到侧栏填写内容。</div>
            <div class="row">
                <div class="card"><h2><span class="number">1</span>输入命令</h2><div class="mock">这段话需说明<br><span class="command">/脚注</span><div class="menu">＋ 插入脚注</div></div><p class="hint">也可搜索 footnote 或 jz，<br>选择“插入脚注”。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">2</span>创建脚注</h2><div class="mock">这段话需说明<span class="marker">[1]</span><div class="notes"><div class="note-title">文末 · 脚注</div><code>[^1]:</code> <span style="color:#91a0b2">待填写</span></div></div><p class="hint">正文插入静态块引，<br>文末创建对应空脚注。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">3</span>填写内容</h2><div class="mock"><div class="label">侧栏 · 自动选中新脚注</div><div class="note-title">脚注原块 · 自动保存</div><code>[^1]:</code> 这里补充<br>正文之外的说明。</div><p class="hint">直接编辑原脚注，<br>修改自动保存。</p></div>
            </div><div class="strip">已有脚注时沿用当前定义格式：列表追加一项，显式定义追加一段。新文档首次插入使用 <code>[^编号]: 内容</code>。</div>
            <div class="footer">操作示意 · 示例编号为 1，实际编号自动分配</div></div>`);

        await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><div class="plate">
            <div class="eyebrow">02 / 脚注侧栏</div><h1>选中脚注，边读正文边编辑</h1><div class="subtitle">顶部脚注按钮 → “打开脚注侧栏”，或打开右侧“脚注”面板。</div>
            <div class="row"><div class="card" style="border:0;background:transparent;padding:24px 18px 0 0">
                <div class="callout"><span class="number">1</span><div><strong>切换脚注跳转样式</strong><p>与顶部菜单同步并记住设置；<br>关闭后块引仍可原生跳转。</p></div></div>
                <div class="callout"><span class="number">2</span><div><strong>选择目标格式</strong><p>引用写法和定义格式独立选择；<br>需要整理时点击“统一格式”。</p></div></div>
                <div class="callout"><span class="number">3</span><div><strong>查看脚注与引用次数</strong><p>点击列表选中脚注；还可查看<br>缺失、重复和未引用状态。</p></div></div>
                <div class="callout"><span class="number">4</span><div><strong>直接编辑原脚注</strong><p>支持富文本，修改自动保存。<br>显式定义请保留编号前缀。</p></div></div>
                <div class="callout"><span class="number">5</span><div><strong>定位被引段落</strong><p>查看段落数、正文摘要与引用次数；<br>点击段落即可回到正文位置。</p></div></div>
            </div><main class="main protyle-wysiwyg"></main><aside id="dock"></aside></div>
            <div class="footer">插件侧栏示例 · 实际外观随思源主题变化</div></div></html>`);
        await page.addStyleTag({content:fs.readFileSync(path.join(root,'dist','index.css'),'utf8')});
        // Put the presentation sizing after the plugin's CSS.
        await page.addStyleTag({content:styles});
        await page.evaluate(setupHost, modules);
        await page.evaluate(async () => {
            h.main.protyle.title.editElement.textContent = '阅读笔记';
            await h.reset(h.block('title','阅读笔记','NodeHeading','data-subtype="h2"')
                + h.block('body','理解概念时，可以补充背景 [^1]。')
                + h.block('second','再次提到同一个概念 [^1]。')
                + h.block('a','[^1]: <b>背景说明</b>，不打断正文阅读。')
                + h.block('unused','[^2]: 尚未引用的补充内容。'));
        });
        await page.waitForFunction(() => document.querySelector('[data-note-key="a"]'));
        await page.locator('[data-note-key="a"]').click();
        await page.evaluate(() => {
            const mark = (selector, n) => {const node=document.querySelector(selector); const pin=document.createElement('span');pin.className='pin';pin.textContent=n;node.prepend(pin);};
            mark('.siyuan-footnote-sidebar__display-toggle > span',1);
            mark('.siyuan-footnote-sidebar__section-title',2);
            mark('[data-note-key="a"] strong',3);
            mark('.siyuan-footnote-sidebar__editor-title > strong',4);
            mark('.siyuan-footnote-sidebar__references-heading > strong',5);
        });
        await page.evaluate(() => document.fonts.ready);
        await page.locator('.plate').screenshot({path:path.join(output,'02-sidebar.png')});
        const sidebarSize = await page.evaluate(() => ({scroll:document.querySelector('#dock').scrollHeight,client:document.querySelector('#dock').clientHeight}));
        assert.ok(sidebarSize.scroll <= sidebarSize.client + 2,`Sidebar must be fully visible: ${JSON.stringify(sidebarSize)}`);
        const clippedSections = await page.evaluate(() => {
            const dock = document.querySelector('#dock').getBoundingClientRect();
            return Array.from(document.querySelectorAll('#dock select, #dock button, #dock input, #dock .pin'))
                .filter(node => node.getClientRects().length && node.getBoundingClientRect().bottom > dock.bottom + 1)
                .map(node => node.textContent || node.getAttribute('aria-label'));
        });
        assert.deepEqual(clippedSections, [], 'Sidebar controls and all five callouts must be visible');

        await render(page,'03-navigation.png',`<div class="plate"><div class="eyebrow">03 / 文本标记的预览与跳转</div><h1>先预览，再跳转，读完回正文</h1><div class="subtitle">开启“脚注跳转样式”后适用于 <code>[^编号]</code>；块引沿用思源原生交互。</div>
            <div class="row">
                <div class="card"><h2><span class="number">1</span>悬停预览</h2><div class="mock">概念需说明<span class="marker">[^1]</span><div class="preview"><div class="label">脚注内容</div>这里是补充说明。<br>长脚注可滚动，<br>也可选取文字。</div></div><p class="hint">不用先滚动到文末。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">2</span>点击定位</h2><div class="mock"><div class="note-title">文末 · 脚注</div><div style="border-left:3px solid #3266cf;padding-left:12px;background:#edf4ff"><code>[^1]:</code><br>这里是补充说明。</div></div><p class="hint">长文末尾尚未加载时，<br>也能加载并定位定义。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">3</span>返回原处</h2><div class="mock">回到原正文<span class="marker">[^1]</span><div class="return">↩ 返回正文 [^1]</div></div><p class="hint">点击右下角“返回正文”；<br>多次引用时返回最近点击处。</p></div>
            </div><div class="strip">文本标记与脚注块引都能预览。普通文本 <code>[1]</code> 不是块引，请用“插入脚注”或格式转换创建。</div><div class="footer">操作示意 · 上标样式由插件提供</div></div>`);

        await render(page,'04-normalize.png',`<div class="plate"><div class="eyebrow">04 / 统一格式</div><h1>按正文首次引用顺序，统一为 1、2、3…</h1><div class="subtitle">侧栏选择目标格式 → 点击“统一格式” → 核对影响范围与编号变化 → 确认。</div>
            <div class="settings"><span>引用写法：静态块引</span><span>定义格式：文末有序列表</span><span>☑ 连续编号</span></div>
            <div class="row"><div class="card"><div class="label">整理前 · 显式定义 + 文本标记</div><div class="line">先提到乙 <code>[^8]</code>，再提到甲 <code>[^3]</code>。</div><div class="line">再次提到乙 <code>[^8]</code>。</div><div class="notes"><div><code>[^3]:</code> 甲的内容</div><div><code>[^8]:</code> 乙的内容</div><div><code>[^9]:</code> 未引用的内容</div></div></div><div class="arrow">→</div>
            <div class="card"><div class="label">整理后 · 静态块引 + 文末有序列表</div><div class="line">先提到乙 <span class="marker">[1]</span>，再提到甲 <span class="marker">[2]</span>。</div><div class="line">再次提到乙 <span class="marker">[1]</span>。</div><div class="notes"><div>1. 乙的内容</div><div>2. 甲的内容</div><div>3. 未引用的内容</div></div></div></div>
            <div class="strip">同一脚注的多处引用共用编号；未引用定义排在末尾。内容和富文本保留，可一次撤销恢复。</div><div class="footer">前后对照示意 · 引用与定义可独立选择，也可切回显式定义</div></div>`);

        await render(page,'05-refresh.png',`<div class="plate"><div class="eyebrow">05 / 刷新序号</div><h1>列表调了顺序，正文编号也要刷新</h1><div class="subtitle">“刷新序号”保留当前列表顺序与原引用目标，只让正文显示对应当前编号。</div>
            <div class="row"><div class="card"><h2><span class="number">1</span>原来的对应关系</h2><div class="mock">正文引用甲 <span class="marker">[1]</span><div class="notes"><div>1. 甲的内容</div><div>2. 乙的内容</div></div></div><p class="hint">引用指向甲的内容。</p></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">2</span>列表重排后</h2><div class="mock">正文仍显示 <span class="marker">[1]</span><div class="notes"><div>1. 乙的内容</div><div>2. 甲的内容</div></div></div><p class="hint warning">序号已变化，请刷新序号</p><div class="menu">刷新序号 → 确认</div></div><div class="arrow">→</div>
            <div class="card"><h2><span class="number">3</span>显示编号更新</h2><div class="mock">正文引用甲 <span class="marker">[2]</span><div class="notes"><div>1. 乙的内容</div><div>2. 甲的内容</div></div></div><p class="hint success">仍指向甲，列表顺序不变。</p></div></div>
            <div class="strip">如果要按正文首次引用顺序重新排列并从 1 编号，请使用勾选“连续编号”的“统一格式”。</div><div class="footer">操作示意 · 静态块引的显示编号不会随列表重排自动变化</div></div>`);
        await render(page,'06-save.png',`<div class="plate"><div class="eyebrow">06 / 表格编辑后整理</div><h1>自动结束表格编辑，保存后继续整理</h1><div class="subtitle">适用于“统一格式”“刷新序号”和“为脚注标记添加块引”等全文操作。</div>
            <div class="row">
                <div class="card"><h2><span class="number">1</span>发起操作</h2><div class="mock"><div class="note-title">刚在表格中编辑了引用</div>补充说明 <code>[^1]</code><div class="menu">点击“统一格式”</div></div><p class="hint">自动结束表格编辑选区，<br>通常无须手动移出表格。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">2</span>等待保存</h2><div class="mock"><div class="label">等待思源原生保存</div>读取完整表格，<br>核对保存状态。</div><p class="hint">包含尚未加载的表格行，<br>避免只处理屏幕中的内容。</p></div>
                <div class="arrow">→</div>
                <div class="card"><h2><span class="number">3</span>确认后执行</h2><div class="mock"><div class="note-title">核对范围、格式与编号</div>确认 → 完成整理<div class="menu">支持一次撤销恢复</div></div><p class="hint">确认期间内容若有变化，<br>需要重新检查并确认。</p></div>
            </div><div class="save-barrier">保存失败或无法确认保存完成：停止操作并提示重试，等待保存后再试。<br>中文输入法：请先完成组合输入，再执行整理。</div><div class="footer">操作流程示意 · 不同思源版本的保存等待方式可能不同</div></div>`);
        console.log('Rendered 6 tutorial images in assets/guide/.');
    } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
