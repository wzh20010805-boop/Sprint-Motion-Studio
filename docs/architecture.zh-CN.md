# FrameBaker 架构

## 总览

当前源码生产API为 **1.3**。CLI、桌面和后端引导入口解析同一选定工作区；每个活动工作区只有一个经过鉴权的回环HTTP服务，GUI、API、WebSocket和制作MCP共用它。下图保留上游模块用于查阅代码，其中宽权限生成/provider/MCP功能属于历史参考，常规SFS入口禁用这些能力。当前归属见[统一工作区与服务生命周期](#统一工作区与服务生命周期)。

```
                        ┌──────────────────────────────────────────────┐
                        │                浏览器（React 19）             │
                        │  TopNav(项目/素材库/设置)                      │
                        │  ProjectList   Editor ─ FrameEditor(PixiJS)  │
                        │  Timeline(DnD) PlaybackBar    ImportModal   │
                        │  MaterialsPage MaterialModal(对比滑杆/剪裁)   │
                        │  CropModal ─ imageops/（Web Worker 图像处理） │
│  JobPanel（右侧常驻任务队列，WS 驱动）          │
                        │        │ fetch /api        │ WebSocket /ws   │
                        └────────┼───────────────────┼────────────────┘
                                 │                   │
┌────────────────────────────────▼───────────────────▼────────────────┐
│                    Bun.serve（apps/server/src/index.ts）            │
│  routes: "/" "/project/:id" "/materials" "/settings" → HTML import 打包 │
│  fetch:  /ws → server.upgrade ──────► ws.ts（clients 集合广播）      │
│          其余 → Elysia app（app.ts）                                │
│                                                                     │
│  Elysia /api                                                        │
│   ├─ api/projects.ts   项目 CRUD                                    │
│   ├─ api/frames.ts     帧查询/PATCH/替换/删除/复制/换序 + 图片流     │
│   ├─ api/import.ts     上传拆帧 / 生成 → 创建 job（项目帧）          │
│   ├─ api/materials.ts  素材 CRUD/抠图/批量抠图/剪裁替换/导入项目     │
│   ├─ api/settings.ts   settings 表读写（layout/theme/lang/genProviders/  │
│   │                    matting 白名单）                             │
│   └─ /api/jobs(/:id)   任务列表（面板初始加载）/ 单任务查询          │
│                                                                     │
│  mcp.ts（MCP 服务端：POST /mcp JSON-RPC 2.0 Streamable HTTP）      │
│         48 个工具直接操作 db/内部模块，供 AI 助手调用               │
│                                                                     │
│  provider.ts（多生成 provider / 抠图配置解析：settings 优先 env 兜底）│
│  providerAdapter.ts（生成校验/执行 adapter + provider 模型探测）      │
│  doctor.ts（体检 + API 联通测试：/api/doctor /api/provider/test）    │
│  queue.ts（内存队列，并发 2；JobTarget = project | materials）      │
│   ├─ jobs/extract.ts   extract_frames / generate_frames             │
│   │                    ├─ CLI 模板（jobs/run.ts）                    │
│   │                    ├─ OpenAI 兼容 API（jobs/generateApi.ts）     │
│   │                    ├─ 视频生成（百炼/MiniMax 异步轮询 → mp4）    │
│   │                    └─ generatedArtifacts.ts（分类与帧/素材入库） │
│   └─ jobs/matting.ts   matting（frame | material；引擎探测见下）    │
│                                                                     │
│  db.ts（bun:sqlite，WAL）  ──  jobs/frames/projects/materials 四表  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ 读写（绝对路径，基于 import.meta.dir）
                        ┌───────▼────────┐        ┌────────────┐
                        │ storage/（根级）│        │ ffmpeg/CLI │
                        │ framebaker.db  │        │ 外部进程    │
                        │ projects/...   │        └────────────┘
                        │ materials/...  │
                        └────────────────┘

         packages/shared：前后端共享类型与常量（无构建，exports 直指 src/index.ts）
```

## Monorepo 布局（Bun workspaces）

| 包 | 路径 | 说明 |
| --- | --- | --- |
| `@framebaker/server` | `apps/server` | Elysia API + 任务队列 + SQLite；同时经 Bun 全栈模式托管前端 |
| `@framebaker/web` | `apps/web` | React 19 + PixiJS v8 前端，`index.html` 为打包入口，字体在 `public/fonts` |
| `@framebaker/shared` | `packages/shared` | `Frame`/`Project`/`Job`/`Material`/`FramePatch`/枚举（FRAME_STATUSES、FRAME_SOURCES、JOB_TYPES、JOB_STATUSES、MATERIAL_STATUSES、GEN_PROVIDER_TYPES、WS_EVENTS）/ SOURCE_COLORS / `GenProviderSettings` / `MattingSettings` / API 响应类型 |

根 `tsconfig.base.json` 提供共享 compilerOptions（strict、moduleResolution: bundler、noEmit），各 app 的 `tsconfig.json` extends 后补自己的 lib/jsx/types。

根级 `scripts/version.ts` 实现 main 的 `MAJOR.WEEK.BUG` 发布规则，并统一同步根包/workspace package 版本、Bun lockfile workspace 版本、MCP 对外版本及中英文 changelog 发布标题。WEEK 是大版本内单调递增的开发周序号，不使用会跨年回退的 ISO 自然周。版本历史存放在 `docs/CHANGELOG.md` 与 `docs/CHANGELOG.zh-CN.md`，详细规则见 `docs/VERSIONING.md` 与 `docs/VERSIONING.zh-CN.md`。

## 关键设计

- **HTML import 全栈**：`apps/server/src/index.ts` 里 `import index from "../../web/index.html"`，`Bun.serve` 的 `routes` 把它挂在 `/` 与 `/project/:id`；编辑器页前端读 `location.pathname` 恢复项目上下文（无路由库）。development 模式（`NODE_ENV !== "production"`）下每次请求重新打包并支持 HMR。
- **storage 与 cwd 无关**：`db.ts` 用 `import.meta.dir` 上溯三级得到仓库根，`STORAGE_ROOT = <root>/storage`；DB 中 `raw_path`/`processed_path` 存绝对路径。从根 `bun dev` 或从 `apps/server` 内启动都指向同一位置。
- **任务队列**：`queue.ts` 内存 FIFO，并发上限 2；job 状态落 SQLite（queued/running/done/error/cancelled + progress/error），负载（staging 路径、prompt 等）只存内存——重启后未完成任务不恢复，启动时统一把遗留的 queued/running 标记为 error（「服务重启，任务中断」）。`POST /api/jobs/:id/cancel` 可取消排队/运行中任务（AbortSignal → `runCmd` 杀进程 / API 轮询中断）。所有状态变化经 `ws.ts` 广播；前端由 `JobPanel`（右侧常驻面板，挂在 App 根部）经 WS `job_*` 事件 + `GET /api/jobs(/:id)` 兜底轮询展示进度，排队/运行中可点取消。调度依赖保持单向：`queue.ts` 调用 `jobs/*` worker；拆帧/生成后的抠图任务通过调度层注入的窄回调入队，worker 不反向依赖队列。
- **WS 广播**：`ws.ts` 维护客户端 Set，`broadcast(type, payload)` 发 JSON；事件名在 shared 的 `WS_EVENTS` 统一定义。前端收到 `frame_updated/frames_reordered/frames_changed/job_done` 后重拉帧列表，收到 `material_updated/materials_changed` 后重拉素材列表。
- **素材来源语义**：图片分层产物使用共享 `layers` 来源并显示「分层」，不再伪装成普通 `api` 来源；启动迁移按 `metadata.provider=imageLayers` 识别并修正历史产物。
- **拆帧编号**：ffmpeg 先拆到 `staging/extract_<uuid>/frame_%04d.png`，再按 raw 目录现存最大编号续编搬入 `raw/frame_XXXX.png`，多次导入互不覆盖；`duplicate` 生成的 `dup_<uuid>.png` 不匹配该扫描规则，不会被误收。
- **注入安全**：外部命令（生成 CLI / 抠图 CLI）不走模板字符串：设置页配的是结构化字段（命令 + 参数名映射），服务端组装 argv 数组（Bun.spawn，不经 shell）；遗留 env 模板（FRAMEBAKER_GEN_CLI / FRAMEBAKER_MATTING_CLI）按空白 split 成 argv 后再替换占位符，同样不经 shell，prompt 含空格也安全。
- **生成 provider 解析**（`provider.ts`，每次调用实时读 settings 表）：settings `genProviders` 列表模型——CLI / OpenAI 兼容 API / 百炼 DashScope 原生 / Gemini（banana）/ MiniMax 可配多个共存，列表为空时 env `FRAMEBAKER_GEN_CLI` 合成 id=`env` 的 CLI provider（legacyTemplate 遗留模板路径）兜底。生成请求按 `providerId` 选择（缺省第一个配置齐备的）；`type=cli` 走结构化 argv 组装（`cliBin` + 参数名映射 `cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`，参数名留空=位置参数或不下发）；`type=api`/`dashscope`/`gemini`/`minimax` 走 `jobs/generateApi.ts`：
  - api（OpenAI 兼容）：无引用图 `POST {base}/images/generations`（JSON），有引用图 `POST {base}/images/edits`（multipart image+prompt，需 gpt-image 系列等支持 edits 的模型）；`data[0].b64_json` 或 `data[0].url` 取图，120/180s 超时。
  - dashscope（百炼原生，wan2.7-image / qwen-image 等不在兼容模式内）：`POST {base}/api/v1/services/aigc/multimodal-generation/generation`，messages content 为 `[{image: dataURI}?, {text}]`（引用图 base64 上送），同步返回 `output.choices[0].message.content[*].image` URL 后下载；`apiSize` 支持 `2K`/`1K`/`4K` 或 `宽*高`；`apiBaseUrl` 经 `normalizeDashscopeBaseUrl` 剥掉 `/compatible-mode/v1` 与 `/api/v1`（Token Plan 默认 `https://token-plan.cn-beijing.maas.aliyuncs.com`，Key `sk-sp-`）。
  - gemini（banana / nano-banana）：`POST {base}/v1beta/models/{model}:generateContent`（x-goog-api-key），parts `[{text}, {inlineData}?]`；专用响应适配器遍历全部候选，按 Gemini 元数据分类提示词/图片安全拦截与纯文本拒绝，并对暂时性 `NO_IMAGE`/`IMAGE_OTHER` 重试一次；`apiSize` 映射 `imageConfig.aspectRatio`。
  - minimax：图片 `POST {base}/v1/image_generation`（Bearer），引用图走 `subject_reference`（限一张，主体特征保持），`response_format=base64` 取 `data.image_base64[0]`；`apiSize` 映射 `aspect_ratio`。
  模型取请求 `model` 缺省列表第一项。`GET /api/config` 下发 `gen.providers` 与 `promptEnhancers` 摘要（不含 apiKey；providers 带 `video` 标记，映射见共享常量 `PROVIDER_VIDEO_SUPPORT`）。
- **视频生成**（`generateFrames` 的 `mediaKind="video"`，仅 cli/dashscope/minimax）：只生成并保存 `materials/{id}/raw.mp4`（不抽帧）；抽帧走 `POST /api/materials/:id/extract`（`fps` 整段或 `timestamps` 定点，单 job）→ `extract_frames`。CLI/百炼/MiniMax 视频协议同前；轮询 5s 间隔、10 分钟超时。**图片模式下 CLI 产物若为视频同样存为视频素材**。
- **能力分层**：provider 连接（Base URL / Key）与模型能力分离，模型按 `imageModels` / `videoModels` / `textModels` 管理，默认尺寸按 `imageSize` / `videoSize` 管理。adapter 只从目标媒体能力中选模并校验。提示词增强器通过 `providerId + model` 复用 api/dashscope 连接；旧独立凭证由运行时兼容层读取。
- **提示词加强**（`enhance.ts`）：`POST /api/enhance-prompt` 调用设置页 `promptEnhancers` 列表里的 OpenAI 兼容 `chat/completions`（加强系统提示词内置固定，像素画方向），返回优化后文本；前端保留原文并并排展示新旧两版供选择。
- **体检与联通测试**（`doctor.ts` + `providerAdapter.ts`）：`GET /api/doctor` 逐项检查存储可写 / ffmpeg / 抠图引擎与模型缓存 / 每个生成 provider（CLI 查命令存在；OpenAI 兼容、百炼兼容模式与 Gemini 实发模型列表请求；MiniMax 无轻量探测端点，仅校验字段）/ 每个加强模型（实发 `GET /models`）；`POST /api/provider/test` 用表单未保存的值单独测某个 API provider 或加强模型（8s 超时，401/403 判认证失败，标准模型列表时核对模型是否在列）。
- **抠图引擎探测**（`jobs/matting.ts`，每次调用实时解析，`GET /api/config` 可查）：a. 自定义 CLI（设置页 `matting.cliBin` 结构化字段优先，否则 env `FRAMEBAKER_MATTING_CLI` 遗留模板 `{input}` `{output}` 可选 `{model}`）→ b. `<repo>/.venv-matting` 内置 rembg（POSIX 为 `bin/rembg`，Windows 为 `Scripts/rembg.exe`；由 `scripts/setup_matting.sh` / `setup_matting.ps1` 安装：python3 venv + `pip install "rembg[cli,cpu]"`）→ c. PATH 里的 `rembg` → d. passthrough 复制并在 job.progress / 响应 warning 里提示安装。rembg 调用为 `rembg i -m <MODEL> in out`，模型名取 设置页 `matting.model` → `FRAMEBAKER_MATTING_MODEL` → 默认 u2net，模型缓存在 `storage/models`（spawn 时注入 `U2NET_HOME`）。前端上传/生成表单的「抠图去背」开关默认勾选，`GET /api/config` 驱动引擎状态显示。
- **图像处理 worker**（`apps/web/src/imageops/`）：剪裁的解码 / 透明边包围盒扫描 / PNG 编码放 Web Worker（OffscreenCanvas）。Bun 的 HTML 打包不处理 `new Worker(new URL(...))`，worker 脚本由服务端路由 `GET /imageops/imageOps.worker.js` 按需 `Bun.build` 同源下发；`client.ts` 懒加载单例并在 worker 不可用/出错时自动降级主线程 canvas，纯计算（`ops.ts`）两侧共用。
- **帧变换几何**（`apps/web/src/frameGeometry.ts`）：集中中心锚点、offset、rotation、scale 的轴对齐包围盒、fit-to-view 与 rotation 归一化；Pixi `FrameEditor` 与 Canvas `export.ts` 是两个渲染 adapter，共用同一几何语义。
- **导入工作流**（`apps/web/src/hooks/useImportWorkflow.ts`）：项目导入与素材导入共用文件状态转换、顺序上传、任务轮询、部分失败、计时器清理与完成汇总；两个 modal 仅提供各自的 FormData/API adapter，剪裁阶段继续由 `useCropQueue` 负责。
- **前端客户端边界**：`apps/web/src/api.ts` 保留为类型化 HTTP API 方法与共享响应类型的兼容门面；素材/帧图片 URL 构造位于 `api/mediaUrls.ts`，带重连的应用级 WebSocket 客户端位于 `api/ws.ts`。新增传输职责应放回所属模块，不再继续膨胀门面文件。
- **生成 provider adapter 与产物提交**：`providerAdapter.ts` 每次任务实时解析 provider，封装配置/模型/能力校验、CLI argv、API/CLI 产出分发及 doctor 的模型探测；`jobs/generatedArtifacts.ts` 拥有产物 allocation、媒体分类、帧/素材/视频入库、暂存清理、广播与自动抠图收尾。`jobs/extract.ts` 只协调“产出 → 提交”，API 厂商协议仍位于 `jobs/generateApi.ts`。

## 数据流

### MCP（AI 助手调用）

```
AI 客户端 → POST /mcp { jsonrpc, method: "initialize" }
  → 服务端返回 protocolVersion/capabilities/serverInfo + Mcp-Session-Id
  → 客户端发 notifications/initialized
  → tools/list 获取 48 个工具
  → tools/call { name, arguments } → 直接 db 操作 → 返回 { content: [{ type:"text", text:JSON }] }
```

`mcp.ts` 工具直接调用 `db` / `queue.ts` / `providerAdapter.ts` / `enhance.ts` / `doctor.ts`，逻辑与对应 `/api/*` 处理器一致但不走 HTTP 自调用。### 导入（GIF/MP4/单图）

```
浏览器 FormData → POST /api/import/upload
  → 落盘 staging/<uuid>/input.<ext>，创建 extract_frames job（入队）
  → extract.ts：ffmpeg（gif 全帧 / mp4 加 fps filter / image 直接复制）
  → 逐帧 INSERT frames（status=ready，或 autoMatting 时 matting）
  → autoMatting：每帧再入队 matting job → matting.ts（CLI 或 passthrough 复制为 processed）
  → 广播 frames_changed / job_done → 前端刷新帧列表
```

### 编辑

```
拖拽 Pixi 精灵 → pointerup → PATCH /api/frames/:id {offset_x, offset_y}
  → SQLite 更新 → 广播 frame_updated → 各客户端同步
工具栏步进调整 scale / rotation / opacity → 同一 PATCH 持久化
攻击特效绘制模式把指针轨迹采样为逐笔颜色/笔宽/压力点
  → 抬笔 PUT /api/tracks/:id/steps/:stepId/effect；没有图片的空单元格也是合法目标
  → 紧凑笔锋预览与画布共用 Catmull-Rom 平滑、宽起势/窄收尾及 flame/energy/ink 多层渲染
  → 单元格间复制粘贴矢量数据，每个步骤可独立移动/缩放/旋转/淡化
替换图片 → CropModal 剪裁并编码 PNG → POST /api/frames/:id/replace
  → 写入 processed 槽位并清理旧 processed 文件
时间轴 HTML5 DnD → 前端乐观重排 → POST /api/projects/:id/reorder {frameIds}
  → 事务重写 idx → 广播 frames_reordered
```

### 导出动画（纯前端，无服务端参与）

```
拉取全部可见时间轴单元格 → createImageBitmap
  → 为变换后的图片与矢量攻击特效计算统一全局包围盒
  → 关闭 imageSmoothing，选择烘焙为独立透明 PNG 序列或单张横向精灵图 PNG
  → ZIP 内附 <name>.frames.json（file/x/y/w/h/duration、原点及 FPS）
```

### 素材库（素材 → 抠图 → 导入项目）

任务队列的 extract/generate/matting 三类 job 用 `JobTarget`（`{kind:"project"} | {kind:"materials"}`）区分落库位置，同一套 ffmpeg/CLI 逻辑服务两个目标，不复制代码；素材类 job 的 `jobs.project_id` 存空串。

```
上传单图 → POST /api/materials/upload → materials/<id>/raw.png 直接入库（source=image）
上传 GIF/MP4 → 同上入口 → staging 暂存 → extract_frames(target=materials)
  → ffmpeg 拆帧 → 每帧一个素材（name=原文件名 #i，source=extract）
生成 → POST /api/materials/generate → generate_frames(target=materials)
  → providerAdapter 按 CLI / OpenAI 兼容 / DashScope / Gemini / MiniMax 产出
  → generatedArtifacts 分类并提交图片或视频素材（source=provider 类型，metadata 存 prompt/provider/model/size）
抠图 → POST /api/materials/:id/matting → 创建 matting job，由 JobPanel 跟踪
  → 引擎解析顺序见「关键设计」；成功产出 processed.png，status='matted'
  → 无引擎时 passthrough 复制并在 job.progress 说明
  → 前端对比滑杆查看 raw vs processed；POST /:id/unmatting 删除 processed 还原
  → 选中多个素材可 POST /api/materials/batch-matting 批量入队（二次加工按需触发）
剪裁 → CropModal（前端 worker 剪裁出 PNG blob）→ POST /api/materials/:id/replace-image
  → 覆盖当前显示图对应槽位（processed ?? raw），广播 material_updated
导入 → POST /api/materials/:id/import 或 /batch-import
  → raw / processed 分槽复制为项目帧（raw/mat_<frameId>.png，mat_ 前缀避开拆帧扫描规则），
    保留原图与抠图结果，idx 追加到项目末尾，source 沿用素材 source
  → 广播 frames_changed，开着的项目编辑器经 WS 自动刷新
```

## 存储布局

```
storage/
  framebaker.db            # SQLite（WAL）：projects / frames / jobs / materials
  projects/<projectId>/
    raw/frame_0000.png ... # 拆帧/生成的原图（dup_<uuid>.png 复制帧、mat_<uuid>.png 素材导入帧）
    processed/<frameId>.png        # 抠图或替换后的图
    processed/<frameId>_replaced.png
  materials/<materialId>/
    raw.png                # 素材原图
    processed.png          # 抠图后（可选）
  models/u2net.onnx 等     # rembg 模型缓存（U2NET_HOME，首次抠图自动下载）
  staging/<jobId>/         # 上传暂存（job 完成后清理）
  staging/extract_<uuid>/  # 拆帧暂存（完成后清理）
```

数据库表（`apps/server/src/db.ts`，启动时 CREATE TABLE IF NOT EXISTS）：

- `projects(id, name, folder_id, created_at)`
- `frames(id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe, offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)`
- 规范动画模型：`animation_axes(project_id, idx, fps)` → `animation_tracks(axis_id, idx, visible, locked, is_primary)`，并共享 `animation_steps(axis_id, idx, duration)`；`frames.track_id + step_id` 是唯一合成单元格坐标。旧 `frames.idx/duration` 暂保持同步镜像。
- 启动迁移具备事务性和幂等性：每个历史/空项目补齐 `Default`（8 fps）/`Main`；历史帧按 `idx,id` 确定性排序后各建一步，保留 ID、文件、变换、顺序和时长。`frames.is_asset` 区分左侧可复用帧资产与时间轴实例；从左侧拖放会创建实例且不消耗源资产，时间轴内部拖动仍执行移动或交换。
- `jobs(id, project_id, type, status, progress, error, created_at)`
- `materials(id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at)`
- `folders(id, kind, parent_id, name, sort, created_at)`：素材/项目多级目录（kind=`material`|`project`）
- `settings(key, value, updated_at)`：界面偏好（layout / theme / lang）与运行配置（genProvider / matting），服务端权威持久化；主题与语言前端 localStorage 仅作首屏即时缓存，加载顺序为「本地立即渲染 → 服务端值覆盖」，写入双写（布局 PUT 防抖 ~500ms），离线静默降级

## 前端页面与组件

- `App.tsx`：`/` 项目列表 ↔ `/project/:id` 编辑器 ↔ `/materials` 素材库 ↔ `/settings` 设置页（history.pushState + popstate）；全局屏蔽浏览器原生右键菜单（输入框/文本域保留用于粘贴，帧项走自定义 ContextMenu）
- `TopNav`：一级导航（项目 / 素材库 / 设置）+ 主题切换（三态：跟随系统/浅色/深色）+ 界面语言切换（zh/en，`LangToggle`）；编辑器页有自己的顶栏不显示
- `SettingsPage`：生成 provider 列表管理（CLI / API 多个共存，增删改 + 保存 + API 测试连接）、抠图配置（CLI 模板 / 默认模型 datalist + 缓存状态）、体检（doctor 结果列表）
- `ProjectList`：像素卡片网格（motion stagger 入场、hover 上浮）、新建/删除弹窗
- `MaterialsPage`：素材库页——左目录树（`FolderTree`）+ 右卡片网格（来源彩色徽标按 provider、左下角「已抠图」徽标、复选框 + Cmd/Shift 多选、拖拽入文件夹）、批量条（删除/导入项目/批量抠图仅 raw/取消）
- `ProjectList`：项目列表同左树右网格布局，新建落入当前文件夹
- `FolderTree`：全部 / 未分组 + 多级文件夹 CRUD / HTML5 DnD
- `MaterialModal`：素材详情——原图/抠图对比滑杆（pointer 拖动 clip 比例）、抠图/还原、剪裁（CropModal，作用于当前显示图槽位）、网格切分（GridSplitModal：多宫格精灵图按行×列逐格切成独立素材，网格线预览，复用 imageops cropImage + `/api/materials/upload` 单图入库，原素材保留）、多动作生成（ActionGenModal：以当前素材为引用图，按 shared `ACTION_PRESETS` 动作预设逐动作调 `/api/materials/generate`，可选 `name` 按「素材名_动作」命名，每动作一个生成任务）、导入项目（选项目+复制帧数）、删除（二次确认）
- `MaterialImportModal` / `ProjectPickerModal`：素材上传与生成入口 / 项目选择弹窗；上传 Tab 选文件后询问「是否需要剪裁」（`useCropQueue` 逐张队列或单张重裁，仅静态图）；生成 Tab 用 `ProviderModelPicker` 选 provider + 模型，提交即关窗（同 ImportModal，进度交给 JobPanel）
- `ProviderModelPicker`：生成弹窗共用的 provider + 模型选择（`GET /api/config` 的 `gen.providers` 驱动；api=模型下拉/输入，cli=`{model}` 占位符值），`resolveProviderSelection` 在提交时解析缺省值
- `CropModal` + `imageops/` + `hooks/useCropQueue`：像素图剪裁工具——整数像素框选（拖动/八向缩放/数字输入）、滚轮缩放、像素网格（zoom≥8）、自动框选非透明区域；重活走 Web Worker，失败降级主线程；两个导入弹窗、素材详情与项目帧替换共用，统一产出 PNG
- `Editor`：状态中枢（frames/activeId/selectedIds/图片版本号 v），WS 订阅刷新；帧多选与批量操作（BatchBar）
- `FrameList`：竖排帧列表，左边框色 = shared `SOURCE_COLORS[source]`（浅色主题 color-mix 加深）；帧项右键出菜单（`onContextMenu` 上抛 Editor）
- `FrameEditor`：PixiJS `Application`（async init + cancelled 竞态处理）；viewport 居中缩放；主精灵拖拽改 offset；洋葱皮（prev 红 0.3 / next 蓝 0.2）；网格 Graphics；画布背景与网格色随主题（CSS 变量）；工具栏可调 scale（10% 步进）/rotation（15° 步进）/opacity（10% 步进），并支持剪裁替换/时长±/关键帧
- `Timeline`：HTML5 DnD 换序、关键帧星标、时长角标；帧项右键出菜单（同 FrameList）
- `ContextMenu`：通用右键菜单——fixed 定位光标处、视口右/下边缘自动收拢，Esc / 点外部 / 滚动 / 失焦关闭，点项先关菜单再执行；编辑器里右键未选中帧 = 设为当前帧出单帧菜单（关键帧/时长 ±1/剪裁/复制/删除），右键落在多选内 = 保留选区出批量菜单（复制/裁透明边/删除，复用 BatchBar 的 handler）
- `PlaybackBar` + `FrameEditor` 播放模式：1–24 fps tick，每帧停留 duration 个 tick；直接复用 Pixi 变换渲染
- `ImportModal`：素材库 / 上传文件 / CLI 生成三 Tab——素材库 Tab 网格多选素材后 `batch-import` 进当前项目（主流程），顶部搜索框按素材名/prompt 本地过滤（不影响已选）；上传 Tab 多文件逐个分发，选文件后同样询问「是否需要剪裁」（与素材导入共用 useCropQueue + CropModal），提交后弹窗内轮询 `/api/jobs/:id` 汇总；生成 Tab 提交即关窗（不阻塞等待），进度交给 JobPanel；生成 Tab 支持「图片 / 视频」切换（视频模式：fps 抽帧滑杆、`ProviderModelPicker` 只列支持视频的 provider，隐藏数量/引用图/尺寸）
- `JobPanel`（挂在 App 根部）：右侧常驻任务队列面板——初始 `GET /api/jobs` 接管进行中任务，之后 WS `job_*` 事件驱动 + 活动任务 3s 轮询兜底；排队/运行中可取消；完成/取消停留 6s 自动移除，失败的常驻可手动关闭；无任务时不渲染
- `SplitDivider` + `layout.ts`：编辑器布局分隔条（帧列表宽度 180–480 默认 240、时间轴高度 80–320 默认 140），pointer capture 拖动、双击恢复默认、尺寸存 localStorage `framebaker-layout`；画布区依赖 Pixi `resizeTo`（ResizeObserver）自动跟随重绘
- `theme.ts`：主题管理（localStorage `framebaker-theme`；无记录时跟随系统 prefers-color-scheme 并实时响应系统变化）
- `i18n.ts` + `i18n/zh.ts` / `i18n/en.ts`：界面语言（zh 默认 / en）；文案用稳定 key（如 `common.close`），`t(key)` / `useT()` 查表；localStorage `framebaker-lang` + settings `lang`
- `notice.ts` + `AppModals`（挂在 App 根部）：全局通知条与确认弹窗，替代浏览器默认 `alert`/`confirm`——任何组件调 `notify(text)` / `await askConfirm(text)`，禁止再用浏览器默认弹窗
- `api.ts`：类型化 fetch 封装与兼容门面；`api/mediaUrls.ts` 负责帧/素材 URL 构造，`api/ws.ts` 负责 WebSocket 客户端（断线 3s 重连）
# 小兵工坊 P1 增量架构

保留上游 React/Pixi → Bun/Elysia → SQLite。`apps/cli` 只调用同一 HTTP 服务，Electron 开发宿主通过本地 cookie 进入原 GUI。`runtimeBootstrap.ts` 在动态加载数据库前取得工作区实例锁；`runtime.ts` 负责锁所有权，`localSessions.ts` 负责请求鉴权。CLI 和 GUI 都复用 `.sfs/service.json`，不各开第二个业务数据库写入者。

`SFS_WORKSPACE` 显式选择运行数据；未设置时上游 `storage` 兼容。迁移前 VACUUM INTO 保留 WAL 的一致备份。schema 3 增加来源、精确源帧时序、clips 映射、project revision 和任务 payload/result；clips 复用 existing axes/main tracks。`queue → pipeline/service → probe/extractAll` 单向调用，不反向引用队列。

sources 的复制原视频/PNG/timing 与 projects 的可编辑副本隔离。完整抽帧在唯一暂存目录完成，数量/连续索引/尺寸/全解码校验通过才发布，再检查 base_revision 后事务提交主轨。缓存复用也验证完整时序与 PNG；旧结果、取消或失败不提交伪完整项目。源 PTS 以字符串存整数，有理数约分时使用 BigInt；JSON 的数值须为安全整数。

P1 只维护完整原帧和时序，没有场景抠图、地面参考、统一游戏画布或正式 Cocos 导出。VFR 主轨预览可量化并警告，timing.json 为源时序依据。重启遗留 queued/running 标记 interrupted，参数和中间文件保留；恢复命令属于后续阶段。Electron 严格 CSP 通过已安装 Pixi 的无动态代码生成兼容模块运行画布。
# SFS 人机协作基础层（Task 1）

人机协作基础契约位于 `packages/shared/src/pipeline/collaboration.ts`，离线 JSON schema 位于 `collaborationSchemas.ts`。增量 schema 5 备份已提交 WAL 数据，保留旧批准但不提升为候选批准。`pipeline/collaboration/store.ts` 维护不可变的每版任务要求及持久动作工作流模式；`operations.ts` 通过 SQLite 事务保存规范化请求身份与恢复检查点。候选固定内容与可更新的检查、人工审核附加记录分离。实际制作字段推进 `projects.content_revision`，审核、名称、标签及锁定状态不推进。当前生产握手为1.3；协作HTTP及CLI/MCP门面沿用这些基础契约。

# SFS P2 扩展

Worker自动根据边缘颜色判断是否适合背景色法：98%边缘RGB与中位数最大通道差≤12且边缘不透明时，从外边连通地去除色差≤20的背景；色差5–20保留软边。其他场景仍用CPU Rembg。纯背景区域和几乎不可见结果整批失败，不发布任何新头版本。报告记录处理method与有效前景比例；Windows子进程统一UTF-8，中文错误正常显示。

`pipeline/masks.ts` 管理不可变遮罩修订、事务发布、源图摘要检查与审核；`masksApi.ts` 是GUI/CLI共用入口。依赖方向为queue → 遮罩服务 → Python Worker。`workers/image/worker.py` 每个动作只建一个CPU Rembg session，以原始RGBA与灰度遮罩合成，不隐式下载。数据库schema4新增`mask_versions`、`mask_heads`，升级前做一致备份，并保留schema3修订触发器。`MaskWorkshop.tsx` 只加载当前高清帧，以源图坐标绘画并调用共享API保存。`candy.css` 提供统一高饱和贴纸风格，`CandyDoodle` 是使用主题变量的原创矢量插画。保留上游版权和资源。详见 [P2说明](p2-guide.md)。
## SFS P3–P5 新增架构

`workers/image/compose.py`统一生成对齐预览、越界检查、透明PNG序列和规则多页图集。源坐标左上像素边界，公式q=s*(p-r)+c+d；固定/线性地面轨迹、公共画布/锚点/比例与逐帧微调。高清卡通采用预乘Alpha插值后转回直Alpha。不自动逐帧缩小、裁边、旋转或去重。

`pipeline/alignment.ts`保存角色公共预设、动作根轨迹与审核指纹；`export.ts`冻结主轨输入，产生清单/报告/联系表/MP4/ZIP，再核验修订和文件字节后发布新不可变目录。`images.ts`保留PNG原件与原Alpha，建立独立未审核遮罩。`recipe.ts`按schema提交下一未完成阶段，遇人工闸门停止。抠图缓存按项目隔离并校验输出摘要；同输入预览合并进行中的请求。

`AlignmentWorkshop`左右显示原图与共享后端画布。`FrameEditor`保留活跃纹理及8项近期缓存；时间轴惰性载入128px缩略图。GUI、CLI、MCP共用持久队列；CLI提供完整结构化stdout，`mcpBridge.ts`维持有界stdio客户租约，`mcp/sfs.ts`仅注册制作工具白名单。

`apps/desktop/main.cjs`负责独立Electron单实例、鉴权Cookie、contextIsolation/sandbox、本地CSP与资源、外部导航和权限拒绝、用户可写工作区、关闭任务策略和明确可选模型导入/下载。`distribution.ts`定位旁边的运行时。`build_portable.ts`打包CLI/服务、固定Electron、独立Python、FFmpeg、Worker与许可/清单/SHA256；`verify_portable.ts`进行本机换目录和限制系统PATH测试，不冒称干净虚拟机验收。

1.0.1先应用图片中心变换F(p)=C+kR(p-C)+o，再对齐q=s(F(p)-r)+c+d；主编辑器偏移o以源像素计，对齐微调d以输出像素计。Pillow预览、越界预检、序列和图集使用同一矩阵，透明度乘到Alpha。帧属性进入快照、缓存键和审核指纹；零缩放/透明度或重采样后前景消失为空帧，负等比缩放遵循编辑器。图集打包仍不自动旋转格子。

导入/人工修正检查实际RGBA非零Alpha，不要求不透明核心；自动抠图仍拦截低置信噪声。旧1.0.0导入提示仅在读取时规范化，不改写文件或审核状态。GUI空图检查采用原始Alpha乘遮罩。服务运行契约升级为1.1，防止新客户端静默调用旧后端。

首页糖果色PNG在apps/web/public/art，CandyDoodle使用固定同源地址。打包脚本复制至runtime/assets/art，断网可用；不改变个人素材或工作区。

### 本机桌面能力初始化

`localSessions.ts` 不依赖 DB，通过服务端 WeakMap 将认证 ActorContext 绑定到 Request。`desktopReviewBroker.ts` 负责有限换行管道帧（4096字节、连接超时3秒）、绑定 PID 的 nonce 与实例清理。工作区锁先于管道及 DB 导入。Windows 在描述文件为空时设置仅当前 owner SID 和 SYSTEM 可访问的受保护 DACL，核验真实 owner/ACE 后才写 bootstrap secret。制作描述不保存审核 Cookie。管道没有另设独立 DACL，因此不宣称跨用户管道隔离或抵御同一 OS 用户的恶意进程。

两个宿主共用 `apps/desktop/review-bootstrap.cjs`。发行宿主和探针共享服务分支的 Cookie、BrowserWindow、webRequest、权限回调使用同一持久工作区哈希 session；每次启动仍重新核对当前服务实例并取得审核能力。工作区分区保留自身界面本地状态，并避免不同工作区 Cookie 冲突。旧 owned P0 snapshot 探针保持原验证用途，不取得审核能力。保留 renderer sandbox、context isolation 和禁用 Node。

协作制作服务集中在 `pipeline/collaboration/drafts.ts`；`timing.ts` 使用动作级settings保存独立期望源选择和绑定稳定帧身份的有理数输出时长。PNG类型源清单位于已有sources.probe_json，原帧与编辑副本分开；视频source_frames保留原NOT NULL PTS约束。`collaborationApi.ts`提供服务鉴权的薄传输适配器。共享timeline时长编辑物化明确输出时长；队列按已验证任务/动作上下文决定单次job完成策略。草稿身份覆盖当前源/raw/mask/RGBA字节、顺序、时长、变换及有效共享对齐预设，排除审核附加字段和旧revision计数。

### 不可变候选制作

Task 4 新增 collaboration/candidates.ts、candidateIdentity.ts、checks.ts 与 workers/image/candidate_checks.py；继续通过现有 queue/runImageWorker 调用 compose.py。每次尝试独占 staging，复制 raw/mask/RGBA，完整合成一次 PNG 和固定图集，再冻结规范清单。正逆矩阵均为 Canvas [a,b,c,d,tx,ty]：x'=a*x+c*y+tx、y'=b*x+d*y+ty；奇异映射返回 null 及原因。根轨迹保留序号插值。manifest_json 是完整内容权威，candidate_frames 保留原有不可变投影，不重建表。

版本化规范 JSON 投影区分完整候选、逐帧内容与播放身份。逐帧身份绑定四种实际字节哈希、稳定 ID、尺寸与实际空间/渲染参数；路径、打包位置、候选 ID、不透明的遮罩版本 ID 和顺序/时长元数据不进入逐帧身份。播放身份绑定有序 ID/PNG/有理数时长/画布/循环。完整来源信息始终保存在清单中，新候选必须重新技术检查。

queue 在 pump 前用一个 immediate 事务持久化 job 与 operation attempt 关联；操作原参数按 kind/hash 验证，不从当前草稿重建。CandidateCheckpoint v1 记录 freezing/prepared/committed、operation/candidate/attempt/job ID、原 base、staging/final 路径、清单/内容哈希及完整冻结文件索引。prepared 先于 rename；文件和 base 校验后，候选/帧/committed 检查点/操作结果在短同步事务中提交。提交前取消不登记，提交后取消保留私有候选。失败 staging 或移动但未登记的目录只是证据；Task 9 负责进程崩溃恢复。不把服务串行化声称为断电/fsync 或任意外部写者保证。

Task 4 并发补充：任务 recovery_json.candidate_operation 保存 version=1、operation_id、selected_candidate_id、acceptance_epoch，表示最新首次关联的候选请求。已排队旧尝试开始运行时不会重新夺取归属。最终提交始终合并事务内当前操作历史；只有归属匹配、选定候选/接受代次未变且仍为 producing 的操作可更新任务阶段。旧尝试保留自身候选/结果/错误。提交到审核时清除这一归属项，保留其它恢复元数据；这是窄生命周期 CAS，不新增队列或协调器。


### 确定性采样与持久自检

Task 5 的 collaboration/sampling.ts 为纯选择器，以 BigInt 有理数播放区间与规范风险等级取样，无 DB 或图像 Worker 依赖。collaboration/samplingStore.ts 管理既有 candidates.sampling_plan_json 与 self_check_json 附加记录，从全量技术检查、修复关联及 Task 6 完整候选影响（包括时空邻帧）读取风险线索。共同 SamplingPlan/SampleObservation/CandidateSelfCheck 绑定固定候选/帧字节及策略/上限/来源；不增加平行表、模型、图像队列或人工批准。

每候选计划在即时 SQLite 事务中只保存一次。同一自检 writer/reader 校验观察身份、整批原子性、不可变重放、祖先关系与真实存储的已观察证据；submitCandidate 调用该唯一权威。完成记录全部选中事实及全量技术报告，区分观察/未观察/复用/问题/未覆盖风险。同一身份重新技术检查可刷新技术事实，不替换样本或观察；过期自检不能提交。现有候选任务归属 CAS、恢复元数据、操作历史及全部原件/暂存证据保留。collaborationApi 提供服务鉴权的采样/观察/自检传输，完整 CLI/MCP 候选流程由 Task 10 实现。


### 候选依赖影响

Task 6 将纯函数 `collaboration/impact.ts` 与数据库只读枚举 `collaboration/presetImpact.ts` 分离。比较器验证严格冻结清单、稳定源/覆盖/根上下文，再比较逐帧生效输入和几何、精确有理数时长、相对顺序及旧/新有向连接。内容变化只扩展一次邻帧；连接端点不递归扩展。相对顺序还可发现连接集合相同的循环旋转。公共预设变化覆盖整个被比较动作；独立服务枚举项目全部动作，包括未知绑定。不引入多预设订阅模型。

沿用 ImpactReport 区分结构继承资格与真实批准。公共预设、未知要求/来源/几何及合成器变化保守复审，删除 ID 保留解释。比较器无 DB、队列或文件 IO 依赖，不转移候选接受状态。samplingStore 仅在生成新候选初始有限预算风险计划时使用完整报告；已有计划、观察、技术检查及审核事实仍保留既有权威。TS/Pillow 插值与合成语义不变。

### 审核与接受边界

`collaboration/reviews.ts` 统一当前 reviewer 权限、候选审核 CAS/任务选择 CAS、持久操作依据、显式继承、修复派生、共同类型读取和接受判断。`reviewBoundary.ts` 提供 immediate 同步事务及任务当前操作引用的撤销；`candidates.submitCandidate`、`drafts.startRework` 调用此边界，不反向导入审核引擎/队列。未增表、事件平台或鉴权提供器。

唯一 `deliver_candidate` 操作的不可变输入为含 `AcceptanceSnapshot` 的 `DeliveryOperationInput`；调度信封再加 operation_id，避免负载哈希自引用。`AcceptanceCheckpoint` 保留快照和永久 revocation；`recovery_json.acceptance` 只是当前 `DeliveryRequest` 引用，其他恢复字段及操作历史保留。Task 8 扩展检查点/结果时保留这些字段，并通过 `withAcceptedDelivery` 同步提交，禁止在 SQLite 事务内 await 打包。成功发布结果后撤销追加 `approval_status='withdrawn'`，结果内容不删除。Task 9 恢复原操作，不能从当前草稿或目录存在重造授权。`setDeliveryScheduler` 仅是提交后窄回调，不是第二队列。

读取同时核验可覆盖审核行与持久操作依据。修复关联检查点保存子候选审核修订屏障，之后明确的帧和播放事实才能解决；继承保存父/原始确认与内容/影响身份，当前祖先变更会使依赖接受失效。AI 自检不会转换为人工批准。测试仅使用隔离合成图像和服务签发的测试 reviewer 会话，不宣称真实美术验收。

审核阶段属于新接受授权：协调先保留已有有效操作，只在 awaiting_review 中新建代次。reviewer 显式选择即使目标相同也可重新开启关闭的审核阶段，保持任务 CAS 与候选操作归属元数据。读取、advisory 或重放不能结束返工。

### Task 8 交付边界

`collaboration/delivery.ts` 从原 operation 读取经过 kind/hash/base 校验的 `DeliveryOperationInput`；稳定 delivery ID 等于 operation ID。`AcceptanceCheckpoint` 保留不可变 snapshot/永久 revocation，新增类型化 `delivery` 检查点（packaging/prepared/committed、attempt/job、staging/final 路径、原始 hashes 和完整 inventory）。原 operation 的 succeeded `DeliveryResult` 是唯一新正式提交依据，settings、job 状态及目录存在都不能替代它。

复制、归档、可选 FFmpeg 均在 SQLite 临界区外执行，move 前持久化 prepared 清单。最终候选及 staging hashes、最新批准/选择/epoch/issues/checks、move 和同步发布共用 Task 7 `withAcceptedDelivery`；无效接受的永久撤销先提交，再在事务外抛错。移动但未提交目录仅为 Task 9 恢复证据。正式提交优先于晚到取消及 job.result 丢失；真实启动/进程退出恢复仍属 Task 9。

queue 注入 Task 7 aftercommit 调度器，pump 前原子关联 job；worker 不反向导入 queue。浏览器 `exportAnimation` 在任何图像访问前按 `timeline.axis` 查询持久模式；候选分支下载原文件，不解码/Canvas/裁切/重打包。`Editor` 既有 loading/error/finally 已足够，无需重复闸门。薄 HTTP 读取/下载复用 delivery core，广泛 maker adapter 留给 Task 10。

Task 8 fix01 在写入时直接对预期 UTF-8 文档字节建立摘要，包括规范 checksums.json 和 ffconcat 文本。packaging 检查点在异步辅助/归档工作前持久化此预期清单；不能在归档后重新扫描磁盘来定义期望，辅助文件尚未生成时清单可以不完整。既有图像 worker 新增 `verify_archive`，输入 `{directory, files: Record<relativePath,sha256>}`，校验 ZIP 条目集合（无重复/多余）、每条摘要及整个校验期间不变的归档摘要，返回 `{archive_sha256,files}`。delivery 核对返回清单与可信预期清单一致，保留最终松散文件校验及共用审核事务。Task9 提升证据前必须以保留的预期清单校验 ZIP 内容，不能仅信已恢复的松散文件或 ZIP 内校验表。

Task 9 通过注入 operation 调度器保持 `queue → collaboration worker` 单向依赖。`collaboration/extraction.ts` 将显式稳定请求绑定到原 source hash、probe / base、raw / timing 清单、预定 GUI 帧 / 单元格 ID 和同事务原结果。候选与交付恢复消费已有 typed prepared checkpoint 和原操作身份，旧抽帧只有显式关联 operation 才采用严格恢复。`runtimeBootstrap.ts` 暂停队列并协调后才 import `index.ts`，协调期间没有监听 / 写入窗口。单个操作证据冲突要求补输入，不妨碍其他有效操作；DB / 锁全局错误停止启动。取消与业务发布使用同步事务，后来编辑或撤回不抹除原成功提交。实际进程退出测试保留证据，每个场景最多正常恢复两次。


Task10门面：mcp/makerTools维护CLI HTTP共用的窄schema/分发白名单，直接调用已有类型服务。mcp/request把原鉴权Request和有界parsedBody交SDK2.0.0，兼容legacy。CLI byteLines按原始UTF8字节限额/丢弃；完整类型对象不摘要。collaboration/{brief,creation,pages,cancellation}校验不可变原话/来源字节、确定性默认、内容/审核分页、操作和Task不同取消。原操作恢复仍归Task9；协作matting明确不支持恢复。reviewer嵌套路由沿用已有审核/选择CAS。当前生产版本1.3，上文foundation-only/九工具为历史阶段描述。真实source-run停在awaiting_review，不构成人工或美术验收。

Task11 新增独立 `CandidateReviewWorkspace` 与 Canvas2D `CandidateReviewCanvas`。固定最终 PNG 不经过 FrameEditor 或实时编辑变换。每个画布独占一个已解码 ImageBitmap 和一个可取消加载请求，代次保护同时处理过期成功及错误，只释放自身资源。原生像素画布通过 CSS 平移、缩放和留边显示，最终像素边界逆映射适应 DPR。`candidatePlayback` 使用 BigInt 有理数半开区间；`candidateReviewGeometry` 验证冻结逆矩阵并映射问题全部四角，不可用、裁切或不匹配时保留最终问题。`candidateReviewApi` 使用 shared 类型、Cookie 身份与 CAS。工作台明确逐帧及播放验收，显示来源、父候选影响及问题，在审核修改、WS 活动、焦点/联网恢复及有限轮询时读取持久操作。现有编辑器入口由 Task12 接入。

编辑器接入：`collaboration/editor.ts` 只读现有任务和制作时序存储，提供窄动作上下文查询。shared `ActionCollaborationState` / `DraftEditContext` 将常驻 `CollaborationPanel` 和局部 `CandidateReviewWorkspace` 模态框接入现有 Editor。只有工作台在返回谱系前执行返工；保留 FrameEditor、MaskWorkshop 和 AlignmentWorkshop 手工路径。持久状态面板独立于 JobPanel 通知过期，订阅 WS 连接失效通知并每5秒回退读取。正式动画出口继续通过 Task8 解析器读取固定文件。

## 统一工作区与服务生命周期

源码桌面 `probes/desktop/workspace-menu.cjs` 安装常显工作区菜单；`workspace-cli.cjs` 清除旧窗口的服务身份、项目路由及 profile/evidence 环境，通过已有 CLI 显式打开目标工作区并保存选择。目标使用独立审核会话，在新窗口进入项目列表；旧窗口仍标记其实际工作区并保留编辑和后台任务，不停止共享服务。工作区解析继续由 `apps/cli/src/workspaces.ts` 唯一负责。

生产握手版本统一来自 `packages/shared/src/pipeline/productionVersion.json`：共享TypeScript与桌面读取同一文件，便携构建原样复制到resources/app。已有目录别名及Windows大小写差异按同一实际工作区比较。登记读改写受排他锁保护；竞争返回 `WORKSPACE_REGISTRY_LOCKED`，未知锁保留待核查。列表中提示项带 `registered:false`，名称不会覆盖真正登记的工作区。

`apps/cli/src/workspaces.ts` 是CLI与 `runtimeBootstrap.ts` 共用的解析器；桌面通过CLI读取当前工作区，并用 `workspace use` 保存选择。优先级为显式 `--workspace`、`SFS_WORKSPACE`、登记表当前选择、默认目录。源码登记表为 `<repo>/.sfs/workspaces.json`，默认目录为 `<repo>/workspaces/default`；1.0.8便携版登记表为 `%LOCALAPPDATA%/SpriteMotionStudio/workspaces.json`，默认目录为同处 `workspaces/default`。登记使用临时文件原子替换，校验名称/真实路径重复，登记及选择要求目录已存在。切换只改变发现与选择，不搬移数据库或改写固定文件来源。

`workspace list/current/add/use` 与 `service status/stop/clean` 为本机管理命令；列表/状态查询不启动后端、不暴露令牌。源码start/dev统一进入先锁后DB的引导入口。默认 `PORT=0`，每个活动工作区仅有一个回环HTTP端口，GUI、API、`/ws`和`/mcp`共用；stdio MCP只转发，不另开端口。`localSessions.ts` 是唯一请求身份权威；桌面审核管道仍独立，因为它签发人工reviewer会话，公开发现描述只提供maker能力。

经过鉴权的 `POST /api/v1/runtime/stop` 在同一步核查排队/运行任务、其他HTTP请求和WebSocket连接；忙时返回 `409 WORKSPACE_BUSY`。接受时返回202，退出守卫以 `503 SERVICE_STOPPING` 阻止新请求，25毫秒后协作关闭，原退出处理负责释放本实例。CLI核实健康身份、锁归属与任务后请求此接口，最多等待5秒，不按外部PID强杀。`service clean` 持有排他恢复锁，只移除所有者已退出且归属匹配的服务记录与 `before-human-desktop` 历史发现备份。活动、损坏或归属不明记录阻止清理；日志、数据库、原始素材、固定候选、审核历史及失败staging保留。

生产API **1.3** 将7个无范围审核写入别名及重复候选审核读取入口收口到候选/问题/Task范围路径。GUI与制作适配器仍使用原权限及CAS契约；不兼容服务明确拒绝连接，不强制终止。1.0.8便携包包含以上更新；旧版1.0.7/API1.1下载保留。详见[管理命令与接口迁移](api.zh-CN.md#工作区与服务管理api13)。
