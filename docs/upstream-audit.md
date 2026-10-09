# FrameBaker 上游审计（P0）

审计日期：2026-10-10。范围：固定上游源码、随仓字体与已安装依赖的只读检查。本文件不代替运行、桌面打包或真实角色质量验收；命令与运行日志由 `docs/environment.md`、`docs/evidence/` 和阶段进度记录补充。

## 来源与历史

- 上游：[taotao7/FrameBaker](https://github.com/taotao7/FrameBaker)。本地：`D:\AIJOB\tools\Sprite Motion Studio\framebaker`。
- 固定 commit：`f9846c985156f83f750bcc654b56cae2a1960229`，上游提交时间 `2026-09-02 13:38:47 +0800`，标题 `feat: add color key and generation backgrounds`；根及三个 workspace 的版本为 `0.5.0`。
- 本地 `git rev-parse --is-shallow-repository` 为 `false`，`git rev-list --count HEAD` 为 `179`。最早可达提交是 `984968db9eb0f1cd8d118c98e2b45fbf562c3389`（2026-08-02，Bun workspace scaffold）；没有用重新初始化仓库抹去历史。
- 远程仅 `upstream=https://github.com/taotao7/FrameBaker.git`，没有猜测用户的 `origin`。本次审计没有提交、推送或更改远程。
- 根 `LICENSE` 是 MIT，版权 `Copyright (c) 2026 taotao7`，原文保留。[固定版本许可](https://github.com/taotao7/FrameBaker/blob/f9846c985156f83f750bcc654b56cae2a1960229/LICENSE)。字体、npm 依赖与派生动作分别登记在 `THIRD_PARTY_NOTICES.md`。

已阅读 `AGENTS.md`、`docs/architecture.md`、`docs/api.md` 及下表所列源码。`AGENTS.md` 说“没有 test framework”已落后于实际 `package.json`：当前提供 `bun run test`（`bun test tests`）、`typecheck` 和 `version:check`。源码是能力判断依据；文档中的“内置抠图”是可选环境探测，不表示已随源码提供模型或 Python 运行时。

## 保留／改造／禁用地图

| 决策 | 实际路径 | 已确认实现与本产品处理 |
|---|---|---|
| 保留 | `apps/web/src/components/{ProjectList,MaterialsPage,Editor,FrameEditor,Timeline,PlaybackBar,JobPanel}.tsx` | React 19/PixiJS 编辑、素材管理、动画轴、多轨、播放与 WebSocket 任务面板；继续扩展同一界面。 |
| 保留并补强 | `apps/web/src/{frameGeometry.ts,export.ts}` | 统一中心锚点、偏移、旋转、尺度、透明度语义；现有导出按共同包围盒烘焙多轨与攻击特效。固定画布、角色全局比例及地面根轨迹须补充。 |
| 保留 | `apps/web/src/{imageops/,hooks/useCropQueue.ts,hooks/useImportWorkflow.ts}` | 本地 Worker/canvas 裁剪、透明边缘扫描、色键抠像；色键只是可选工具，不能替代场景视频分割。 |
| 改造 P1 | `apps/server/src/jobs/extract.ts`、`api/import.ts`、`api/materials.ts` | 默认 MP4 为 `fps` 滤镜；增加默认完整模式、ffprobe 时间清单和不可变来源。旧 FPS/定点路径只作显式采样。 |
| 改造 P1/P4 | `apps/server/src/db.ts`、`timeline.ts`、`api/timeline.ts` | 复用 SQLite、Project/axis/track/step；补来源帧、修订、迁移备份和可配置工作区，不建重复的 Character 数据库。 |
| 改造 P1/P4 | `apps/server/src/queue.ts` | SQLite 仅存状态，payload/controller/waiting 在内存；补持久化负载、阶段记录和中断恢复。 |
| 改造 P2 | `apps/server/src/jobs/matting.ts`、`scripts/setup_matting.{ps1,sh}` | 支持配置 CLI、仓库 venv、PATH rembg；取消缺引擎复制假成功，改为明确依赖错误，增加显式模型准备及复用 session 的 Worker。 |
| 保留并补强 | `apps/server/src/jobs/run.ts` | `Bun.spawn(argv)` 无 shell、捕获 stderr、支持取消；补运行时路径、超时、日志和 stdout 排空策略。遗留空白切分模板不支持引用有空格的可执行路径，结构化 CLI 字段优先。 |
| 改造 P4 | `apps/web/src/export.ts`、`zip.ts` | PNG 序列与精灵图目前在浏览器 Canvas/ImageBitmap 生成 ZIP；正式导出移入统一服务，GUI/CLI 调同一业务路径。 |
| 改造 P4/P5 | `apps/server/src/{index.ts,app.ts,ws.ts,mcp/}` | 补 loopback 绑定、身份校验、Host/Origin 检查、实例锁和私有连接信息；MCP 白名单调用业务服务。 |
| 保留并本地打包 | `apps/web/src/pixiLoader.ts`、`styles.css`、`apps/web/public/fonts/`、`apps/server/src/app.ts` | Pixi 从同源 `/pixi.min.js` 加载；字体随仓。前端基础界面没有必须联网的 CDN。打包须复制/嵌入运行时资源，保留字体 OFL。 |
| 简化模式禁用 | `api/import.ts` 的 generate、`jobs/generateApi.ts`、`providerAdapter.ts`、`enhance.ts`、`jobs/imageLayers.ts`，相应 GUI/MCP 工具 | 云生成、提示词增强、远端图片分层与任意自定义生成 CLI 不属于视频素材处理闭环。服务端也须拒绝这些操作；只隐藏按钮不构成禁用。保留上游代码供后续明确授权使用。 |
| 简化模式隐藏 | `components/{MotionsPage,SkeletalProjectEditor,AnimationAssetsWorkspace,ActionGenModal}.tsx`、`api/{animationAssets,skeletalProjects,characterPartSets}.ts` | 骨骼、部件生成、动作重定向不进入本期关键流程；无需大规模删除。 |

## 数据模型确切映射

| 方案概念 | 固定上游实体／接口 | 扩展约束 |
|---|---|---|
| Workspace | 当前 `STORAGE_ROOT=<repo>/storage`、`framebaker.db` | 新工作区配置决定唯一 SQLite 与文件根；一个工作区一个写入服务。不要把安装目录当用户数据目录。 |
| Character / CLI project | `projects` / shared `Project`，`kind='frame'`，`POST /api/projects` | 复用 Project ID，加角色共享画布、尺度和锚点预设。 |
| Clip | `animation_axes` / `AnimationAxis`，`POST /api/projects/:id/axes` | 一个动作/方向对应一条轴与该轴主轨，补 source 关联、选择表和修订。默认轴为 `Default`、8 FPS；这只是编辑 tick，不能作为源 FPS。 |
| 主图层 | `animation_tracks` / `AnimationTrack.is_primary` | `Main` 主轨；保留多轨叠加。axis 是动作时间轴，不是图层，track 是图层，不是动作。 |
| 编辑步骤 | `animation_steps` / `TimelineStep` | 一轴各轨共享 step；`duration` 为整数 tick，播放约为 `duration/axis.fps` 秒。保留原有兼容镜像，不用量化 tick 覆盖精确源时间。 |
| Source / SourceFrame | 上游没有独立不可变实体 | 新增来源与源帧，保存原文件、sha256、整数源索引、PTS/time_base、有理数显示时长及末帧推导来源；可被多个 Clip 引用。 |
| FrameEdit | `frames`，`track_id + step_id` 单元格、`is_asset` 与共享变换 | 上游 `raw_path/processed_path` 不足以表达不可变来源和多修订遮罩。补 source_frame 引用、选择/时长/遮罩/根位置修订。 |
| ExportVersion | 无正式服务导出实体 | 新增输入修订、recipe/manifest、不可变输出、校验结果及审核状态。 |

`timeline.ts::appendFramePool` 确认抽帧仅进入 `is_asset=1` 且无 track/step 的帧池。用户拖入轨道才产生时间轴实例；`placeAssetFramesBatch` 保留资产并复制实例。P1 自动创建 Clip 时必须明确组装主轨，不能把“已有 PNG”当“已有可播 Clip”。旧迁移将历史帧按 `idx,id` 投影到 Default/Main，共享 step 上保留 duration。新迁移应增量并备份，保留这套兼容模型。

## 抽帧、原始数据与队列事实

`extract.ts::extractToStaging` 中 MP4 默认命令包含 `-vf fps=<p.fps>`；`api/import.ts` 默认 8、范围 1–60。定点模式每次执行 `-ss <time> -i <file> -frames:v 1`，秒值按毫秒四舍五入、排序、去重，达到 shared `EXTRACT_TIMESTAMPS_MAX=64` 后停止；HTTP schema 也把 timestamps 限为 64。`VideoExtractModal.tsx` 的区间填充同样截断，默认 8 FPS，手动步进使用 `1/24`。这些不能沿用作全帧模式。

文件先产出到新 staging，再移入项目/素材；但没有源视频永久副本、源帧 PTS、逐 PNG 验证或一批文件与数据库的统一提交事务。成功 `cleanupStaging` 删除上传暂存文件及其父目录，项目因此不再保留原视频。失败在 `extractToStaging` 内没有统一 finally 清理/状态标记；须处理故障、取消和诊断残留。输出 `frame_%04d.png` 以字符串 `.sort()` 排序，超过补零宽度后不保证整数顺序，应显式源整数索引排序。

`queue.ts` 的 `payloads`、`controllers`、`waiting` 是内存集合。模块导入会把已有 queued/running 行改为 `error='服务重启，任务中断'`；不会恢复参数。取消支持 queued 出队与 running AbortController。没有 waiting_user/interrupted、数值阶段进度、检查点、输入修订冲突或恢复入口。`db.ts` 模块导入本身创建目录/库并执行迁移；审计没有 import 它，也没有接触现有 storage。

上游保留 raw 与 processed 槽，并已有 `undo.ts` 的 SQLite `project_undo` 和项目文件快照，不能声称它没有撤销。但这是项目表/文件快照，不等于独立 SourceFrame 与手工遮罩修订。`api/frames.ts` 删除会删除未共享的 raw/processed 文件；素材导入若有有效 matted 图会让项目图片槽全部使用该结果。因此原视频与完整源帧必须放在独立不可变来源区，避免旧删除/撤销语义破坏它们。

## 缺抠图引擎的精确行为

1. `getMattingInfo()` 每次解析设置，顺序为结构化 custom CLI/遗留 env template → `.venv-matting/bin/rembg` 或 `Scripts/rembg.exe` → PATH `rembg` → `engine='none'`。不是只在启动时探测。
2. 无引擎时 `runMatting()` 执行 `copyFileSync(input, output)` 并返回中文警告。不会验证前景 Alpha，也不会失败。
3. `matteFrame()` 把暂存输出移动到项目 processed，更新 `status='ready', processed_path` 并广播 `frame_updated`。`matteMaterial()` 直接写 `processed.png`，更新 `status='matted'` 并广播 `material_updated`。
4. 队列先把 warning 写进 running progress，随后用初始 `completionProgress='完成'` 调 `setJob(...,'done',...)`，最终查询只见 done/完成，警告只有过程广播可见。云图片分层的自动抠图还会忽略 `matteMaterial` 返回的 warning 并继续上传该图。

结论：上游会把原样复制登记为处理完成，违反方案 §0/§8。P2 应返回 `BACKEND_UNAVAILABLE` / `MODEL_NOT_READY`，避免发布 processed/matted 假结果；正式导出必须检查状态和审核。此次只审计，没有运行或修改这条路径，也没有把缺模型合成验收成透明角色。

## MCP、安全与外部网络

MCP 是真实 SDK 实现：`mcp/index.ts` 使用 `@modelcontextprotocol/server@2.0.0` 的 `createMcpHandler/McpServer`，`app.ts` 对 `/mcp` 挂 Streamable HTTP；工具源码共有 48 个 registerTool 调用。它们直接操作 SQLite/内部模块而非自调用 HTTP。HTTP 与 MCP 的项目创建、设置等仍有重复逻辑；新服务必须共用业务函数，不能再长出第二套处理链。协议兼容性与 SDK 自身防护需运行测试，源码注释不代替结果。

`index.ts` 只传 port，没有 hostname。Bun 官方文档默认 hostname 为 `0.0.0.0`，所以日志写 localhost 并不保证仅本机监听；Windows 实际绑定证据留给运行探针。[Bun 服务配置](https://bun.com/docs/runtime/http/server)。同文件在 WS upgrade 前没有应用鉴权或 Host/Origin 检查，`ws.ts` 向所有已连接客户端广播。`app.ts` 未实现统一 token/Host/Origin 校验；MCP 未设置应用级鉴权策略。不是发现了已验证攻击，而是明确缺少产品所需的访问控制。

`api/settings.ts` 的 GET 返回完整设置，包括配置的 API keys；MCP get_settings 只遮挡 genProviders/promptEnhancers，未遮挡 imageLayers 内的 key。MCP update_setting 的白名单含 matting/genProviders/imageLayers，value 仅为 z.any，可配置本地可执行程序与外部端点。配合广泛生成工具，这不是可直接交给不受限 Agent 的最小接口。须统一配置校验、密钥脱敏、处理工具白名单与可信文件范围。

真实外部调用包括 `generateApi.ts` 向配置云端生成接口上传引用图、轮询并 fetch 返回媒体 URL；`imageLayers.ts` 将本地图片作为 multipart 上传 `/images/layers`，随后下载返回 URL；`enhance.ts` 请求聊天模型；`providerAdapter.ts` 与 doctor 做端点连通性请求。未观察到导入视频自动上传代码；这些需要显式功能调用/配置，但不符合本产品默认离线范围，应在简化服务侧禁用。doctor 检查非纯只读：它临时写文件，且配置存在时会联网；P1 local doctor 应明确限制网络。

rembg 调用设置 `U2NET_HOME=storage/models`；doctor 把未缓存模型记为 ok 并提示首次自动下载，只按文件名包含模型名判断缓存，未校验 SHA-256。这不是显式模型准备/许可登记。不得为了普通抽帧自行安装/下载模型。

## 桌面与性能边界

固定上游无 Electron 主进程、preload、桌面打包、CLI sfs 或工作区实例锁。`index.ts` 用 Bun HTML import 启动服务；Windows 专门禁用前端 HMR 以避开 Pixi 聚合循环初始化问题，这显示上游已考虑 Windows，但不证明便携包可运行。

打包关注点：`db.ts` 的 import.meta.dir 三层回溯可能在编译后的资源位置改变；`app.ts` 的 Pixi 指向 `apps/web/node_modules/pixi.js/dist/pixi.min.js`，Worker 路由运行时 Bun.build 读取 TS entry，字体路由读源目录。需由探针确认编译/静态资源定位，并把数据置于用户可写工作区；不要把所有这些路径假定自动嵌入 exe。Electron 窗口须启用 contextIsolation/sandbox、关闭 nodeIntegration，并限定 IPC 与导航。[Electron 官方安全要求](https://www.electronjs.org/docs/latest/tutorial/security)。

基础前端不依赖 CDN：`pixiLoader.ts` 使用同源 `/pixi.min.js`，styles.css 指本地 WOFF2。非基础外部端点如上节所列。导出会 `Promise.all` 解码全部所选帧，播放开始也对 `allFrames` 全部 `Assets.load`，300 帧高分辨率占用需要实测与受控缓存；已有 `media.ts` 缩略图并发限制为 4，缺工具时回退原图，不能直接宣称大规模列表始终低内存。

## 本阶段已收到的运行证据

以下是主执行代理生成的记录，本审计已读取这些文件核对；不是由审计代理重跑，也不是仅从口头状态推测：

| 验证 | 结果 | 记录 |
|---|---|---|
| 上游测试 | 首次 196 pass / 3 fail，失败为 POSIX 硬编码夹具；Windows 可执行夹具修正后 199 pass / 0 fail，未删除测试 | `docs/evidence/p0/tests.txt`、`tests-windows.txt`、`docs/environment.md` |
| 类型检查 | 主执行代理记录 exit 0 | `docs/evidence/p0/typecheck.txt`、`docs/environment.md` |
| 合成导入与编辑 | 48 个源显示帧、24 FPS、2 秒，旧默认 8 FPS 得到 16 个 pool frame；首帧偏移/时长可修改 | `docs/evidence/p0/upstream-smoke.json` |
| GUI PNG 导出 | 16 张 RGBA、尺寸一致、非空；报告明确 matting 未执行、角色美术未评估 | `docs/evidence/p0/png-inspection.json`、`quality-report.md`；Alpha 边缘来自画布/变换，不能据此声称去掉场景背景 |
| 缺引擎复现 | engine none、未下载模型，job done/完成、material matted，raw/processed SHA-256 完全一致 | `docs/evidence/p0/matting-missing.json`、`matting-file-hashes.json` |
| 编译 Bun 最小探针 | Windows exe 启动、SQLite 读写、嵌入 HTML/text 返回 200，停后端口关闭；moduleDir 为 `B:\\~BUN\\root` | `docs/evidence/p0/bun-report.json` |
| 完整上游直接编译 | 编译出 exe 后启动失败，exit 1；主执行代理报告 db.ts 的虚拟根 mkdir EPERM，最小探针证明可配置可写路径路线 | `docs/evidence/p0/bun-report.json`；完整 stderr 与 Electron 回退结果由 `docs/desktop-probe.md` 补充，未在本审计自行宣称回退已通过 |

直接编译现存 `db.ts` 的源码路径假设确有不兼容，需先改数据根与打包资源定位；这不是要求弃用 Bun/Elysia/SQLite 的证据。源码改造后的完整宿主/资源/退出流程仍须运行验证。

## 许可结论、阻塞与后续

FrameBaker MIT 源码允许本次本地二次开发，历史/版权已保留。实际 font metadata 指向 Fusion Pixel `2026.07.01`，OFL 文本已随仓；npm 依赖不是全部 MIT。完整记录见 `THIRD_PARTY_NOTICES.md`。没有复制 SpriteBro、FrameExtractor、video2image 或其他许可不明 GUI 项目代码。

**本源码审计没有发现需要停止 P1 或替换底座的实质阻塞。** 全帧、持久化、安全、确定性导出与桌面资源定位均是已授权范围内的常规改造。P0 的平台启动/编译探针若出现无法解决的真实错误，仍须以完整日志重新决定，不能仅凭此审计标 P0 运行通过。

公开分发前尚须完成：准确收集 Electron/Bun/Python/FFmpeg 等实际分发构建的许可，确认模型权重许可及哈希，核对字体发布资产字节来源/关联字形 notice，独立记录 docs/media 展示素材来源。它们是发布清单待办，不阻塞本地 P1 完整抽帧开发。真实视频、真实角色人工质量、Cocos 3.8.8 实测与干净 Windows 便携包仍待后续阶段；本审计不作这些验收声明。
