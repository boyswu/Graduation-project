import "@fontsource-variable/manrope";
import "./home.css";

document.querySelector("#app").innerHTML = `
  <a class="skip-link" href="#main">跳到主要内容</a>
  <header class="home-nav">
    <a href="/" class="home-brand" aria-label="衣见首页"><span class="home-logo">衣</span>衣见<span>LIVE VTON</span></a>
    <nav aria-label="主导航"><a href="#experience">使用方式</a><a href="#technology">技术设计</a><a href="#materials">毕设材料</a></nav>
    <a class="home-button compact" href="/studio">进入试衣间 <span aria-hidden="true">↗</span></a>
  </header>
  <main id="main">
    <section class="hero">
      <div class="hero-copy"><p class="home-eyebrow"><span></span> INTERACTIVE VIRTUAL TRY-ON</p>
        <h1>让下一件衣服，<br>先与你<span class="serif-word">见面。</span></h1>
        <p class="hero-description">选一件心仪的衣服，打开摄像头，探索 AI 试穿。<br>从服装图片到完整画面，让试衣多一种可能。</p>
        <div class="hero-actions"><a class="home-button" href="/studio">开始试衣 <span aria-hidden="true">↗</span></a><a class="home-button secondary" href="/studio?demo=1">免 GPU 交互演示 <span aria-hidden="true">→</span></a></div>
        <p class="hero-note">浏览器即可使用 · 支持自定义衣服图片</p>
        <div class="hero-foot"><span>01 / 选择衣服</span><span>02 / 打开镜头</span><span>03 / AI 试穿</span></div>
      </div>
      <div class="hero-visual" aria-label="内置服装参考图展示，不是 AI 生成结果">
        <div class="visual-label"><span>THE DIGITAL WARDROBE</span><span>COLLECTION / 08</span></div>
        <div class="visual-orbit" aria-hidden="true"></div>
        <figure class="editorial-shirt primary-shirt"><img src="/garments/products/look-03.jpg" alt="黑色图案样衣正面参考图" width="480" height="640" fetchpriority="high"><figcaption>LOOK 03 <span>胸前图案 / 转身测试样衣</span></figcaption></figure>
        <figure class="editorial-shirt second-shirt"><img src="/garments/products/look-07.jpg" alt="浅蓝藏青拼色 Polo 参考图" width="240" height="320"><figcaption>LOOK 07 / POLO</figcaption></figure>
        <div class="visual-sticker"><span>YOUR STYLE</span><strong>全新的<br>试穿视角</strong><span>EXPLORE WITH AI ↗</span></div>
        <span class="visual-caption">服装参考图展示 · AI 生成需连接 GPU 服务</span>
      </div>
    </section>
    <div class="project-strip"><span>本科毕业设计 / 交互式虚拟试衣</span><span>浏览器采集 <b>→</b> AI 完整画面生成 <b>→</b> Canvas 显示</span><span>RESEARCH PROTOTYPE / 2026</span></div>
    <section id="experience" class="home-section">
      <div class="section-top"><div><p class="home-eyebrow">01 / EXPERIENCE</p><h2>从喜欢，到试试看。</h2></div><p>保留简单的操作，<br>让每一次试穿有清楚的下一步。</p></div>
      <div class="experience-grid">
        <article><span class="step-number">01</span><h3>你的衣柜，由你决定</h3><p>选择 8 件内置样衣，或上传 JPG、PNG、WebP 服装图片；支持最大 8 MB 的图片文件。</p><div class="mini-wardrobe">${[1, 4, 7].map(n => `<img src="/garments/products/look-0${n}.jpg" alt="内置样衣 ${n}" loading="lazy" width="110" height="140">`).join("")}</div></article>
        <article><span class="step-number">02</span><h3>半身入镜，也能开始</h3><p>允许摄像头权限后查看本地预览。生成路径直接处理完整相机画面，无需等待全身关键点齐全。</p><div class="camera-illustration" aria-hidden="true"><span class="camera-outline"></span><span>CAMERA / UPPER BODY</span></div></article>
        <article><span class="step-number">03</span><h3>知道画面来自哪里</h3><p>清楚区分本地预览、交互演示和真实 AI 输出。GPU 暂不可用时，仍可浏览衣柜、上传图片和体验操作。</p><a class="text-link" href="/studio?demo=1">先体验操作流程 <span aria-hidden="true">→</span></a></article>
      </div>
    </section>
    <section id="technology" class="home-section tech-section">
      <div class="section-top"><div><p class="home-eyebrow">02 / BEHIND THE EXPERIENCE</p><h2>看得见效果，也看得懂过程。</h2></div><p>以完整画面生成为核心，<br>以真实端到端指标评价体验。</p></div>
      <div class="architecture" aria-label="系统数据流"><div><span>01 / BROWSER</span><h3>采集与编码</h3><p>相机 · Worker · OffscreenCanvas</p></div><b aria-hidden="true">→</b><div><span>02 / TRANSPORT</span><h3>有界帧传输</h3><p>WebSocket · SSH 隧道 · 最新帧</p></div><b aria-hidden="true">→</b><div><span>03 / GENERATION</span><h3>完整画面换衣</h3><p>FLUX.2 Klein · FluxRT · CUDA</p></div><b aria-hidden="true">→</b><div><span>04 / DISPLAY</span><h3>显示与测量</h3><p>Canvas · 可选补帧 · 分阶段日志</p></div></div>
      <div class="research-note"><strong>当前能力与边界</strong><p>系统为研究原型。真实 AI 试穿需要远程 GPU，连续生成尚未达到流畅实时体验；快速运动和转身时，服装纹理与正背面一致性仍需改进。演示动画和补帧数量不代表模型生成速度。</p></div>
    </section>
    <section id="materials" class="home-section materials-section">
      <div class="section-top"><div><p class="home-eyebrow">03 / GRADUATION PROJECT</p><h2>从系统，到完整的设计说明。</h2></div><p>技术方案、实验依据、部署与答辩，<br>形成可以继续完善的毕设材料。</p></div>
      <div class="material-grid"><a href="/graduation/毕业论文初稿.docx" download><span>01 / THESIS</span><h3>毕业论文初稿 ↗</h3><p>中英文摘要、需求、架构、实现、测试与展望</p><small>WORD / 可编辑</small></a><a href="/graduation/毕设配套材料.docx" download><span>02 / PROJECT HANDBOOK</span><h3>毕设配套材料 ↗</h3><p>开题报告、任务书草案、操作手册与答辩讲稿</p><small>WORD / 可编辑</small></a><a href="/graduation/README.md"><span>03 / DELIVERY GUIDE</span><h3>材料与证据索引 ↗</h3><p>提交检查项、实测数据来源、尚需完成的实验</p><small>MARKDOWN / 可追溯</small></a></div>
    </section>
    <div class="home-section" style="padding-block:0 35px;display:flex;gap:28px;flex-wrap:wrap"><a class="text-link" style="margin-top:0" href="/graduation/答辩演示.html">打开答辩演示 →</a><a class="text-link" style="margin-top:0" href="/graduation/毕设材料包.zip" download>下载完整毕设材料包 ↓</a></div>
    <section class="home-faq home-section"><div><p class="home-eyebrow">BEFORE YOU START</p><h2>开始前，了解这几件事。</h2></div><div><details><summary>没有远程 GPU，可以使用吗？</summary><p>可以浏览样衣、上传参考图片、查看本地摄像头和合成姿态演示；这些功能不产生真实 AI 换衣结果。待资源恢复后，在工作台重新检查服务即可。</p></details><details><summary>摄像头画面会保存在服务器吗？</summary><p>本项目的相机帧在浏览器和推理服务内存中处理，耗时诊断不记录图片。连接真实 AI 后，人物帧会通过隧道发送到配置的远程 GPU；上传服装仅保留在当前页面。导出画面由你主动操作。</p></details><details><summary>衣服背面与细节能完全还原吗？</summary><p>当前以单张服装参考图引导生成，无法保证未提供的背面结构与小字纹理正确。正背面一致性和连续动作仍是后续研究重点。</p></details></div></section>
    <section class="home-cta"><div><p class="home-eyebrow">SEE IT ON YOU</p><h2>下一件，会是什么样？</h2></div><a class="home-button" href="/studio">进入试衣间 <span aria-hidden="true">↗</span></a></section>
  </main>
  <footer class="home-footer"><a href="/" class="home-brand">衣见 <span>LIVE VTON</span></a><span>基于深度学习的交互式虚拟试衣系统设计与实现</span><a href="#main">回到顶部 ↑</a></footer>
`;
