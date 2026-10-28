import "@fontsource-variable/manrope";
import "./styles.css";
import "./studio.css";
import {
  Activity,
  Camera,
  CameraOff,
  Check,
  ChevronRight,
  CircleHelp,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  ScanLine,
  Server,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Search,
  Upload,
  Wifi,
  WifiOff,
  X,
  createIcons,
} from "lucide";
import { GARMENTS } from "./garments.js";
import { TryOnEngine } from "./tryon-engine.js";
import { CatVTONClient } from "./catvton-client.js";
import { FullFrameClient } from "./full-frame-client.js";

const ICONS = {
  Activity,
  Camera,
  CameraOff,
  Check,
  ChevronRight,
  CircleHelp,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  ScanLine,
  Server,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Search,
  Upload,
  Wifi,
  WifiOff,
  X,
};

document.querySelector("#app").innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Live VTON home">
        <span class="brand-mark"><span></span></span>
        <span class="brand-copy">
          <strong>衣见 / LIVE VTON</strong>
          <small>INTERACTIVE TRY-ON STUDIO</small>
        </span>
      </a>
      <div class="topbar-center">
        <span class="system-state" id="systemState"><i></i> AI ENGINE CHECKING</span>
        <span class="project-state">本科毕业设计 · 研究原型</span>
      </div>
      <div class="topbar-actions">
        <a class="studio-home-link" href="/">首页</a>
        <button class="button button-quiet" id="openDiagnostics" type="button">
          <i data-lucide="activity"></i><span>链路诊断</span>
        </button>
        <button class="button button-primary" id="topCameraButton" type="button">
          <i data-lucide="camera"></i><span>启动摄像头</span>
        </button>
      </div>
    </header>

    <div class="studio-notice" id="serviceNotice" role="status" aria-live="polite"><div><strong id="serviceNoticeTitle">正在检查 AI 服务</strong><span id="serviceNoticeDetail">摄像头画面仅在你主动开始生成后发送至远程 GPU。</span></div><button id="retryService" class="button button-quiet" type="button">重新检查服务</button></div>
    <div class="studio-steps" aria-label="操作流程"><span id="garmentStep"><b>01</b> 选择衣服</span><span id="cameraStep"><b>02</b> 打开摄像头</span><span id="generationStep"><b>03</b> 开始试穿</span><a href="/graduation/毕设配套材料.docx" download>操作手册 ↗</a></div>
    <main class="workspace">
      <section class="stage-column" aria-label="实时试衣预览">
        <div class="stage-heading">
          <div>
            <span class="eyebrow">YOUR PERSONAL FITTING ROOM<span id="sourceEyebrow" hidden>SYNTHETIC PREVIEW</span></span>
            <h1>你的 AI 试衣间</h1>
            <p class="stage-subtitle">选一件喜欢的，让穿搭有新的可能。</p>
          </div>
          <div class="stage-heading-tools"><button class="button button-quiet" id="jumpWardrobe" type="button"><i data-lucide="shirt"></i>选择衣服</button><button class="button button-quiet" id="toggleFocusButton" type="button" aria-pressed="false"><i data-lucide="maximize-2"></i><span>专注预览</span></button></div>
          <div class="live-status" id="liveStatus">
            <span class="live-dot"></span>
            <span id="statusText">演示姿态运行中</span>
          </div>
        </div>

        <div class="mirror-frame" id="mirrorFrame">
          <canvas id="tryonCanvas" aria-label="虚拟试衣渲染画面"></canvas>
          <canvas id="generatedCanvas" aria-label="模型完整生成画面" hidden></canvas>
          <canvas id="poseCanvas" class="pose-canvas" aria-hidden="true"></canvas>
          <div class="camera-empty-state" id="cameraEmptyState"><div class="empty-orbit"><i data-lucide="shirt"></i><span class="empty-spark">✧</span></div><span class="empty-eyebrow">A NEW LOOK STARTS HERE</span><h2>留一面镜子，给新的自己。</h2><p>开启摄像头，查看你的本地画面。<br>选择参考衣服后，再开始 AI 试穿。</p><span class="empty-privacy"><i data-lucide="camera"></i> 相机由你开启，生成由你决定</span></div>
          <div class="frame-grid" aria-hidden="true"></div>
          <span class="frame-corner corner-tl" aria-hidden="true"></span>
          <span class="frame-corner corner-tr" aria-hidden="true"></span>
          <span class="frame-corner corner-bl" aria-hidden="true"></span>
          <span class="frame-corner corner-br" aria-hidden="true"></span>

          <div class="hud hud-left">
            <span>TRACKING</span>
            <strong><b id="trackedPoints">33</b> / 33</strong>
          </div>
          <div class="hud hud-right">
            <span>SOURCE</span>
            <strong id="sourceValue">DEMO</strong>
          </div>
          <div class="stage-live-tag" id="stagePipelineTag"><i></i> KEYFRAME WARP / EXPERIMENT</div>

          <div class="camera-prompt" id="cameraPrompt">
            <span class="prompt-mark"><i data-lucide="scan-line"></i></span>
            <div class="prompt-copy">
              <strong>摄像头实时流尚未启动</strong>
              <span>支持半身入镜，无需露出全身</span>
            </div>
            <button class="button button-primary" id="startCameraButton" type="button">
              <i data-lucide="camera"></i><span>开启试衣镜</span>
            </button>
          </div>

          <div class="active-garment-label">
            <span class="garment-number" id="activeGarmentIndex">01</span>
            <span class="garment-copy">
              <strong id="activeGarmentName">Neural Look 01</strong>
              <small id="activeGarmentType">真实衣物 / AI 衣层 + LIVE WARP</small>
            </span>
          </div>

          <div class="stage-controls">
            <button class="icon-button" id="togglePoseButton" type="button" aria-label="显示或隐藏姿态骨骼" title="显示或隐藏姿态骨骼">
              <i data-lucide="scan-line"></i>
            </button>
            <button class="icon-button" id="togglePauseButton" type="button" aria-label="暂停预览" title="暂停预览" aria-pressed="false">
              <i data-lucide="pause"></i>
            </button>
            <button class="icon-button" id="fullscreenButton" type="button" aria-label="全屏预览" title="全屏预览">
              <i data-lucide="maximize-2"></i>
            </button>
          </div>
          <div class="pause-overlay" id="pauseOverlay" hidden><span><i data-lucide="pause"></i> 预览已暂停</span><small>摄像头仍开启；可恢复预览或关闭摄像头</small></div>
        </div>

        <details class="advanced-pipeline"><summary>实验选项 · 切换生成路径</summary><label class="pipeline-choice">试衣方式
          <select id="tryonPipeline" aria-label="试衣方式">
            <option value="full-frame">完整画面生成 · 5090 实验</option>
            <option value="legacy">旧版衣层贴片 · 仅供对照</option>
          </select>
        </label></details>
        <div class="full-frame-controls" id="fullFrameControls">
          <div class="generation-heading"><span class="eyebrow">MAKE IT YOURS</span><h2>试穿设置</h2><span class="generation-badge" id="generationBadge">待开始</span></div>
          <div class="selected-reference"><img id="selectedReferenceImage" alt="当前选择的服装参考" /><div><small>当前参考衣服</small><strong id="selectedReferenceName"></strong><span id="selectedReferenceMeta">内置样衣 · 可随时更换</span></div><button id="removeUploadedGarment" class="icon-button" type="button" aria-label="移除上传衣服" title="移除上传衣服" hidden><i data-lucide="x"></i></button></div>
          <div class="generation-options">
            <label class="pipeline-choice">显示偏好
              <select id="fullFrameDisplay" aria-label="预览方式">
                <option value="smooth">平滑显示 · AI 补帧</option>
                <option value="low-latency">低延迟 · 直接显示</option>
              </select>
            </label>
            <label class="pipeline-choice">画面档位
              <select id="fullFrameProfile" aria-label="生成档位">
                <option value="fast">流畅优先</option>
                <option value="balanced">均衡</option>
                <option value="detail">细节优先</option>
              </select>
            </label>
          </div>
          <p class="generation-preference-note" id="generationPreferenceNote"></p>
          <button class="button button-primary" id="fullFrameButton" type="button">开始连续生成</button>
          <p class="generation-privacy">仅在开始生成后，将画面发送至已配置的 GPU。</p>
          <details class="generation-explanation"><summary>生成状态与耗时说明</summary><strong id="fullFrameTitle">完整画面生成</strong>
            <p id="fullFrameDetail">当前相机帧交给模型重新换衣；支持半身，无需关键点。实验速度尚未达到即时跟随。</p>
            <small id="generationProfileNote">流畅档降低生成分辨率，保留完整人物和衣服；可随时切回原有细节档。</small>
            <p id="latencyBreakdown">模型 / 排队 / 采集与传输 / 显示：等待首帧测量</p>
          </details>
        </div>
        <div class="studio-tools"><span id="previewModeLabel">交互演示 / 非 AI 输出</span><button class="button button-quiet" id="saveGeneratedFrame" type="button" disabled>保存 AI 画面</button><button class="button button-quiet" id="openHelp" type="button">使用帮助</button></div>
        <details class="runtime-diagnostics" id="runtimeDiagnostics">
          <summary id="runtimeLogSummary">运行日志 · 自动记录，等待生成</summary>
          <p id="runtimeFrameAge">当前原帧帧龄：--</p>
          <div class="runtime-log-actions">
            <button class="button button-quiet" id="exportRuntimeLog" type="button">导出运行日志</button>
            <button class="button button-quiet" id="clearRuntimeLog" type="button">清空本地记录</button>
          </div>
          <p class="garment-upload-note" id="runtimeLogStorage">记录耗时，不记录摄像头或衣服图片；包含最近120个原帧的统计。</p>
          <div class="runtime-table-scroll"><table class="runtime-log-table">
            <thead><tr><th>时间</th><th>帧号</th><th>采样→绘制</th><th>模型</th><th>回传/解码/补帧</th></tr></thead>
            <tbody id="runtimeLogRows"></tbody>
          </table></div>
        </details>
        <div class="neural-runbar" id="neuralRunbar">
          <span class="neural-runbar-icon"><i data-lucide="sparkles"></i></span>
          <div class="neural-runbar-copy">
            <strong id="neuralRunTitle">准备生成真实衣层</strong>
            <small id="neuralRunDetail">开启摄像头并站入画面，检测到人体后自动生成</small>
            <div class="quality-switch" id="qualitySwitch" role="group" aria-label="CatVTON 生成质量">
              <button class="quality-option" data-steps="8" type="button" aria-pressed="false">8 步 · 低步实验</button>
              <button class="quality-option" data-steps="20" type="button" aria-pressed="false">20 步 · 均衡</button>
              <button class="quality-option is-active" data-steps="50" type="button" aria-pressed="true">50 步 · 质量基线</button>
            </div>
          </div>
          <div class="neural-actions">
            <button class="button button-primary" id="aiTryOnButton" type="button">
              <i data-lucide="sparkles"></i><span id="aiTryOnButtonLabel">AI 换衣</span>
            </button>
            <button class="button button-quiet" id="openRawResult" type="button" disabled>完整 AI 原图</button>
          </div>
        </div>

        <div class="telemetry-grid" aria-label="实时性能指标">
          <div class="metric metric-primary">
            <span class="metric-label" id="fpsLabel">摄像头预览帧率</span>
            <div><strong id="fpsValue">--</strong><small>FPS</small></div>
            <span class="metric-foot" id="fpsFoot">等待采样</span>
          </div>
          <div class="metric">
            <span class="metric-label">AI 生成耗时</span>
            <div><strong id="aiLatencyValue">--</strong><small id="aiLatencyUnit">s</small></div>
            <span class="metric-foot" id="aiLatencyFoot">CATVTON 50 STEPS</span>
          </div>
          <div class="metric">
            <span class="metric-label" id="requestTimeLabel">请求总耗时</span>
            <div><strong id="networkRttValue">--</strong><small>ms</small></div>
            <span class="metric-foot" id="networkRttFoot">本机 HTTP / 图片编码</span>
          </div>
          <div class="metric">
            <span class="metric-label">帧间隔抖动</span>
            <div><strong id="jitterValue">--</strong><small>ms</small></div>
            <span class="metric-foot">WARP ROLLING σ</span>
          </div>
          <div class="metric">
            <span class="metric-label">服装锚点抖动</span>
            <div><strong id="driftValue">--</strong><small>px</small></div>
            <span class="metric-foot" id="driftFoot">ONE EURO · 等待采样</span>
          </div>
        </div>
      </section>

      <aside class="control-panel">
        <section class="panel-section wardrobe-section" id="wardrobeSection" aria-labelledby="wardrobeHeading">
          <div class="section-heading">
            <div>
              <span class="eyebrow">WARDROBE / <span id="wardrobeCount">${String(GARMENTS.length).padStart(2, "0")}</span></span>
              <h2 id="wardrobeHeading" tabindex="-1">挑一件，试试看</h2>
            </div>
            <button class="button button-quiet" id="backToPreview" type="button">返回预览 ↑</button>
          </div>
          <label class="wardrobe-search"><i data-lucide="search"></i><input id="garmentSearch" type="search" placeholder="搜索衣服名称或编号" aria-label="搜索衣服" autocomplete="off" /></label>
          <div class="filter-row" role="group" aria-label="服装分类">
            <button class="filter-chip is-active" data-filter="all" type="button" aria-pressed="true">全部样衣</button>
            <button class="filter-chip" data-filter="uploaded" type="button" aria-pressed="false">我的上传</button>
          </div>
          <div class="garment-list" id="garmentList"></div>
          <p class="wardrobe-empty" id="wardrobeEmpty" hidden>没有找到匹配的衣服，试试其他名称。</p>
          <div class="garment-drop-zone" id="garmentDropZone"><button class="button button-quiet" id="uploadGarmentButton" type="button"><i data-lucide="upload"></i><span>上传衣服样本</span><small>点击选择，或将图片拖到这里</small></button><input id="garmentUpload" type="file" accept="image/jpeg,image/png,image/webp" hidden /></div>
          <p class="garment-upload-note" id="garmentUploadStatus">支持 JPG / PNG / WebP，最大 8 MB；优先使用完整正面衣物图，上传样衣仅在本次页面保留。</p>
        </section>

        <section class="panel-section legacy-fit-section">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">FIT CONTROL</span>
              <h2>版型与稳定</h2>
            </div>
            <i class="heading-icon" data-lucide="sliders-horizontal"></i>
          </div>
          <label class="range-control">
            <span><strong>服装松量</strong><output id="widthOutput">100%</output></span>
            <input id="widthRange" type="range" min="86" max="114" value="100" step="1" />
          </label>
          <label class="range-control">
            <span><strong>垂坠强度</strong><output id="drapeOutput">1.00×</output></span>
            <input id="drapeRange" type="range" min="40" max="180" value="100" step="1" />
          </label>
          <label class="range-control">
            <span><strong>时序平滑</strong><output id="smoothOutput">0.58</output></span>
            <input id="smoothRange" type="range" min="0" max="100" value="58" step="1" />
          </label>
        </section>

        <section class="panel-section legacy-layers-section">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">RENDER LAYERS</span>
              <h2>画面图层</h2>
            </div>
            <i class="heading-icon" data-lucide="shirt"></i>
          </div>
          <label class="switch-row">
            <span><strong>姿态骨架</strong><small>显示 33 点实时追踪</small></span>
            <input id="poseSwitch" type="checkbox" checked />
            <i></i>
          </label>
          <label class="switch-row">
            <span><strong>人体分割</strong><small>背景压暗与时序降闪</small></span>
            <input id="maskSwitch" type="checkbox" checked />
            <i></i>
          </label>
          <label class="range-control dim-control" id="dimControl">
            <span><strong>背景压暗</strong><output id="dimOutput">44%</output></span>
            <input id="dimRange" type="range" min="0" max="90" value="44" step="1" />
          </label>
        </section>

        <section class="panel-section network-section">
          <div class="section-heading compact">
            <div>
              <span class="eyebrow">INFERENCE HOST</span>
              <h2>推理链路</h2>
            </div>
            <span class="network-state" id="networkState"><i></i> LOCAL</span>
          </div>
          <div class="host-row">
            <span class="host-icon"><i data-lucide="server"></i></span>
            <span>
              <strong id="localBackendLabel">检查 CatVTON 服务</strong>
              <small id="localBackendDetail">AI 衣层生成 + MediaPipe + Warp</small>
            </span>
            <span class="host-latency" id="localLatency">-- ms</span>
          </div>
          <label class="backend-field"><span>生成设备</span>
            <select id="inferenceBackend" aria-label="生成设备">
              <option value="http://127.0.0.1:8020">本机 · RTX 4060</option>
              <option value="http://127.0.0.1:8021">远程 · RTX 5090 隧道</option>
            </select>
          </label>
          <label class="backend-field"><span>图片传输</span>
            <select id="transferFormat" aria-label="图片传输">
              <option value="compact">快速 · WebP 95</option>
              <option value="lossless">无损 · WebP</option>
            </select>
          </label>
          <button class="network-action" id="networkAction" type="button">
            <span><i data-lucide="wifi"></i>推理服务与远程网络诊断</span>
            <i data-lucide="chevron-right"></i>
          </button>
        </section>

        <footer class="panel-footer">
          <span>FRAME <b id="frameCount">0</b></span>
          <span>MODEL <b id="activeModelLabel">FLUX.2 KLEIN</b></span>
          <span>BUILD <b>0.2.0</b></span>
        </footer>
      </aside>
    </main>
  </div>

  <dialog class="diagnostics-dialog" id="diagnosticsDialog">
    <form method="dialog" class="dialog-shell">
      <div class="dialog-heading">
        <div>
          <span class="eyebrow">NETWORK / RTT PROBE</span>
          <h2>远程 GPU 链路诊断</h2>
        </div>
        <button class="icon-button dialog-close" value="close" aria-label="关闭"><i data-lucide="x"></i></button>
      </div>
      <p class="dialog-intro">此处只测诊断服务的网络往返，不包含换衣模型推理。完整画面生成的耗时请查看主页面“采样到绘制”。</p>
      <label class="text-field">
        <span>WebSocket 地址</span>
        <input id="remoteUrl" type="url" value="ws://127.0.0.1:8010/ws" spellcheck="false" />
      </label>
      <div class="dialog-actions">
        <button class="button button-quiet" id="connectRemote" type="button"><i data-lucide="wifi"></i><span>连接</span></button>
        <button class="button button-primary" id="runRemoteTest" type="button" disabled><i data-lucide="activity"></i><span>运行 24 次探测</span></button>
      </div>
      <div class="remote-summary" id="remoteSummary">
        <div><span>状态</span><strong id="remoteState">未连接</strong></div>
        <div><span>RTT 中位</span><strong id="rttMedian">--</strong></div>
        <div><span>RTT P95</span><strong id="rttP95">--</strong></div>
        <div><span>网络抖动</span><strong id="rttJitter">--</strong></div>
      </div>
      <div class="protocol-note">
        <i data-lucide="circle-help"></i>
        <span>协议 v1：<code>ping/pong</code> 往返采样；远程推理服务入口与启动命令见 <code>server/README.md</code>。</span>
      </div>
    </form>
  </dialog>

  <dialog class="diagnostics-dialog" id="helpDialog" aria-labelledby="helpTitle"><form method="dialog" class="dialog-shell"><div class="dialog-heading"><h2 id="helpTitle">开始一次试穿</h2><button class="icon-button" aria-label="关闭使用帮助" value="close">×</button></div><ol class="help-steps"><li>选择内置样衣或上传不超过 8 MB 的服装图片。</li><li>打开摄像头，允许浏览器访问。保持上半身清晰、光线均匀。</li><li>服务就绪后点击“开始连续生成”。无 GPU 时可使用本地相机和交互演示。</li><li>低延迟档直接显示原始生成帧；平滑档包含补帧，可能增加等待。</li><li>离开前关闭摄像头。保存画面与导出数字日志均由你主动操作。</li></ol><p class="dialog-intro">快速动作、衣服小字和转身背面仍可能出现错误；生成帧率与显示帧率分别统计，演示动画不代表推理速度。</p></form></dialog>

  <dialog class="diagnostics-dialog raw-result-dialog" id="rawResultDialog" aria-labelledby="rawResultTitle">
    <form method="dialog" class="dialog-shell">
      <div class="dialog-heading">
        <h2 id="rawResultTitle">完整 AI 换衣结果</h2>
        <button class="icon-button dialog-close" value="close" aria-label="关闭完整结果"><i data-lucide="x"></i></button>
      </div>
      <p class="dialog-intro" id="rawResultMeta"></p>
      <div class="raw-result-grid">
        <figure><figcaption>目标衣服</figcaption><img id="rawGarmentImage" alt="目标服装参考图" /></figure>
        <figure><figcaption>生成时的人物帧</figcaption><img id="rawPersonImage" alt="生成时拍摄的人物原图" /></figure>
        <figure><figcaption>模型完整输出</figcaption><img id="rawGeneratedImage" alt="未经衣层裁切的完整 AI 换衣图" /></figure>
      </div>
      <p class="dialog-intro">这是生成时刻的静态照片。主预览中的衣层跟随是独立实验，衣服裁碎、贴纸感或动作延迟需要与这里的完整输出分别判断。</p>
    </form>
  </dialog>

  <div class="toast" id="toast" role="status" aria-live="polite">
    <span class="toast-icon"><i data-lucide="check"></i></span>
    <span id="toastText"></span>
  </div>
`;

// Keep controls beside the mirror without changing the existing session bindings.
document.querySelector(".control-panel").prepend(document.querySelector("#fullFrameControls"));
const connectionSettings = document.createElement("details");
connectionSettings.className = "connection-settings";
connectionSettings.innerHTML = "<summary>高级选项与链路诊断</summary>";
connectionSettings.append(document.querySelector(".advanced-pipeline"), document.querySelector(".network-section"));
document.querySelector(".panel-footer").before(connectionSettings);
document.querySelector(".stage-column").append(document.querySelector(".runtime-diagnostics"));

createIcons({ icons: ICONS });

const elements = {
  canvas: document.querySelector("#tryonCanvas"),
  poseCanvas: document.querySelector("#poseCanvas"),
  statusText: document.querySelector("#statusText"),
  systemState: document.querySelector("#systemState"),
  sourceEyebrow: document.querySelector("#sourceEyebrow"),
  sourceValue: document.querySelector("#sourceValue"),
  trackedPoints: document.querySelector("#trackedPoints"),
  cameraPrompt: document.querySelector("#cameraPrompt"),
  garmentList: document.querySelector("#garmentList"),
  activeGarmentIndex: document.querySelector("#activeGarmentIndex"),
  activeGarmentName: document.querySelector("#activeGarmentName"),
  activeGarmentType: document.querySelector("#activeGarmentType"),
  fpsValue: document.querySelector("#fpsValue"),
  fpsFoot: document.querySelector("#fpsFoot"),
  aiLatencyValue: document.querySelector("#aiLatencyValue"),
  aiLatencyUnit: document.querySelector("#aiLatencyUnit"),
  aiLatencyFoot: document.querySelector("#aiLatencyFoot"),
  networkRttValue: document.querySelector("#networkRttValue"),
  networkRttFoot: document.querySelector("#networkRttFoot"),
  jitterValue: document.querySelector("#jitterValue"),
  driftValue: document.querySelector("#driftValue"),
  driftFoot: document.querySelector("#driftFoot"),
  stagePipelineTag: document.querySelector("#stagePipelineTag"),
  neuralRunbar: document.querySelector("#neuralRunbar"),
  neuralRunTitle: document.querySelector("#neuralRunTitle"),
  neuralRunDetail: document.querySelector("#neuralRunDetail"),
  aiTryOnButton: document.querySelector("#aiTryOnButton"),
  aiTryOnButtonLabel: document.querySelector("#aiTryOnButtonLabel"),
  qualitySwitch: document.querySelector("#qualitySwitch"),
  localLatency: document.querySelector("#localLatency"),
  localBackendLabel: document.querySelector("#localBackendLabel"),
  localBackendDetail: document.querySelector("#localBackendDetail"),
  frameCount: document.querySelector("#frameCount"),
  networkState: document.querySelector("#networkState"),
  diagnosticsDialog: document.querySelector("#diagnosticsDialog"),
  remoteSummary: document.querySelector("#remoteSummary"),
  remoteState: document.querySelector("#remoteState"),
  rttMedian: document.querySelector("#rttMedian"),
  rttP95: document.querySelector("#rttP95"),
  rttJitter: document.querySelector("#rttJitter"),
  connectRemote: document.querySelector("#connectRemote"),
  runRemoteTest: document.querySelector("#runRemoteTest"),
  remoteUrl: document.querySelector("#remoteUrl"),
  toast: document.querySelector("#toast"),
  toastText: document.querySelector("#toastText"),
};

const state = {
  demoMode: new URLSearchParams(location.search).get("demo") === "1",
  fullFrameService: null,
  pipeline: new URLSearchParams(location.search).get("demo") !== "1" && localStorage.getItem("vton-pipeline") === "legacy" ? "legacy" : "full-frame",
  selectedGarment: GARMENTS.find((garment) => garment.id === "neural-look-03") || GARMENTS[0],
  filter: "all",
  search: "",
  showPose: true,
  useMask: true,
  paused: false,
  aiBusy: false,
  aiStatus: "idle",
  aiStatusMessage: "等待摄像头",
  aiStatusDetail: "开启摄像头并站入画面，检测到人体后自动生成",
  aiService: null,
  aiLastResult: null,
  aiRawResult: null,
  aiGenerationCount: 0,
  aiController: null,
  aiGenerationStartedAt: 0,
  aiGenerationGarmentId: null,
  generationSteps: 50,
  personVisibleSince: 0,
  lastAutoGarmentId: null,
  remoteConnected: false,
  remoteSocket: null,
  remoteSamples: [],
};

let toastTimer = null;
let stats = null;
let aiProgressTimer = null;
let fullFrame = null;
let lastFullFrame = null;
const catvton = new CatVTONClient();

function showToast(message, icon = "check") {
  elements.toastText.textContent = message;
  elements.toast.querySelector(".toast-icon").innerHTML = `<i data-lucide="${icon}"></i>`;
  createIcons({ icons: ICONS });
  elements.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function setAiState(status, title, detail = "") {
  if (state.pipeline === "full-frame") return;
  state.aiStatus = status;
  state.aiStatusMessage = title;
  state.aiStatusDetail = detail;
  elements.neuralRunbar.dataset.status = status;
  elements.neuralRunTitle.textContent = title;
  elements.neuralRunDetail.textContent = detail;
  elements.aiTryOnButton.disabled = state.aiBusy;
  elements.aiTryOnButton.classList.toggle("is-loading", state.aiBusy);
  for (const option of elements.qualitySwitch.querySelectorAll(".quality-option")) {
    option.disabled = state.aiBusy;
  }
  elements.aiTryOnButtonLabel.textContent = state.aiBusy
    ? `生成中 ${formatSeconds(performance.now() - state.aiGenerationStartedAt)}`
    : status === "ready"
      ? "重新生成"
      : "AI 换衣";

  const tags = {
    idle: "KEYFRAME WARP / EXPERIMENT",
    checking: "CHECKING AI ENGINE",
    detecting: "HUMAN FOUND / PREPARING AI",
    generating: "GENERATING REAL GARMENT",
    ready: "KEYFRAME WARP / EXPERIMENT",
    error: "AI ENGINE NEEDS ATTENTION",
  };
  elements.stagePipelineTag.lastChild.textContent = ` ${tags[status] || tags.idle}`;
  elements.stagePipelineTag.dataset.status = status;
}

function startAiProgress() {
  clearInterval(aiProgressTimer);
  aiProgressTimer = setInterval(() => {
    if (!state.aiBusy) return;
    const elapsed = performance.now() - state.aiGenerationStartedAt;
    elements.aiTryOnButtonLabel.textContent = `生成中 ${formatSeconds(elapsed)}`;
    elements.neuralRunDetail.textContent =
      `CatVTON 正在生成真实衣层 · 已等待 ${formatSeconds(elapsed)} · 本地 Warp 继续运行`;
  }, 250);
}

function clearRawResult() {
  state.aiRawResult = null;
  document.querySelector("#openRawResult").disabled = true;
  for (const id of ["rawGarmentImage", "rawPersonImage", "rawGeneratedImage"]) document.getElementById(id).removeAttribute("src");
  document.querySelector("#rawResultDialog").close();
}

function publishRawResult(capture, result, garment, steps) {
  if (!result.image?.startsWith("data:image/")) return;
  state.aiRawResult = { garmentId: garment.id, steps, image: result.image, personImage: capture.personImage };
  document.querySelector("#rawGarmentImage").src = garment.asset;
  document.querySelector("#rawPersonImage").src = capture.personImage;
  document.querySelector("#rawGeneratedImage").src = result.image;
  document.querySelector("#rawResultTitle").textContent = `${garment.localizedName} · 完整 AI 换衣结果`;
  const size = result.output_size ?? [512, 768];
  document.querySelector("#rawResultMeta").textContent = `${steps} 步 · ${size.join("×")} · 模型推理 ${(result.timings_ms.total / 1000).toFixed(2)} 秒。此图直接来自模型，保留完整画面。`;
  document.querySelector("#openRawResult").disabled = false;
}

function hasRequiredPose() {
  return engine.source === "camera" && engine.hasUpperBody();
}

function updatePersonDetection(next) {
  if (state.pipeline === "full-frame") return;
  if (next.source !== "camera" || !hasRequiredPose()) {
    state.personVisibleSince = 0;
    if (next.source === "camera" && !state.aiBusy && !next.neuralLayerReady) {
      setAiState("detecting", "等待双肩进入画面", "支持半身：双肩可见即可，肘部和腰部可以在镜头外");
    }
    return;
  }

  if (!state.personVisibleSince) state.personVisibleSince = performance.now();
  if (
    !state.aiBusy &&
    !next.neuralLayerReady &&
    state.personVisibleSince &&
    performance.now() - state.personVisibleSince >= 1000
  ) {
    void maybeGenerateNeuralLayer({ automatic: true });
  }
}

async function refreshAiServiceStatus({ quiet = false } = {}) {
  if (state.pipeline === "full-frame") return refreshFullFrameStatus();
  const requestedUrl = catvton.apiUrl;
  if (!quiet) setAiState("checking", "正在连接 CatVTON", "检查所选推理服务与 CUDA 模型");
  try {
    const service = await catvton.status({ signal: AbortSignal.timeout(6000) });
    if (catvton.apiUrl !== requestedUrl || state.pipeline !== "legacy") return null;
    state.aiService = service;
    elements.systemState.classList.toggle("is-error", !service.ready);
    elements.systemState.innerHTML = service.ready
      ? "<i></i> CATVTON / CUDA READY"
      : service.loading
        ? "<i></i> CATVTON / MODEL LOADING"
        : "<i></i> CATVTON / OFFLINE";
    if (service.ready) {
      if (!quiet && !engine.neuralLayerReady) {
        setAiState(
          engine.source === "camera" ? "detecting" : "idle",
          engine.source === "camera" ? "检测到人体后自动生成" : "真实衣层引擎已就绪",
          engine.source === "camera"
            ? `保持正面站立约 1 秒，随后执行 ${state.generationSteps} 步 CatVTON`
            : "点击“AI 换衣”会启动摄像头并生成真实衣物",
        );
      }
      return service;
    }
    throw new Error(service.error || (service.loading ? "CatVTON 模型仍在加载" : "CatVTON 服务未就绪"));
  } catch (error) {
    if (catvton.apiUrl !== requestedUrl || state.pipeline !== "legacy") return null;
    state.aiService = null;
    elements.systemState.classList.add("is-error");
    elements.systemState.innerHTML = "<i></i> CATVTON / OFFLINE";
    if (!quiet) {
      setAiState("error", "CatVTON 推理服务不可用", `${catvton.apiUrl} · ${error.message}`);
    }
    return null;
  }
}

async function waitForRequiredPose(timeoutMs = 8000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (hasRequiredPose()) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function generateNeuralGarmentLayer({ automatic = false, force = false } = {}) {
  if (state.pipeline === "full-frame") return false;
  if (state.aiBusy) return false;
  if (engine.neuralLayerReady && !force) return true;
  if (engine.source !== "camera") {
    if (!automatic) showToast("请先开启摄像头并站入画面", "camera");
    return false;
  }
  if (!hasRequiredPose()) {
    if (!automatic) showToast("请让双肩进入画面，半身也可试穿", "scan-line");
    return false;
  }

  const garment = state.selectedGarment;
  const garmentId = garment.id;
  const steps = state.generationSteps;
  state.aiGenerationGarmentId = garmentId;
  state.lastAutoGarmentId = garmentId;
  state.aiBusy = true;
  const controller = new AbortController();
  state.aiController = controller;
  state.aiGenerationStartedAt = performance.now();
  state.personVisibleSince = 0;
  setAiState(
    "generating",
    "正在生成真实衣层",
    `CatVTON ${steps} 步；此期间姿态和本地 Warp 保持运行`,
  );
  startAiProgress();

  try {
    const service = state.aiService?.ready
      ? state.aiService
      : await refreshAiServiceStatus({ quiet: true });
    if (!service?.ready) {
      throw new Error("CatVTON 推理服务未就绪");
    }

    const capture = engine.captureTryOnInput();
    const result = await catvton.tryOn({
      personImage: capture.personImage,
      garmentAsset: garment.asset,
      maskImage: capture.maskImage,
      steps,
      guidanceScale: 2.5,
      seed: 42,
      responseFormat: document.querySelector("#transferFormat").value,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    });

    if (controller.signal.aborted || state.aiController !== controller || state.selectedGarment.id !== garmentId || engine.source !== "camera") {
      return false;
    }
    publishRawResult(capture, result, garment, steps);
    await engine.setNeuralGarmentLayer(result.image || result.garment_layer, {
      capturedPose: capture.pose,
      maskDataUrl: result.garment_layer,
      capturedPersonDataUrl: capture.personImage,
      signal: controller.signal,
    });
    if (controller.signal.aborted || state.aiController !== controller) return false;
    state.aiGenerationCount += 1;
    state.aiLastResult = {
      ...result,
      steps,
      requestKB: result.requestBytes / 1024,
      totalRoundTripMs: performance.now() - state.aiGenerationStartedAt,
      generatedForGarmentId: garmentId,
    };
    const totalSeconds = ((performance.now() - state.aiGenerationStartedAt) / 1000).toFixed(1);
    setAiState(
      "ready",
      `${garment.name} 模型原图已生成`,
      `推理 ${(result.timings_ms.total / 1000).toFixed(2)} s · 衣层实验 ${totalSeconds} s · 点击“完整 AI 原图”核对换衣效果`,
    );
    showToast(`真实衣层已生成：${garment.localizedName}`, "check");
    return true;
  } catch (error) {
    if (!controller.signal.aborted && state.aiController === controller && error?.name !== "AbortError") {
      console.error(error);
      setAiState(
        "error",
        state.aiRawResult?.garmentId === garmentId ? "完整原图已生成，衣层处理失败" : "真实衣层生成失败",
        `${error.message} · ${state.aiRawResult?.garmentId === garmentId ? "可查看完整 AI 原图；摄像头保持运行" : "点击按钮可重试；本地姿态预览未中断"}`,
      );
      showToast(`AI 换衣失败：${error.message}`, "circle-help");
    }
    return false;
  } finally {
    if (state.aiController === controller) {
    state.aiBusy = false;
    state.aiController = null;
    state.aiGenerationGarmentId = null;
    clearInterval(aiProgressTimer);
    aiProgressTimer = null;
    elements.aiTryOnButton.disabled = false;
    elements.aiTryOnButton.classList.remove("is-loading");
    elements.aiTryOnButtonLabel.textContent = state.aiStatus === "ready" ? "重新生成" : "AI 换衣";
    for (const option of elements.qualitySwitch.querySelectorAll(".quality-option")) option.disabled = false;
    }
  }
}

async function maybeGenerateNeuralLayer({ automatic = false, force = false } = {}) {
  if (state.aiBusy || (engine.neuralLayerReady && !force)) return false;
  if (automatic && state.lastAutoGarmentId === state.selectedGarment.id) return false;
  return generateNeuralGarmentLayer({ automatic, force });
}

async function requestAiTryOn() {
  if (state.pipeline === "full-frame") return startFullFrame();
  if (state.aiBusy) return;
  if (engine.source !== "camera") {
    try {
      await startCamera();
    } catch {
      return;
    }
  }

  setAiState("detecting", "正在定位双肩", "支持半身入镜，腰部和手肘无需可见");
  const found = await waitForRequiredPose(8000);
  if (!found) {
    setAiState("detecting", "等待双肩进入画面", "半身即可；看清双肩后约 1 秒开始生成");
    showToast("请让双肩进入画面，无需露出腰部", "scan-line");
    return;
  }
  state.lastAutoGarmentId = null;
  await maybeGenerateNeuralLayer({ automatic: false, force: true });
}

function renderGarments() {
  const scrollTop = elements.garmentList.scrollTop;
  const focusedId = document.activeElement?.closest(".garment-card")?.dataset.id;
  document.querySelector("#wardrobeCount").textContent = String(GARMENTS.length).padStart(2, "0");
  const filtered = GARMENTS.filter(
    (garment) => (state.filter === "all" || (state.filter === "uploaded" ? garment.uploaded : garment.category === state.filter)) &&
      `${garment.localizedName} ${garment.name} ${garment.id}`.toLowerCase().includes(state.search),
  );
  const empty = document.querySelector("#wardrobeEmpty");
  empty.hidden = filtered.length > 0;
  empty.textContent = state.filter === "uploaded" && !GARMENTS.some(item => item.uploaded)
    ? "这里还没有你的衣服。上传一张参考图，开始新的试穿。"
    : "没有找到匹配的衣服，试试其他名称。";
  elements.garmentList.innerHTML = filtered
    .map((garment) => {
      const index = GARMENTS.findIndex((item) => item.id === garment.id) + 1;
      const selected = garment.id === state.selectedGarment.id;
      return `
        <button class="garment-card ${selected ? "is-selected" : ""}" data-id="${garment.id}" type="button" aria-pressed="${selected}">
          <span class="garment-thumb">
            <img src="${garment.asset}" alt="${garment.localizedName}" loading="lazy" decoding="async" width="160" height="160" />
            <i class="garment-accent" style="--garment-accent:${garment.accent}"></i>
          </span>
          <span class="garment-info">
            <small>LOOK ${String(index).padStart(2, "0")} · ${garment.category}</small>
            <strong>${garment.localizedName}</strong>
            <span>${garment.uploaded ? "本次上传 · 页面内保留" : "服装参考图"}</span>
          </span>
          <span class="garment-check"><i data-lucide="check"></i></span>
        </button>
      `;
    })
    .join("");
  createIcons({ icons: ICONS });
  elements.garmentList.scrollTop = scrollTop;
  if (focusedId) [...elements.garmentList.querySelectorAll(".garment-card")].find(card => card.dataset.id === focusedId)?.focus({ preventScroll: true });
  updateGarmentSelection();
}

function updateGarmentSelection() {
  for (const card of elements.garmentList.querySelectorAll(".garment-card")) {
    const selected = card.dataset.id === state.selectedGarment.id;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  }
  document.querySelector("#selectedReferenceImage").src = state.selectedGarment.asset;
  document.querySelector("#selectedReferenceName").textContent = state.selectedGarment.localizedName;
  document.querySelector("#selectedReferenceMeta").textContent = state.selectedGarment.uploaded ? "本次上传 · 刷新后清除" : `LOOK ${String(GARMENTS.indexOf(state.selectedGarment) + 1).padStart(2, "0")} · 内置样衣`;
  document.querySelector("#removeUploadedGarment").hidden = !state.selectedGarment.uploaded;
}

elements.garmentList.addEventListener("click", event => {
  const card = event.target.closest(".garment-card");
  if (card) void selectGarment(card.dataset.id);
});
document.querySelector("#garmentSearch").addEventListener("input", event => {
  state.search = event.target.value.trim().toLowerCase();
  renderGarments();
});

async function selectGarment(id) {
  const garment = GARMENTS.find((item) => item.id === id);
  if (!garment || garment.id === state.selectedGarment.id) return;
  const wasStreaming = fullFrame?.running;
  fullFrame?.stop();
  lastFullFrame = null;
  clearRawResult();
  state.aiController?.abort("garment-changed");
  clearInterval(aiProgressTimer);
  state.aiController = null;
  state.aiBusy = false;
  state.lastAutoGarmentId = null;
  state.personVisibleSince = 0;
  state.selectedGarment = garment;
  const index = GARMENTS.findIndex((item) => item.id === id) + 1;
  elements.activeGarmentIndex.textContent = String(index).padStart(2, "0");
  elements.activeGarmentName.textContent = garment.name;
  elements.activeGarmentType.textContent = `${garment.localizedName.toUpperCase()} / AI 衣层 + LIVE WARP`;
  if ([...elements.garmentList.querySelectorAll(".garment-card")].some(card => card.dataset.id === id)) updateGarmentSelection();
  else renderGarments();
  await engine.setGarment(garment);
  if (state.pipeline === "full-frame") {
    fullFrameStatus("idle", "参考衣服已切换");
    document.querySelector("#fullFrameDetail").textContent = "新服装将重新生成完整画面，旧输出已清除";
    elements.activeGarmentType.textContent = "完整生成画面 / 不裁衣贴回";
    if (wasStreaming && engine.source === "camera") void startFullFrame();
    return;
  }
  setAiState(
    engine.source === "camera" ? "detecting" : "idle",
    engine.source === "camera" ? "检测到人体后生成新衣层" : "等待摄像头",
    engine.source === "camera" ? "请保持正面站立约 1 秒" : "开启摄像头并站入画面",
  );
  showToast(
    engine.source === "camera" ? `正在生成：${garment.localizedName}` : `已选择：${garment.localizedName}`,
    "shirt",
  );
  if (engine.source === "camera") {
    void maybeGenerateNeuralLayer({ automatic: true });
  }
}

function updateStats(next) {
  stats = next;
  if (state.pipeline === "full-frame") {
    elements.frameCount.textContent = String(lastFullFrame?.frames ?? 0);
    const smooth = lastFullFrame?.smoothing;
    const fps = smooth ? lastFullFrame.displayFps : lastFullFrame?.generatedFps;
    elements.fpsValue.textContent = fps > 0 ? fps.toFixed(1) : "--";
    document.querySelector("#fpsLabel").textContent = smooth ? "显示帧率（含补帧）" : "模型生成帧率";
    elements.fpsFoot.textContent = smooth
      ? `真实生成 ${(lastFullFrame.generatedFps || 0).toFixed(1)} FPS · AI 补帧`
      : `真实生成帧率 · 相机 ${next.cameraFps.toFixed(0)} FPS`;
    return;
  }
  const previewFps = next.source === "camera" ? next.cameraFps : next.fps;
  elements.fpsValue.textContent = previewFps > 0 ? Math.round(previewFps) : "--";
  elements.fpsFoot.textContent =
    next.source === "camera" ? `跟踪 ${next.poseHz.toFixed(0)} Hz · ${next.trackingMode === "upper-body" ? "半身模式" : "双肩定位"}` : "合成预览 · 非摄像头帧率";
  const lastResult = state.aiLastResult;
  elements.aiLatencyValue.textContent = lastResult
    ? (lastResult.timings_ms.total / 1000).toFixed(2)
    : "--";
  elements.aiLatencyUnit.textContent = lastResult ? "s" : "s";
  elements.aiLatencyFoot.textContent = lastResult
    ? `${lastResult.steps} STEPS · ${state.aiGenerationCount} 次`
    : `CATVTON ${state.generationSteps} STEPS`;
  elements.networkRttValue.textContent = lastResult ? Math.round(lastResult.roundTripMs) : "--";
  elements.networkRttFoot.textContent = lastResult
    ? `服务 ${Math.round(lastResult.service_ms)} ms · 回传 ${(lastResult.responseBytes / 1024).toFixed(0)} KB`
    : "包含推理和传输，不是网络 RTT";
  elements.jitterValue.textContent = next.source === "camera" ? next.frameJitterMs.toFixed(1) : "--";
  elements.driftValue.textContent = next.jitterPx.toFixed(1);
  elements.driftFoot.textContent =
    next.jitterPx < 2 ? "ONE EURO · 稳定" : next.jitterPx < 5 ? "ONE EURO · 跟踪中" : "ONE EURO · 快速运动";
  if (state.aiService?.ready) {
    const gpu = state.aiService.gpu || "CatVTON";
    elements.localLatency.textContent = lastResult ? `${Math.round(lastResult.roundTripMs)} ms` : "READY";
    elements.localBackendLabel.textContent = gpu;
    elements.localBackendDetail.textContent = lastResult
      ? `Pose ${next.poseMs.toFixed(1)} ms · Mask ${next.segmentMs.toFixed(1)} ms · ${next.delegate}`
      : `后台跟踪 · ${next.trackingMode === "upper-body" ? "半身" : "双肩定位"} · ${next.delegate}`;
  } else {
    elements.localLatency.textContent = next.source === "camera" ? `${Math.round(next.poseMs + next.segmentMs)} ms` : "DEMO";
    elements.localBackendLabel.textContent = next.modelReady
      ? `${next.delegate} DELEGATE · 本机`
      : "等待模型加载";
    elements.localBackendDetail.textContent = next.modelReady
      ? `WebGL · ${next.webglRenderer}`
      : "AI 衣层生成 + MediaPipe + Warp";
  }
  elements.localBackendDetail.title = next.webglRenderer ?? "";
  elements.frameCount.textContent = next.frames.toLocaleString("zh-CN");
  elements.trackedPoints.textContent = next.source === "demo" ? "33" : String(next.observedPoints ?? 0);
  updatePersonDetection(next);
}

const engine = new TryOnEngine({
  canvas: elements.canvas,
  poseCanvas: elements.poseCanvas,
  generatedCanvas: document.querySelector("#generatedCanvas"),
  onStats: updateStats,
  onStatus: ({ phase, message }) => {
    if (phase === "loading") {
      elements.statusText.textContent = "正在加载本地模型";
      showToast(message, "refresh-cw");
    } else if (phase === "ready") {
      elements.statusText.textContent = "本地推理已就绪";
    } else if (phase === "live") {
      elements.statusText.textContent = "摄像头实时流运行中";
    } else if (phase === "error") {
      elements.statusText.textContent = message;
      showToast(message, "camera-off");
    }
  },
});

engine.fullFrameMode = state.pipeline === "full-frame";
engine.setGarment(state.selectedGarment);
elements.activeGarmentIndex.textContent = String(GARMENTS.indexOf(state.selectedGarment) + 1).padStart(2, "0");
elements.activeGarmentName.textContent = state.selectedGarment.name;
renderGarments();

function fullFrameStatus(status, message) {
  document.querySelector("#generationBadge").textContent = ({ connecting: "连接中", generating: "生成中", ready: "已连接", error: "连接中断" })[status] || "待开始";
  document.querySelector("#generationBadge").dataset.status = status;
  if (status === "idle" || status === "error" || status === "connecting") {
    document.querySelector("#saveGeneratedFrame").disabled = true;
    document.querySelector("#previewModeLabel").textContent = engine.source === "camera" ? "本地相机预览 / 尚未生成" : "交互演示 / 非 AI 输出";
  }
  document.querySelector("#fullFrameTitle").textContent = message;
  document.querySelector("#fullFrameButton").textContent = fullFrame?.running ? "停止连续生成" : "开始连续生成";
  const tags = { ready: "FULL-FRAME AI / EXPERIMENT", generating: "GENERATING CURRENT FRAME", connecting: "CONNECTING FULL-FRAME AI", error: "FULL-FRAME AI / DISCONNECTED", idle: "FULL-FRAME AI / EXPERIMENT" };
  elements.stagePipelineTag.lastChild.textContent = ` ${status === "idle" && engine.source === "demo" ? "DEMO / NO AI OUTPUT" : tags[status] ?? tags.idle}`;
  elements.stagePipelineTag.dataset.status = status;
  if (status === "error") {
    state.fullFrameService = null;
    setServiceNotice("生成连接已中断", "旧输出已清除，本地相机仍可使用；检查服务后手动重新开始。", "offline");
    lastFullFrame = null;
    elements.aiLatencyValue.textContent = "--";
    elements.networkRttValue.textContent = "--";
    document.querySelector("#fullFrameDetail").textContent = "旧生成画面已清除；当前显示原始摄像头，请检查服务后重新开始";
  }
  syncStudioState();
}

function syncStudioState() {
  const cameraOn = engine.source === "camera";
  document.body.dataset.camera = cameraOn ? "on" : "off";
  document.querySelector("#cameraEmptyState").hidden = cameraOn || state.pipeline !== "full-frame";
  document.querySelector("#cameraStep").dataset.complete = String(cameraOn);
  document.querySelector("#garmentStep").dataset.complete = "true";
  document.querySelector("#generationStep").dataset.complete = String(Boolean(fullFrame?.running));
  const pause = document.querySelector("#togglePauseButton");
  pause.setAttribute("aria-pressed", String(state.paused));
  pause.setAttribute("aria-label", state.paused ? "恢复预览" : "暂停预览");
  pause.title = state.paused ? "恢复预览" : "暂停预览";
  document.querySelector("#pauseOverlay").hidden = !state.paused;
  document.querySelector("#pauseOverlay small").textContent = cameraOn ? "摄像头仍开启；可恢复预览或关闭摄像头" : "点击播放按钮，恢复预览";
  if (!lastFullFrame) document.querySelector("#previewModeLabel").textContent = cameraOn ? "本地相机预览 / 尚未生成" : "交互演示 / 非 AI 输出";
}

fullFrame = new FullFrameClient({
  video: engine.video,
  canvas: document.querySelector("#generatedCanvas"),
  onStatus: fullFrameStatus,
  onFrame: (frame) => {
    lastFullFrame = frame;
    document.querySelector("#saveGeneratedFrame").disabled = false;
    document.querySelector("#previewModeLabel").textContent = frame.smoothing ? "真实 AI 输出 / 含补帧" : "真实 AI 输出 / 原始生成帧";
    elements.aiLatencyValue.textContent = (frame.inference_ms / 1000).toFixed(2);
    elements.aiLatencyFoot.textContent = frame.smoothing ? "KLEIN 2 STEPS · 另计补帧" : "KLEIN 2 STEPS · 无插值";
    elements.networkRttValue.textContent = Math.round(frame.sampleToDrawMs);
    elements.networkRttFoot.textContent = `采样到绘制 · 含传输/生成 · ${(frame.responseBytes / 1024).toFixed(0)} KB`;
    const networkAndCapture = Math.max(0, frame.sampleToDrawMs - (frame.service_ms || 0) - (frame.queue_ms || 0) - (frame.displayBufferMs || 0));
    document.querySelector("#latencyBreakdown").textContent =
      `模型 ${Math.round(frame.inference_ms)} ms · 排队 ${Math.round(frame.queue_ms || 0)} ms · 采集/传输 ${Math.round(networkAndCapture)} ms · 显示 ${Math.round(frame.displayBufferMs || 0)} ms` +
      (frame.networkRttMs != null ? ` · 链路 RTT ${Math.round(frame.networkRttMs)} ms` : "");
    document.querySelector("#latencyBreakdown").title = `相机采样与 JPEG 编码 ${Math.round(frame.captureEncodeMs || 0)} ms；上传确认 ${Math.round(frame.uploadAckMs || 0)} ms。采集/传输项是扣除已测阶段后的估算值，并非纯网络 RTT。`;
    document.querySelector("#fullFrameDetail").textContent = frame.smoothing
      ? `完整画面补帧显示；本帧显示缓冲 ${Math.round(frame.displayBufferMs)} ms，已计入采样到绘制。无关键点衣层贴片。`
      : "显示完整模型输出；采集、生成和回传并行，服务只保留最新等待帧。无关键点衣层贴片。";
  },
});

fullFrame.log.onChange = () => {
  const journal = fullFrame.log;
  const summary = journal.summary();
  const ms = (value) => Number.isFinite(value) ? `${Math.round(value)} ms` : "--";
  document.querySelector("#runtimeLogSummary").textContent = summary.count
    ? `运行日志 · P50 ${ms(summary.p50_ms)} · P95 ${ms(summary.p95_ms)} · 最大 ${ms(summary.max_ms)} · 超1秒 ${summary.slow_frames}/${summary.count}`
    : "运行日志 · 自动记录，等待生成";
  const age = document.querySelector("#runtimeFrameAge");
  age.textContent = `当前原帧帧龄：${ms(summary.visible_age_ms)}（会随等待增长；不等于最新一帧的完成耗时）`;
  age.classList.toggle("is-slow", summary.visible_age_ms >= 1000);
  document.querySelector("#runtimeLogStorage").textContent = summary.remote_available
    ? "已同步服务端耗时日志；不记录摄像头或衣服图片。可直接导出前后端对应帧。"
    : "浏览器正在记录；服务端日志未确认同步，导出仍保留本地耗时。";
  if (!document.querySelector("#runtimeDiagnostics").open) return;
  const rows = journal.events.filter((row) => row.event === "client_display").slice(-10).reverse();
  document.querySelector("#runtimeLogRows").replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr"), m = row.metrics;
    for (const text of [new Date(row.wall_time_ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
      row.frame_id, ms(m.total_ms), ms(m.inference_ms), `${ms(m.header_to_payload_ms)} / ${ms(m.decode_ms)} / ${ms(m.playback_ms)}`]) {
      const td = document.createElement("td"); td.textContent = String(text); tr.append(td);
    }
    tr.classList.toggle("is-slow", m.total_ms >= 1000);
    return tr;
  }));
};
document.querySelector("#exportRuntimeLog").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try { await fullFrame.log.download(); }
  finally { document.querySelector("#exportRuntimeLog").disabled = false; }
});
document.querySelector("#clearRuntimeLog").addEventListener("click", () => fullFrame.log.clear());
document.querySelector("#runtimeDiagnostics").addEventListener("toggle", () => fullFrame.log.onChange());

async function refreshFullFrameStatus() {
  if (state.demoMode) {
    state.fullFrameService = null;
    setServiceNotice("免 GPU 交互演示", "可浏览样衣、上传衣服和打开本地相机；本模式不产生 AI 换衣结果。", "demo");
    elements.systemState.innerHTML = "<i></i> LOCAL DEMO / NO GPU";
    elements.localBackendLabel.textContent = "交互演示模式";
    elements.localBackendDetail.textContent = "本地预览 · 不连接远程 GPU";
    elements.localLatency.textContent = "DEMO";
    elements.networkState.innerHTML = "<i></i> LOCAL DEMO";
    return null;
  }
  if (serviceCheckPromise) return serviceCheckPromise;
  serviceCheckPromise = checkFullFrameService().finally(() => { serviceCheckPromise = null; });
  return serviceCheckPromise;
}

let serviceCheckPromise = null;
function setServiceNotice(title, detail, status) {
  document.querySelector("#serviceNoticeTitle").textContent = title;
  document.querySelector("#serviceNoticeDetail").textContent = detail;
  document.querySelector("#serviceNotice").dataset.status = status;
  document.querySelector("#retryService").textContent = state.demoMode ? "连接真实 AI 服务" : "重新检查服务";
  document.querySelector("#fullFrameButton").disabled = ["demo", "offline", "loading"].includes(status) && !fullFrame?.running;
  document.querySelector("#fullFrameButton").title = status === "demo" ? "连接真实 AI 服务后可开始生成" : status === "offline" ? "请先重新检查并连接 AI 服务" : "";
}

async function checkFullFrameService() {
  try {
    const response = await fetch("http://127.0.0.1:8022/api/status", { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const service = await response.json();
    if (state.pipeline !== "full-frame") return null;
    if (service.engine !== "FLUX.2-klein-4B / FluxRT" || service.output !== "full-frame") throw new Error("8022 不是完整画面生成服务");
    state.fullFrameService = service;
    setServiceNotice(service.ready ? "AI 服务已就绪" : "模型正在加载", service.ready ? "支持半身与任意服装图片；开始生成后，相机帧经隧道发送至远程 GPU。" : "可先浏览衣柜和使用本地相机，稍后重新检查服务。", service.ready ? "ready" : "loading");
    elements.localBackendLabel.textContent = service.gpu || "RTX 5090";
    elements.localBackendDetail.textContent = "FLUX.2 Klein · 完整画面 · 不使用衣层 Warp";
    elements.localLatency.textContent = service.ready ? "READY" : "LOADING";
    elements.systemState.innerHTML = service.ready ? "<i></i> FULL-FRAME AI / READY" : "<i></i> FULL-FRAME AI / LOADING";
    elements.systemState.classList.toggle("is-error", !service.ready);
    return service;
  } catch (error) {
    if (state.pipeline !== "full-frame") return null;
    elements.systemState.innerHTML = "<i></i> FULL-FRAME AI / OFFLINE";
    elements.systemState.classList.add("is-error");
    state.fullFrameService = null;
    setServiceNotice("GPU 服务暂不可用 · 本地预览仍可使用", "不会自动重试或启动 GPU。资源恢复后，启动 8022 隧道并点击重新检查服务。", "offline");
    elements.localBackendLabel.textContent = "完整画面服务未连接";
    elements.localBackendDetail.textContent = "检查 5090 服务及 8022 隧道";
    return null;
  }
}

async function startFullFrame() {
  if (state.pipeline !== "full-frame" || fullFrame.running) return;
  if (state.paused) { showToast("先恢复预览，再开始生成", "play"); return; }
  if (state.demoMode) { showToast("当前是交互演示；使用上方按钮连接真实 AI 服务", "circle-help"); return; }
  if (!state.fullFrameService?.ready) {
    const service = await refreshFullFrameStatus();
    if (!service?.ready) { fullFrameStatus("idle", "AI 服务未就绪，本地相机可继续使用"); return; }
  }
  if (engine.source !== "camera") await startCamera();
  if (engine.source !== "camera") return;
  lastFullFrame = null;
  await fullFrame.start(state.selectedGarment, { smooth: document.querySelector("#fullFrameDisplay").value === "smooth",
    profile: document.querySelector("#fullFrameProfile").value });
}

function applyPipeline() {
  const generated = state.pipeline === "full-frame";
  fullFrame.stop();
  lastFullFrame = null;
  state.aiController?.abort("pipeline-changed");
  state.aiController = null;
  state.aiBusy = false;
  clearInterval(aiProgressTimer);
  clearRawResult();
  engine.neuralLayerReady = false;
  engine.fullFrameMode = generated;
  void engine.setGarment(state.selectedGarment);
  state.lastAutoGarmentId = null;
  document.body.classList.toggle("full-frame-mode", generated);
  document.querySelector("#tryonPipeline").value = state.pipeline;
  document.querySelector("#fullFrameControls").hidden = !generated;
  elements.neuralRunbar.hidden = generated;
  document.querySelector("#fpsLabel").textContent = generated ? "模型生成帧率" : "摄像头预览帧率";
  document.querySelector("#requestTimeLabel").textContent = generated ? "采样到绘制" : "请求总耗时";
  document.querySelector("#activeModelLabel").textContent = generated ? "FLUX.2 KLEIN" : "POSE + CATVTON";
  elements.activeGarmentType.textContent = generated ? "完整生成画面 / 不裁衣贴回" : "旧版衣层 Warp / 仅供对照";
  elements.networkState.innerHTML = generated ? "<i></i> REMOTE / 5090" : "<i></i> LEGACY";
  if (generated) fullFrameStatus("idle", "完整画面生成：等待摄像头");
  else {
    if (engine.source === "camera") void engine.loadModels();
    setAiState("idle", "旧版衣层贴片对照", "此方式不会随新姿态重新生成褶皱和遮挡");
  }
  elements.aiLatencyValue.textContent = "--";
  elements.aiLatencyFoot.textContent = generated ? "KLEIN · 等待生成" : `CATVTON ${state.generationSteps} STEPS`;
  elements.networkRttValue.textContent = "--";
  elements.networkRttFoot.textContent = generated ? "包含采集、传输、推理与绘制" : "包含推理和传输，不是网络 RTT";
  void refreshAiServiceStatus();
  syncStudioState();
}

document.querySelector("#tryonPipeline").addEventListener("change", (event) => {
  state.pipeline = event.target.value;
  localStorage.setItem("vton-pipeline", state.pipeline);
  applyPipeline();
});
document.querySelector("#fullFrameButton").addEventListener("click", () => {
  if (fullFrame.running) {
    fullFrame.stop();
    lastFullFrame = null;
    fullFrameStatus("idle", "生成已停止，当前显示原始摄像头");
  } else void startFullFrame();
});
let uploadedGarmentUrl = null;
let garmentUploadSequence = 0;
async function uploadGarment(file) {
  if (!file) return;
  const sequence = ++garmentUploadSequence;
  const message = document.querySelector("#garmentUploadStatus");
  try {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      throw new Error("请选择不超过 8 MB 的 JPG、PNG 或 WebP 衣服照片");
    }
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    if (sequence !== garmentUploadSequence) return;
    if (!blob) throw new Error("衣服照片转换失败");
    const oldUrl = uploadedGarmentUrl;
    uploadedGarmentUrl = URL.createObjectURL(blob);
    const old = GARMENTS.findIndex((garment) => garment.uploaded);
    if (old >= 0) GARMENTS.splice(old, 1);
    const garment = { id: `uploaded-${crypto.randomUUID()}`, name: "Custom Garment", localizedName: "自定义衣服",
      category: "上装", asset: uploadedGarmentUrl, uploaded: true, accent: "#d8ff58", type: "shirt", widthScale: 1, lengthScale: 0.12, drape: 1 };
    GARMENTS.push(garment);
    state.filter = "all"; state.search = "";
    document.querySelector("#garmentSearch").value = "";
    for (const chip of document.querySelectorAll(".filter-chip")) {
      chip.classList.toggle("is-active", chip.dataset.filter === "all");
      chip.setAttribute("aria-pressed", String(chip.dataset.filter === "all"));
    }
    await selectGarment(garment.id);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    message.textContent = "自定义衣服已选择；样衣仅在本次页面保留，点击开始即可试穿";
  } catch (error) {
    message.textContent = error.message;
    showToast(error.message, "circle-help");
  } finally { document.querySelector("#garmentUpload").value = ""; }
}
document.querySelector("#garmentUpload").addEventListener("change", event => void uploadGarment(event.target.files?.[0]));
document.querySelector("#uploadGarmentButton").addEventListener("click", () => document.querySelector("#garmentUpload").click());
const dropZone = document.querySelector("#garmentDropZone");
let dragDepth = 0;
dropZone.addEventListener("dragenter", event => { event.preventDefault(); dragDepth++; dropZone.classList.add("is-dragging"); });
dropZone.addEventListener("dragover", event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
dropZone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("is-dragging"); } });
dropZone.addEventListener("drop", event => {
  event.preventDefault(); dragDepth = 0; dropZone.classList.remove("is-dragging");
  void uploadGarment(event.dataTransfer?.files?.[0]);
});
document.querySelector("#removeUploadedGarment").addEventListener("click", async () => {
  ++garmentUploadSequence;
  const index = GARMENTS.findIndex(garment => garment.uploaded);
  if (index < 0) return;
  GARMENTS.splice(index, 1);
  await selectGarment((GARMENTS.find(garment => garment.id === "neural-look-03") || GARMENTS[0]).id);
  if (uploadedGarmentUrl) URL.revokeObjectURL(uploadedGarmentUrl);
  uploadedGarmentUrl = null;
  document.querySelector("#garmentUploadStatus").textContent = "已移除上传衣服；可选择新的 JPG、PNG 或 WebP 图片（最大 8 MB）。";
  renderGarments();
});
const fullFrameDisplay = document.querySelector("#fullFrameDisplay");
const fullFrameProfile = document.querySelector("#fullFrameProfile");
const storedGenerationProfile = localStorage.getItem("vton-generation-profile");
fullFrameProfile.value = ["fast", "balanced", "detail"].includes(storedGenerationProfile) ? storedGenerationProfile : "fast";
fullFrameProfile.addEventListener("change", () => {
  localStorage.setItem("vton-generation-profile", fullFrameProfile.value);
  const running = fullFrame.running;
  fullFrame.stop();
  lastFullFrame = null;
  updateGenerationPreference();
  if (running && engine.source === "camera") void startFullFrame();
});
fullFrameDisplay.value = localStorage.getItem("vton-display-mode") === "low-latency" ? "low-latency" : "smooth";
fullFrameDisplay.addEventListener("change", () => {
  localStorage.setItem("vton-display-mode", fullFrameDisplay.value);
  const running = fullFrame.running;
  fullFrame.stop();
  lastFullFrame = null;
  updateGenerationPreference();
  if (running && engine.source === "camera") void startFullFrame();
});
function updateGenerationPreference() {
  document.querySelector("#generationPreferenceNote").textContent = (fullFrameProfile.value === "fast" ? "流畅优先会减少小字与纹理细节。" : fullFrameProfile.value === "detail" ? "细节优先可能增加生成等待。" : "均衡兼顾速度与细节。") + (fullFrameDisplay.value === "smooth" ? "补帧让显示更连续，也会增加等待。" : "直接显示最新原帧，优先减少显示等待。");
}
updateGenerationPreference();
applyPipeline();

let cameraStartPromise = null;
async function startCamera() {
  if (cameraStartPromise) return cameraStartPromise;
  if (engine.source === "camera") return;
  cameraStartPromise = openCamera().finally(() => { cameraStartPromise = null; });
  return cameraStartPromise;
}
async function openCamera() {
  const buttons = [
    document.querySelector("#startCameraButton"),
    document.querySelector("#topCameraButton"),
  ];
  for (const button of buttons) {
    button.disabled = true;
    button.classList.add("is-loading");
  }
  elements.cameraPrompt.classList.add("is-loading");

  try {
    await engine.startCamera();
    state.paused = false; engine.resumeRendering();
    document.querySelector("#togglePauseButton").innerHTML = '<i data-lucide="pause"></i>';
    elements.cameraPrompt.classList.add("is-hidden");
    elements.sourceValue.textContent = "CAMERA";
    elements.sourceEyebrow.textContent = "CAMERA 01 / LIVE STREAM";
    elements.statusText.textContent = "摄像头实时流运行中";
    setAiState("detecting", "等待双肩进入画面", "支持半身；肘部和髋部无需可见，约 1 秒后自动生成");
    const topButton = document.querySelector("#topCameraButton");
    topButton.innerHTML = '<i data-lucide="camera-off"></i><span>关闭摄像头</span>';
    topButton.classList.add("is-camera-off");
    createIcons({ icons: ICONS });
    showToast(state.pipeline === "full-frame" ? "摄像头已连接，当前为本地预览" : "摄像头已连接，开始实时试衣", "camera");
    void refreshAiServiceStatus({ quiet: true });
    document.querySelector("#previewModeLabel").textContent = "本地相机预览 / 尚未生成";
  } catch (error) {
    engine.stopCamera();
    console.error(error);
    elements.cameraPrompt.classList.remove("is-hidden");
    const permissionDenied =
      error?.name === "NotAllowedError" || /permission|denied/i.test(error?.message ?? "");
    showToast(
      permissionDenied ? "摄像头权限被拒绝，请允许后重试" : `摄像头启动失败：${error.message}`,
      "camera-off",
    );
  } finally {
    for (const button of buttons) {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
    elements.cameraPrompt.classList.remove("is-loading");
    syncStudioState();
  }
}

function stopCamera() {
  fullFrame?.stop();
  lastFullFrame = null;
  if (state.pipeline === "full-frame") fullFrameStatus("idle", "摄像头已关闭");
  clearRawResult();
  state.aiController?.abort("camera-stopped");
  clearInterval(aiProgressTimer);
  state.aiController = null;
  state.aiBusy = false;
  state.personVisibleSince = 0;
  state.lastAutoGarmentId = null;
  engine.stopCamera();
  engine.landmarks = null;
  engine.filteredLandmarks = null;
  engine.maskReady = false;
  elements.cameraPrompt.classList.remove("is-hidden");
  elements.sourceValue.textContent = "DEMO";
  elements.sourceEyebrow.textContent = "CAMERA 01 / SYNTHETIC PREVIEW";
  elements.statusText.textContent = "演示姿态运行中";
  const topButton = document.querySelector("#topCameraButton");
  topButton.innerHTML = '<i data-lucide="camera"></i><span>启动摄像头</span>';
  topButton.classList.remove("is-camera-off");
  createIcons({ icons: ICONS });
  void engine.setGarment(state.selectedGarment);
  setAiState(
    state.aiService?.ready ? "idle" : "checking",
    state.aiService?.ready ? "真实衣层引擎已就绪" : "正在检查 CatVTON",
    state.aiService?.ready ? "点击“AI 换衣”会启动摄像头并生成真实衣物" : "检查 8020 推理服务",
  );
  showToast("摄像头已关闭，回到合成姿态演示", "camera-off");
  syncStudioState();
}

document.querySelector("#startCameraButton").addEventListener("click", startCamera);
document.querySelector("#aiTryOnButton").addEventListener("click", requestAiTryOn);
document.querySelector("#openRawResult").addEventListener("click", () => {
  if (state.aiRawResult) document.querySelector("#rawResultDialog").showModal();
});
for (const option of elements.qualitySwitch.querySelectorAll(".quality-option")) {
  option.addEventListener("click", () => {
    if (state.aiBusy) return;
    state.generationSteps = Number(option.dataset.steps);
    for (const button of elements.qualitySwitch.querySelectorAll(".quality-option")) {
      const selected = button === option;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    elements.aiLatencyFoot.textContent = state.aiLastResult
      ? `${state.aiLastResult.steps} STEPS · 下次 ${state.generationSteps} 步`
      : `CATVTON ${state.generationSteps} STEPS`;
    showToast(`下次生成使用 CatVTON ${state.generationSteps} 步`, "sparkles");
  });
}
document.querySelector("#topCameraButton").addEventListener("click", () => {
  if (engine.source === "camera") stopCamera();
  else startCamera();
});

for (const chip of document.querySelectorAll(".filter-chip")) {
  chip.addEventListener("click", () => {
    state.filter = chip.dataset.filter;
    for (const item of document.querySelectorAll(".filter-chip")) {
      item.classList.toggle("is-active", item === chip);
      item.setAttribute("aria-pressed", String(item === chip));
    }
    renderGarments();
  });
}

const widthRange = document.querySelector("#widthRange");
const drapeRange = document.querySelector("#drapeRange");
const smoothRange = document.querySelector("#smoothRange");
const dimRange = document.querySelector("#dimRange");

widthRange.addEventListener("input", () => {
  const value = Number(widthRange.value) / 100;
  document.querySelector("#widthOutput").textContent = `${widthRange.value}%`;
  engine.setOptions({ fitWidth: value });
});

drapeRange.addEventListener("input", () => {
  const value = Number(drapeRange.value) / 100;
  document.querySelector("#drapeOutput").textContent = `${value.toFixed(2)}×`;
  engine.setOptions({ drape: value });
});

smoothRange.addEventListener("input", () => {
  const value = Number(smoothRange.value) / 100;
  document.querySelector("#smoothOutput").textContent = value.toFixed(2);
  engine.setOptions({ smoothness: value });
});

dimRange.addEventListener("input", () => {
  const value = Number(dimRange.value) / 100;
  document.querySelector("#dimOutput").textContent = `${dimRange.value}%`;
  engine.setOptions({ backgroundDim: value });
});

document.querySelector("#poseSwitch").addEventListener("change", (event) => {
  state.showPose = event.target.checked;
  engine.setOptions({ showPose: state.showPose });
});

document.querySelector("#maskSwitch").addEventListener("change", (event) => {
  state.useMask = event.target.checked;
  document.querySelector("#dimControl").classList.toggle("is-disabled", !state.useMask);
  dimRange.disabled = !state.useMask;
  engine.setOptions({ useMask: state.useMask });
});

document.querySelector("#togglePoseButton").addEventListener("click", () => {
  state.showPose = !state.showPose;
  document.querySelector("#poseSwitch").checked = state.showPose;
  engine.setOptions({ showPose: state.showPose });
});

document.querySelector("#togglePauseButton").addEventListener("click", (event) => {
  state.paused = !state.paused;
  if (state.paused) {
    fullFrame?.stop();
    lastFullFrame = null;
    if (state.pipeline === "full-frame") fullFrameStatus("idle", "预览和生成已暂停");
    engine.running = false;
    event.currentTarget.innerHTML = '<i data-lucide="play"></i>';
    elements.statusText.textContent = "预览已暂停";
  } else {
    engine.running = true;
    engine.resumeRendering();
    event.currentTarget.innerHTML = '<i data-lucide="pause"></i>';
    elements.statusText.textContent =
      engine.source === "camera" ? "摄像头实时流运行中" : "演示姿态运行中";
  }
  createIcons({ icons: ICONS });
  syncStudioState();
});

document.querySelector("#fullscreenButton").addEventListener("click", async () => {
  const frame = document.querySelector("#mirrorFrame");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await frame.requestFullscreen();
  } catch (error) {
    showToast(`全屏不可用：${error.message}`, "circle-help");
  }
});

document.querySelector("#toggleFocusButton").addEventListener("click", event => {
  const focused = document.body.classList.toggle("studio-focus");
  event.currentTarget.setAttribute("aria-pressed", String(focused));
  event.currentTarget.querySelector("span").textContent = focused ? "退出专注" : "专注预览";
});
document.querySelector("#jumpWardrobe").addEventListener("click", () => {
  document.querySelector("#wardrobeSection").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  document.querySelector("#wardrobeHeading").focus({ preventScroll: true });
});
document.querySelector("#backToPreview").addEventListener("click", () => {
  document.querySelector(".stage-heading").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  document.querySelector("#jumpWardrobe").focus({ preventScroll: true });
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.body.classList.contains("studio-focus") && !document.querySelector("dialog[open]") && !document.fullscreenElement) document.querySelector("#toggleFocusButton").click();
});

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "--";
}

function updateRemoteSummary() {
  const samples = state.remoteSamples;
  if (!samples.length) {
    elements.rttMedian.textContent = "--";
    elements.rttP95.textContent = "--";
    elements.rttJitter.textContent = "--";
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  let differenceTotal = 0;
  for (let index = 1; index < samples.length; index += 1) {
    differenceTotal += Math.abs(samples[index] - samples[index - 1]);
  }
  const jitter = samples.length > 1 ? differenceTotal / (samples.length - 1) : 0;
  elements.rttMedian.textContent = formatMs(median);
  elements.rttP95.textContent = formatMs(p95);
  elements.rttJitter.textContent = formatMs(jitter);
}

function setRemoteStatus(status, label) {
  elements.remoteState.textContent = label;
  elements.remoteSummary.dataset.status = status;
}

function connectRemote() {
  if (state.remoteSocket) {
    state.remoteSocket.close();
    state.remoteSocket = null;
  }
  state.remoteConnected = false;
  state.remoteSamples = [];
  elements.runRemoteTest.disabled = true;
  setRemoteStatus("connecting", "连接中");

  let socket;
  try {
    socket = new WebSocket(elements.remoteUrl.value);
  } catch (error) {
    setRemoteStatus("error", "地址无效");
    showToast(`远程地址无效：${error.message}`, "wifi-off");
    return;
  }
  state.remoteSocket = socket;

  const timeout = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) socket.close();
  }, 5000);

  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    state.remoteConnected = true;
    setRemoteStatus("ready", "已连接");
    elements.connectRemote.innerHTML = '<i data-lucide="wifi-off"></i><span>断开</span>';
    elements.runRemoteTest.disabled = false;
    createIcons({ icons: ICONS });
    localStorage.setItem("vton-remote-url", elements.remoteUrl.value);
    showToast("远程推理服务连接成功", "wifi");
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "pong" && Number.isFinite(message.client_sent_ms)) {
        const rtt = performance.now() - message.client_sent_ms;
        state.remoteSamples.push(rtt);
        updateRemoteSummary();
      }
    } catch {
      // Probe messages are intentionally small and JSON-only.
    }
  });

  socket.addEventListener("close", () => {
    clearTimeout(timeout);
    state.remoteConnected = false;
    state.remoteSocket = null;
    setRemoteStatus("offline", "未连接");
    elements.connectRemote.innerHTML = '<i data-lucide="wifi"></i><span>连接</span>';
    elements.runRemoteTest.disabled = true;
    createIcons({ icons: ICONS });
  });

  socket.addEventListener("error", () => {
    setRemoteStatus("error", "连接失败");
  });
}

async function runRemoteProbe() {
  if (!state.remoteSocket || state.remoteSocket.readyState !== WebSocket.OPEN) return;
  state.remoteSamples = [];
  updateRemoteSummary();
  elements.runRemoteTest.disabled = true;
  elements.runRemoteTest.classList.add("is-loading");

  for (let index = 0; index < 24; index += 1) {
    state.remoteSocket.send(
      JSON.stringify({
        type: "ping",
        seq: index,
        client_sent_ms: performance.now(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 42));
  }
  await new Promise((resolve) => setTimeout(resolve, 240));
  elements.runRemoteTest.disabled = false;
  elements.runRemoteTest.classList.remove("is-loading");
  if (state.remoteSamples.length) {
    const sorted = [...state.remoteSamples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    showToast(`网络探测完成：P95 ${p95.toFixed(1)} ms`, "activity");
  }
}

elements.remoteUrl.value = localStorage.getItem("vton-remote-url") || "ws://127.0.0.1:8010/ws";

function openDiagnostics() {
  elements.diagnosticsDialog.showModal();
  elements.remoteUrl.focus();
}

document.querySelector("#openDiagnostics").addEventListener("click", openDiagnostics);
document.querySelector("#networkAction").addEventListener("click", openDiagnostics);
elements.connectRemote.addEventListener("click", () => {
  if (state.remoteConnected) {
    state.remoteSocket?.close();
  } else {
    connectRemote();
  }
});
elements.runRemoteTest.addEventListener("click", runRemoteProbe);

elements.diagnosticsDialog.addEventListener("click", (event) => {
  if (event.target === elements.diagnosticsDialog) elements.diagnosticsDialog.close();
});

window.addEventListener("beforeunload", () => {
  if (uploadedGarmentUrl) URL.revokeObjectURL(uploadedGarmentUrl);
  fullFrame?.stop();
  fullFrame?.log.destroy();
  engine.destroy();
  state.remoteSocket?.close();
});

window.__VTON_DEBUG__ = {
  engine,
  catvton,
  state,
  getStats: () => stats,
  startCamera,
  stopCamera,
  selectGarment,
  generateNeuralGarmentLayer,
  fullFrame,
  startFullFrame,
};

const backendSelect = document.querySelector("#inferenceBackend");
if (![...backendSelect.options].some((option) => option.value === catvton.apiUrl)) {
  backendSelect.add(new Option("自定义服务", catvton.apiUrl));
}
backendSelect.value = catvton.apiUrl;
function updateBackendBadge() {
  if (state.pipeline === "full-frame") return;
  const remote = catvton.apiUrl !== "http://127.0.0.1:8020";
  elements.networkState.classList.toggle("is-remote", remote);
  elements.networkState.innerHTML = remote ? "<i></i> REMOTE" : "<i></i> LOCAL";
}
backendSelect.addEventListener("change", async () => {
  clearRawResult();
  state.aiController?.abort("backend-changed");
  state.aiController = null;
  state.aiBusy = false;
  clearInterval(aiProgressTimer);
  state.aiLastResult = null;
  state.lastAutoGarmentId = null;
  state.aiService = null;
  catvton.setApiUrl(backendSelect.value);
  updateBackendBadge();
  await refreshAiServiceStatus();
});
updateBackendBadge();
void refreshAiServiceStatus({ quiet: false });

document.querySelector("#retryService").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  state.demoMode = false;
  if (location.search.includes("demo=1")) history.replaceState(null, "", "/studio");
  try { await refreshAiServiceStatus({ quiet: true }); }
  finally { button.disabled = false; }
});
document.querySelector("#openHelp").addEventListener("click", () => document.querySelector("#helpDialog").showModal());
document.querySelector("#helpDialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelector("#saveGeneratedFrame").addEventListener("click", async () => {
  const canvas = document.querySelector("#generatedCanvas");
  if (canvas.hidden || !lastFullFrame) { showToast("请先生成一帧 AI 画面", "circle-help"); return; }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `衣见-AI试穿-${Date.now()}.png`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("已保存当前 AI 画面");
});
document.addEventListener("visibilitychange", () => {
  engine.setPageVisible(!document.hidden);
  if (document.hidden && fullFrame.running) {
    fullFrame.stop(); lastFullFrame = null;
    fullFrameStatus("idle", "页面已转入后台，连续生成已停止；返回后可手动开始");
  }
});
