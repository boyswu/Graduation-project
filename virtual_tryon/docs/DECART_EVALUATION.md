# Anywear / Decart 接入核查（2026-10-26）

结论：能作为本项目的新云端生成引擎接入，保留现有衣柜、上传、界面，替换视频链路即可，无需推倒重来。有官方成品widget的限量免费试用路线，也有深度集成的按秒计费API路线。已核查官方资料及本机现有官方扩展2.20的静态源码；没有新装插件、创建推理会话或向 Decart 发送用户视频，没有获得本项目的Decart实测延迟。

## 最新决定：不使用付费API，只借鉴公开实现

用户明确拒绝额外付费；取消Decart账户、余额、密钥和商业接入作为下一步。用户澄清“背面”指真人转身后，生成衣服背面并继续跟随，非上传两张衣服图。本项目继续使用现有GPU，不新购算力或启动其他付费服务。

- **可以借鉴**：官方SDK和tryon-examples均标注MIT许可；可依许可研究其摄像头MediaStream、WebRTC视频播放、连接生命周期、质量统计及换衣控制。保留第三方许可证要求。开源SDK是云端接口客户端，不包含Lucy推理服务、训练方案或权重；直接安装SDK仍会调用供应商服务。扩展程序包自身不能因SDK开源就视为全部MIT授权。
- **现有实现已具备的部分**：后台采集编码、采集/推理/回传并行、只保留最新等待帧、服装参考编码缓存和可选整帧插值。不是把传输协议换名就获得Anywear生成能力。最新真实用户152帧中推理中位193.63ms，采样到绘制中位371.25ms；这个推理耗时对应约5次/秒的量级，尚未计网络和显示。WebRTC可能改善传输/播放，但仍需实测，无法单独将现有模型提升至每秒25–30次真实生成。原先约5ms的采集编码已不是首要瓶颈。
- **转身背面是生成问题**：当前后端每次接收完整相机画面，但只有一张256×256服装参考图，使用通用FLUX图像编辑器逐帧处理；空间缓存与RIFE不等于经过视频换衣训练的跨帧服装一致性。能否正确识别背对、让前胸图案不跑到背后、处理转身遮挡，需要模型和真实转身序列验证。只有正面参考图时，未见过的背部图案是推测，不能保证与实物一致；若以后有正背面资料，应研究真正的多视角条件，不能只切换两张贴片冒充生成。
- **证据边界**：官方VTON文档当前公开的是单个image字段；本机扩展四个主要文件未检出专用front/back参考输入字段。这不否定用户实际看到的转身效果，也不能证明其内部视频模型结构、训练方式或服务端加速细节。只能确认外部接口和媒体链路，不能把推断写成已获得供应商核心方法。
- **后续免费路线的顺序**：先用同一段含正面→侧面→背面→正面的短视频隔离测当前生成器，逐帧验前胸/背部图案、遮挡和延迟；再在隔离候选中测试推理加速或可用开源视频生成器，最后评估WebRTC。验收同时报告真实生成FPS和动作延迟，插值FPS另列。当前SSH转发为TCP，WebRTC媒体的ICE/UDP或中继可达性尚未验证，不能直接视作现有隧道的替换组件。此轮仅完成核查和路线调整，没有修改用户已认可的生成配置或声称背面功能已修好。

公开来源：[SDK与MIT许可](https://github.com/DecartAI/sdk)、[MIT接入示例](https://github.com/DecartAI/tryon-examples)、[VTON接口](https://docs.platform.decart.ai/models/realtime/virtual-try-on)。

## 本机已安装扩展的实际实现

检查范围仅限 Chrome Default/Extensions 下官方ID的 `2.20_0` 程序文件，没有读取浏览器账户、Cookie、Local Storage或令牌。包内manifest声明版本2.20、名称Anywear: Live Virtual Try-On。

- `config.js` 的令牌地址是 `https://anywear.decart.ai/api/tokens`；`widget.bundle.js` 使用Decart SDK的 `realtime.connect(cameraStream, ...)`，将回传MediaStream直接赋给视频元素的 `srcObject`。SDK内包含LiveKit媒体传输实现。证据支持“云端连续视频生成”，并非浏览器内运行本地换衣权重。
- 扩展内应用默认候选是 `lucy-vton-3.5`，但令牌响应配置的 `modelName` 会覆盖该默认值。只读静态代码不能确定用户那次会话的实际模型、是否fast档或服务端算力配置。官方最新API文档的3.6也不能据此等同于扩展实际运行版本。
- 源码明确处理 `origin_not_registered`、`account_disabled`、`session_cap_reached`、`time_cap_reached`、`subscription_required`。这些说明存在服务端准入/额度检查；不能通过复制扩展文件或调用它的私人令牌接口获得稳定、无限或授权的开发服务。
- 摄像头质量脚本请求横向1088×624（ideal约束，实际分辨率需运行时读取）；与本项目512×512逐图传输并不相同。SDK内有视频帧时序和连接质量统计，但这不构成本机延迟实测，不能单凭WebRTC或视频帧率保证更低动作延迟。
- 公开widget loader静态GET返回200；它按商品页Product/ProductGroup的JSON-LD识别页面。本项目当前没有这些商品页标记，也未安装Decart SDK。因此直接粘贴商家script不能认定已完成衣柜接入；保留自有衣柜应走官方SDK/API。脚本可下载不等于localhost已获服务端准入。

复核指纹：`widget.bundle.js` SHA256 `95520d3f8546c78f19f53e2a74d24e47380ec6c8c4ff2071d2563ee6f752f128`；`config.js` SHA256 `b7f3d7bf6ccf3df8c46358092280438d6da997b009409a841e727eee8f09bdd6`。未修改扩展文件或调用其私人令牌接口。

## 已核实

- 正式产品为 [Anywear by Decart](https://anywear.decart.ai/)，[Chrome 商店](https://chromewebstore.google.com/detail/anywear-live-virtual-try/hijnklblgecbdlhjiofhlhjpndpifejh)开发者为 Decart.AI, Inc.；插件ID `hijnklblgecbdlhjiofhlhjpndpifejh`。同名网站不能自动视为这个产品。
- 官方产品页说明由 Lucy V-TON 提供连续视频换衣。开发者可使用 `@decartai/sdk`：相机 MediaStream 经 WebRTC 发到托管模型，返回完整视频流；通过参考服装图片和提示词换衣，无需每换一件就重连。[官方 VTON 文档](https://docs.platform.decart.ai/models/realtime/virtual-try-on)、[官方接入示例](https://github.com/DecartAI/tryon-examples)。这条链路与当前逐帧 JPEG/模型/图片回传不同。
- 文档当前的 `lucy-vton-latest` 指向 `lucy-vton-3.6`，720p，支持参考图和可选 fast mode。SDK与示例开放源码，不表示对应模型权重可下载到本机5090；本次未找到这个版本的公开本地权重。宣传流畅度、启动等待与真实动作到显示延迟必须分别验收，不能照搬营销文案。
- 官方 [API价格表](https://docs.platform.decart.ai/getting-started/pricing)列普通实时档 $0.02/秒，即 $1.20/分钟；fast档 $0.04/秒，即 $2.40/分钟。它按实际生成时长计费，新账户试用额度与插件Beta活动应以账户当前页面为准。当前项目没有API余额或已配置密钥的核实记录。
- 正式集成需要服务端保管API密钥、按连接签发短期客户端令牌，再由浏览器建立视频连接。活动会话中视频与参考图会传往Decart服务，应先确认用户接受该部署及计费方式；当前授权仅到核查可用性。[令牌说明](https://docs.platform.decart.ai/models/realtime/virtual-try-on#client-token-security)、[隐私政策](https://docs.platform.decart.ai/resources/privacy-policy)。

## 可复用与需要替换

若只想先验证产品，可评估官方 [商家widget](https://anywear.decart.ai/business)：网页声明可通过一行异步script加载、iframe隔离，在Beta期间提供限量试用。脚本示例地址为 `https://anywear.decart.ai/widget/latest/anywear.js?domain=yourstore.com`。这保留供应商的试衣界面，不能视为当前项目可无限免费调用模型；是否需要登记域名、是否支持本机localhost与实际额度，本次未验证。适合先以官方演示页面或用户已安装的扩展作手工对照，不应擅自给现有页面注入并启动摄像头上传。

保留本项目衣柜、8件参考样衣、自定义上传、界面和诊断面板；新增一个明确选择的云端对照模式即可。SDK返回视频应直接交给video元素播放，使用供应商支持的帧计时/RTC统计记录，避免再次套用当前逐图编码和补帧路径。普通档与fast档要分别计费、分别测试；开始连接前获取令牌，退出立即断开会话。

当前已修复一个本机瓶颈：真实用户56帧记录中采集编码P95约1008ms、最高1172ms，而模型推理中位约221ms。改为VideoFrame/OffscreenCanvas后台编码后，用户反馈卡顿明显减少；新152帧记录的采集编码中位约4.95ms、最高21.6ms，采样到绘制中位371ms、P95约474ms。两段动作、缓存命中率和网络条件不同，不能把全部差异归因于编码或当作Decart对照。这项修复不涉及Decart视频处理。[原始耗时对照](runtime-user-capture-fix-20261026.json)。

正式对照至少覆盖相同两件衣服、相同摄像头与网络、左右移动/抬手各30秒；分别记录生成视频帧率、动作到显示延迟、首次换衣等待、图案与袖口、身份和遮挡。没有真正连接并对照前，不承诺比当前项目快多少或达到参考团队效果。
