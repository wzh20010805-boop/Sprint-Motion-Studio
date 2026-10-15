# FrameBaker API

当前源码与1.0.8 Windows便携包的生产API为 **1.3**；旧版1.0.7便携包使用API1.1。Base URL来自当前工作区 `.sfs/service.json` 的 `url`，格式为 `http://127.0.0.1:<动态端口>`。GUI、CLI、WebSocket和制作MCP共用该服务；不要复用历史端口或公开描述文件中的令牌。除 `/api/health` 外，请求需要当前Bearer令牌或桌面本地HttpOnly会话Cookie，Host与存在的Origin须匹配发现的服务地址。请求/响应类型见 `packages/shared/src/types.ts` 及pipeline共享契约。

下方旧 `/api` 列表描述仍保留的上游模块。常规SFS入口禁用云生成、provider测试、提示词加强、图像分层及上游宽权限MCP；这些部分为兼容代码参考，不表示该入口开放这些功能。当前制作/审核契约见后面的本地API部分及[工作区与服务管理](#工作区与服务管理api13)。

直接HTTP诊断前，先用 `sfs.cmd gui` 或业务CLI命令启动选定工作区；本机读取凭据，不把令牌复制进客户端配置：

```powershell
$ws = (.\sfs.cmd workspace current --json | ConvertFrom-Json).data.workspace
$sfsService = Get-Content (Join-Path $ws '.sfs/service.json') -Raw | ConvertFrom-Json
$sfsHeaders = @{ Authorization = "Bearer $($sfsService.token)" }
Invoke-RestMethod -Uri ($sfsService.url + '/api/v1/projects') -Headers $sfsHeaders
```

下方Bash `curl` 示例中的 `SFS_URL` 与 `SFS_TOKEN` 须在本机从同一活动描述文件读取；不打印、记录或提交凭据。


约定：

- id 为不透明字符串；常规对象用 UUID，自动保留的库素材用固定谱系摘要 ID
- 帧的 `tags` / `metadata` 在 API 输出中已解析为 JSON（DB 中为字符串）
- 错误响应：非 2xx + 纯文本中文错误信息
- 写操作触发 WS 广播（`/ws`，消息格式 `{ "type": string, "payload": any }`，type 见文末）

## 项目

### GET /api/projects

项目列表，按创建时间倒序。`has_thumbnail` 表示是否存在项目缩略图 PNG（见下文）。

```json
{
  "projects": [
    { "id": "…", "name": "走路循环", "created_at": 1785912000000, "frame_count": 8, "first_frame_id": "…", "has_thumbnail": false }
  ]
}
```

### POST /api/projects

```json
// 请求
{ "name": "走路循环" }
// 响应
{ "id": "…", "name": "走路循环" }
```

### GET /api/projects/:id

```json
{ "project": { "id": "…", "name": "…", "created_at": 1785912000000, "frame_count": 8, "has_thumbnail": false } }
```

### PUT /api/projects/:id/thumbnail

上传前端渲染好的项目缩略图。body 为 PNG 二进制（`Content-Type: image/png`，最大 2MB，校验 PNG 魔数），存到 `storage/thumbnails/projects/<id>.png`。项目不存在返回 404 → `{ "ok": true }`。

### GET /api/projects/:id/thumbnail

返回已存的 PNG（`Content-Type: image/png`，支持 ETag/Last-Modified）；项目或缩略图不存在返回 404。更新后可追加 `?v=<时间戳>` 破缓存。

### PATCH /api/projects/:id

`{ "name": "新名字" }` → `{ "ok": true }`

### DELETE /api/projects/:id

删除项目及其全部帧、任务与磁盘文件（含项目缩略图） → `{ "ok": true }`，广播 `project_deleted`。

## 帧

### GET /api/projects/:id/frames

兼容视图：仅返回默认动画轴的主轨，按规范共享步骤排序。响应包含 `track_id`、`step_id`；步骤的 `idx`/`duration` 为权威值，帧字段暂作镜像。

按 `idx` 升序返回：

```json
{
  "frames": [
    {
      "id": "…", "project_id": "…", "idx": 0,
      "raw_path": "/abs/path/storage/projects/…/raw/frame_0000.png",
      "processed_path": null,
      "status": "ready", "duration": 1, "is_keyframe": 0,
      "offset_x": 0, "offset_y": 0, "scale": 1, "rotation": 0, "opacity": 1,
      "tags": [], "source": "gif", "metadata": {}
    }
  ]
}
```

### GET /api/frames/:id/image?type=raw|processed&size=64..1024&v=VERSION

PNG 图片流。`type=processed` 且无 processed 文件时回退 raw。可选整数参数 `size` 返回宽高均不超过该值的缓存缩略图；参数非法或越界时返回原图。缩略图使用 ImageMagick 或 ffmpeg，两者均不可用时无损回退原图。响应包含 `ETag` / `Last-Modified`；带 `v` 的版本化 URL 使用一年 immutable 缓存，未带版本时执行重新验证。404：帧或文件不存在。

### PATCH /api/frames/:id

可更新字段（至少一个，全部可选）：`offset_x` / `offset_y`（-100000–100000）、`scale`（0.1–8）、`rotation`（弧度，-π–π）、`opacity`（0–1）、`duration`（int 1–600）、`is_keyframe`（0/1）及 `tags`（string[]）。攻击特效是独立时间轴单元格，使用下述专用接口，不再随图片帧 PATCH。

```json
// 请求
{ "offset_x": 12.5, "duration": 3, "is_keyframe": 1 }
// 响应
{ "frame": { /* 更新后的完整帧 */ } }
```

广播 `frame_updated`。

### POST /api/frames/:id/replace

multipart/form-data：`file`（PNG，服务端校验文件签名）。编辑器会先通过 CropModal 剪裁/编码，再写入 `processed/<id>_replaced.png`；旧 processed 文件会被清理，`source` 置为 `upload`，状态置 `ready`。响应 `{ "frame": {…} }`，广播 `frame_updated`。

### POST /api/frames/:id/duplicate?count=N

复制 N 份（1–16，默认 1）插入原帧之后，复制图片文件与全部属性，`source=duplicate`，后续帧 idx 顺延。响应 `{ "ok": true, "count": 2 }`，广播 `frames_changed`。

### DELETE /api/frames/:id

删除帧与图片文件，同项目后续帧 idx 前移。`{ "ok": true }`，广播 `frames_changed`。

## 规范合成时间轴

- `GET /api/projects/:id/timeline?axisId=`：返回项目全部动画轴，以及选中/默认轴、轨道、共享步骤、图片 `frames`、独立攻击特效 `effects`、待编排 `poolFrames` 和左侧可复用 `assetFrames`。
- `POST /api/projects/:id/axes`（`name`、可选 `fps`）；`PATCH /api/axes/:id`；`DELETE /api/axes/:id`（保护唯一轴）。
- `POST /api/axes/:id/tracks`；`PATCH|DELETE /api/tracks/:id`；`POST /api/axes/:id/tracks/reorder` 接收完整且不重复的 `trackIds`。主轨/唯一轨道不可删除。
- `POST /api/axes/:id/steps`；`PATCH|DELETE /api/steps/:id`；`POST /api/axes/:id/steps/reorder` 接收完整且不重复的 `stepIds`。时长范围 1–600，并镜像到步骤内全部单元格。
- `PATCH /api/frames/:id/placement` 请求 `{ "trackId", "stepId", "swap"?, "copy"? }`；时间轴内部移动沿用原帧，左侧组装使用 `copy: true` 创建实例，源资产始终留在左侧并可重复使用。`swap: true` 时目标已有帧会退回资产面板。
- `DELETE /api/frames/:id/placement` 清空单个时间轴单元格但不删除可复用图片文件；资产帧退回资产面板，复制出的时间轴实例则丢弃。
- `POST /api/tracks/:id/place-frames` 请求 `{ "frameIds": [...], "startStepId"? }`，把同项目帧资产依次复制到目标轨道的连续单元格。已有单元格帧退回资产面板，末尾步骤不足时原子追加；跨项目来源与非资产帧会在时间轴变更前被拒绝。
- `PUT /api/tracks/:id/steps/:stepId/effect`：在任意轨道×步骤单元格创建或替换特效，即使该格没有图片也可使用。请求最多 128 条笔画；每笔保存 `#RRGGBB` 颜色、1–256 笔宽、可选且确定性渲染的纹理 `brush`（`slash`、`bristle`、`dry`、`spark`、`echo`，缺省为 `slash`）及最多 4096 个 `{x,y,pressure}` 点，以及独立位置/缩放/旋转/透明度和可选 `style`（`flame`、`energy`、`ink`）。同 URL 的 `DELETE` 只清除特效，不影响该格的人物图片。

时间轴变更广播 `timeline_changed` 及 `projectId` 和相关 ID。删除单元格仅在步骤变空时裁剪步骤；旧复制会在源步骤后插入共享步骤；旧换序仅接受主轨“一步骤一单元格”的无歧义形态。

- `POST /api/projects/:id/undo`：恢复该项目最近一次成功的时间轴/帧编辑。服务端为每个项目最多保留 50 条快照；纯数据库编辑不会复制图片，替换、删除、复制或导入项目图片时才同时保存项目文件。同项目编辑与撤销请求会串行执行，恢复失败时回滚且不消费快照。异步任务完成及 MCP 项目写入会清除更早的历史，防止陈旧快照覆盖较新的产物。恢复成功后广播 `timeline_changed` 和 `frames_changed`；没有可撤销历史时返回 404。

### POST /api/projects/:id/reorder

```json
// 请求：必须恰好包含项目全部帧 id
{ "frameIds": ["id3", "id1", "id2"] }
// 响应
{ "ok": true }
```

按数组顺序重写 idx（事务）。400：集合不匹配。广播 `frames_reordered`。

## 导入

### POST /api/import/upload

multipart/form-data：

| 字段 | 说明 |
| --- | --- |
| `file` | 素材文件 |
| `projectId` | 目标项目 |
| `type` | `gif`（全部帧）/ `mp4`（按 fps 抽帧）/ `image`（单图一帧） |
| `fps` | 可选，mp4 抽帧帧率，默认 8（1–60） |
| `autoMatting` | 可选，`"true"` 时每帧再入队抠图任务 |

响应 `{ "jobId": "…" }`，随后轮询 `GET /api/jobs/:id` 或等 WS `job_done`。

```bash
curl -H "Authorization: Bearer $SFS_TOKEN" -F "file=@test.gif" -F "projectId=$PID" -F "type=gif" "$SFS_URL/api/import/upload"
```

### POST /api/import/generate

```json
// 请求
{ "projectId": "…", "prompt": "pixel art knight", "count": 4, "autoMatting": false, "providerId": "…", "model": "wanx2.1-image", "size": "1328*1328", "references": [{ "kind": "material", "id": "…" }, { "kind": "frame", "id": "…" }], "mediaKind": "image" }
// 响应
{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }
```

provider 解析：传了 `providerId` 按 id 找（找不到 400）；缺省用第一个配置齐备的 provider（设置页可配多个共存，类型：`cli` / `api`（OpenAI 兼容）/ `dashscope`（百炼原生）/ `gemini`（banana）/ `minimax`；列表为空时 env `FRAMEBAKER_GEN_CLI` 合成 id=`env` 的 CLI provider 兜底）。可选 `size` 在生成时覆盖 provider 的 `apiSize`（格式随 provider 类型：api 如 `1024x1024`、dashscope 如 `1328*1328`、gemini/minimax 如 `16:9`；预设档位见共享常量 `GEN_SIZE_PRESETS`；CLI provider 无尺寸概念忽略）。

- **CLI provider**：结构化字段组装 argv（`cliBin` + 参数名映射：`cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`，留空=位置参数或不下发），不经 shell。多张引用图按选择顺序重复下发 `cliReferenceArg path`。env `FRAMEBAKER_GEN_CLI` 与旧数据使用遗留模板占位符（`{prompt}` `{output}` `{index}` `{reference}` `{model}`），因此只支持一张引用图。
- **API provider（OpenAI 兼容，含 OpenAI 官方 / 火山方舟豆包 Seedream / 各类网关）**：无引用图走 `POST {apiBaseUrl}/images/generations`（JSON `{ model, prompt, size?, n: 1 }`）；有引用图走 `POST {apiBaseUrl}/images/edits`（multipart：单图使用 `image`，多图按顺序重复 `image[]`，另含 prompt/model/size；需模型支持，如 gpt-image 系列；dall-e-3 不支持 edits）。响应取 `data[0].b64_json` 或 `data[0].url` 下载。
- **DashScope provider（百炼原生）**：`POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`（wan2.7-image / qwen-image 等，不在兼容模式内）；无引用图 content 仅 `[{text}]`，每张引用图按选择顺序前置一个 `{image: dataURI}`。响应取 `output.choices[0].message.content[*].image` URL 下载（24h 有效）。`apiSize` 可为 `2K`/`1K`/`4K` 或星号格式（如 `2048*2048`）原样透传。**Base URL 归一**（`normalizeDashscopeBaseUrl`）：可填 Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com`，或文档兼容地址 `…/compatible-mode/v1` / 尾部 `/api/v1`（服务端剥掉后缀再拼原生路径）；按量付费常用 `https://dashscope.aliyuncs.com`。
- **Gemini provider（banana / nano-banana）**：`POST {apiBaseUrl}/v1beta/models/{model}:generateContent`（`x-goog-api-key` 头）；每张引用图按顺序作为 `{inlineData: {mimeType,data}}` part 放在文本 part 前；`apiSize` 映射 `imageConfig.aspectRatio`（如 `16:9`）。适配器遍历全部 candidate/part 查找 `inlineData.data`（兼容代理的 `inline_data`）；HTTP 200 却无图片时会明确报告 `promptFeedback.blockReason`、候选 `finishReason`、安全类别、模型拒绝文本及 `responseId`，仅对 `NO_IMAGE`、`IMAGE_OTHER` 或暂时性空候选自动重试一次。
- **MiniMax provider**：`POST {apiBaseUrl}/v1/image_generation`（Bearer）；引用图走 `subject_reference`（主体特征保持，限一张，base64 dataURI）；`apiSize` 映射 `aspect_ratio`（如 `16:9`）；`response_format=base64`，响应取 `data.image_base64[0]`，`base_resp.status_code` 非 0 视为失败。

模型取请求的 `model`，缺省 provider 模型列表第一项，都没有则任务 error。provider 不存在/配置不齐时任务置 `error` 并给出说明。`count` 1–16。图片模式下每个产物拆成一个独立任务，按全局队列并发数运行；`jobId` 为兼容保留并指向首个任务，`jobIds` 返回整批任务。

- **视频模式**：`mediaKind: "video"`——只生成并保存一段视频素材（`raw.mp4`，不抽帧；`count`/`fps` 忽略）。仅支持 CLI / 百炼 / MiniMax。完成后用 `POST /api/materials/:id/extract`（fps 或 timestamps）抽帧成多张图片素材。

- **CLI provider**：`{output}` 给 `.mp4` 后缀路径，产出经魔数检测为视频（ftyp/EBML/RIFF-AVI）则走 ffmpeg 抽帧。**图片模式下 CLI 产物若实为视频同样自动转拆帧**（此时 `count` 忽略）。
- **MiniMax provider**：按模型分协议——`MiniMax-Hailuo-*` / `T2V-*` 走 v1：`POST {apiBaseUrl}/v1/video_generation`（`{ model, prompt, duration? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v1/query/video_generation?task_id=`（`status`：Success/Fail 等）取 `file_id`，再 `GET {apiBaseUrl}/v1/files/retrieve?file_id=` 取 `download_url`。`MiniMax-H3` 等走 v2：`POST {apiBaseUrl}/v2/video_generation`（`{ model, content:[{type:"text",text}], duration, ratio? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v2/query/video_generation/{task_id}`（`task.status`：succeeded/failed/cancelled），成功取 `task.content.url` 下载。默认 `duration=6`；文生视频缺省 `ratio=16:9`。
- **DashScope provider（万相 / HappyHorse）**：`POST {apiBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`（头 `X-DashScope-Async: enable`）。文生视频 `happyhorse-1.1-t2v`：`input:{prompt}` + `parameters:{resolution,ratio,duration,watermark:false}`；图生视频 `*-i2v` 只能使用一个 `input.media[{type:first_frame,url}]`；参考生视频 `*-r2v` 为每张引用图按顺序下发一个 `{type:reference_image}`。→ `output.task_id`；轮询 `GET {apiBaseUrl}/api/v1/tasks/{task_id}`（`output.task_status`：PENDING/RUNNING/SUCCEEDED/FAILED），成功取 `output.video_url` 下载。旧 wanx 仍可把 `apiSize` 当 `size` 透传。

视频为异步任务（约 1–5 分钟），进度写 `job.progress` 并经 WS 推送。百炼 i2v 接受一张引用图，r2v 接受多张；MiniMax 视频会明确拒绝引用图而不是静默忽略；CLI 行为取决于所配置的参数。

引用图通过有序 `references` 数组传入（最多 10 张）：`{ "kind": "material" | "frame", "id": "…" }`，可以混合素材与项目帧。服务端逐个按 id 解析文件路径（优先 processed，否则 raw），防止客户端路径注入。旧版单图字段 `referenceMaterialId` / `referenceFrameId` 继续兼容，但不能与 `references` 同传。OpenAI 兼容、百炼、Gemini 图片协议支持多图；MiniMax 与旧版 CLI 模板超过一张时会明确拒绝。

可选 `flattenBackground` 必须是 `#RRGGBB` 色值，且仅在存在引用图时生效。调用 provider 前，服务端用 ImageMagick 把每张已解析引用图临时合成到该纯色背景，文件放入 `storage/staging/genbg_*`；不会修改源素材/项目帧，任务完成、失败或取消后都会清理暂存目录。未安装 ImageMagick 时继续使用原引用图生成，并在已完成任务中保留“未检测到 ImageMagick，已跳过垫底图”警告。

## 素材库 /api/materials

素材先在素材库生成/上传、抠图、对比，确认后再导入项目成为帧。素材的 `source` 语义与帧一致（`cli`/`api`/`dashscope`/`gemini`/`minimax`/`upload`/`gif`/`mp4`/`image`/`duplicate`；AI 生成按实际 provider 类型写入，不再一律 `cli`），`status` 为 `raw`（原图）/ `matted`（已抠图）。素材与项目均可挂 `folder_id`（见 `/api/folders`）。

### GET /api/materials

每个素材包含 `project_ids: string[]`：关联的**现存**项目 ID，去重并排序。素材库按“项目 → 视频/照片”提供虚拟分区；`kind=video` 包含视频/GIF，静态图片和抽帧结果为 `image`。归属只根据显式元数据或已有 source/frame/material ID 谱系推导，不通过文件名猜测。同一素材复用到多个项目时可同时出现在多个分区；`[]` 表示未归属项目。升级时一次性把可证实的旧归属保存到元数据，之后删除项目中的帧不会丢失归属；删除项目则从返回 ID 中移除该项目，素材库原件仍保留。自定义 `folder_id` 独立保留，分区不移动或改写素材文件。旧版 `list_materials` MCP 工具返回相同字段，桌面 MCP 白名单不变。

```json
{
  "materials": [
    {
      "id": "…", "name": "slime #1", "status": "matted", "source": "cli", "project_ids": [],
      "raw_path": "/abs/storage/materials/…/raw.png",
      "processed_path": "/abs/storage/materials/…/processed.png",
      "metadata": { "prompt": "pixel slime" }, "created_at": 1785912000000
    }
  ]
}
```

### PATCH /api/materials/:id

重命名单个图片或视频素材。请求 `{ "name": "新素材名称" }`（自动去除首尾空格，长度 1–200）→ `{ "material": {…} }`。素材不存在时返回 404；成功后广播 `material_updated`。

### GET /api/materials/:id/image?type=raw|processed&size=64..1024&v=VERSION

素材图片/视频流。`type=processed` 且无 processed 时回退 raw。图片素材可通过可选整数参数 `size` 获取宽高均不超过该值的缓存缩略图；参数非法或越界时返回原图。缩略图使用 ImageMagick 或 ffmpeg，两者均不可用时无损回退原图。响应包含 `ETag` / `Last-Modified`；带 `v` 的版本化 URL 使用一年 immutable 缓存，未带版本时执行重新验证。视频响应忽略 `size`。

### POST /api/materials/upload

multipart/form-data：`file` + 可选 `processedFile`、`metadata`（JSON 对象字符串；也兼容 Elysia multipart 自动解析后的对象）、`autoMatting`(`"true"`)、`fps`（视频抽帧，默认 8）。传 `processedFile` 时素材同时保存 raw/processed 两个槽位并标记 `status=matted`；网格拆分用它保留真实前后对比。

可选 `projectId` 把上传内容归入该项目的素材分区，不向项目时间轴追加帧；写入文件或任务前校验项目存在（不存在返回 404）。此归属同时传给原视频和抽帧照片，与 `folderId` 相互独立。素材成功复用到项目后追加该项目归属，保留原归属，并广播 `materials_changed`。

项目归属也包含骨骼项目绑定附件引用的素材。成功保存合法骨骼文档时持久化这些归属并广播 `materials_changed`，以后解除附件绑定仍保留素材的项目分区；文档校验失败不会新增归属。
PNG/JPG 等单图 → 直接生成 1 个素材，响应 `{ "materialId": "…" }；GIF/MP4 → 队列拆帧每帧一个素材，响应 `{ "jobId": "…" }`。

```bash
curl -H "Authorization: Bearer $SFS_TOKEN" -F "file=@slime.png" "$SFS_URL/api/materials/upload"
```

### POST /api/materials/generate

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "references": [{ "kind": "material", "id": "…" }], "flattenBackground": "#FF00FF" }` → `{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }`（provider 解析、图片独立任务、多引用图及临时 `flattenBackground` 处理规则同 `/api/import/generate`）。每个素材任务完成时都会广播 `materials_changed`，停留在素材库时会逐个刷新。可选 `name`：素材命名基准（缺省取 prompt 前 24 字符），产出命名为 `name #i`（count>1）——素材详情「多动作生成」按「素材名_动作」传入。支持 `mediaKind: "video"`：只生成并保存视频素材（`kind=video`），**不抽帧**；完成后用下方 extract 接口拆帧。骨骼分件生成支持成对提供 1–8 的 `gridRows` / `gridCols`，生成素材 metadata 和网格切分编辑器都会保留该布局；人形默认值为 `gridRows: 3`、`gridCols: 4`（12 个部件）。`skeletal-character` 两阶段请求可把相同字段放入 `followUp`，用于后续分件表。骨骼请求不再要求预先创建或传入 `characterPartSetId`：缺省时服务端自动建立内部部件集，并随 `jobId` 返回其 ID；显式 ID 仍为 API 兼容保留。

### POST /api/materials/:id/extract

视频/GIF 素材抽帧成多张图片素材 → `{ "jobId": "…" }`。复制源文件到 staging 后入队**一个** `extract_frames` 任务；产出命名为「原名 #i」，默认落在同一文件夹。非视频/GIF 返回 400。

- **整段按 fps**（默认，GIF/视频）：`{ "fps"?: 8, "autoMatting"?: false, "folderId"?: null }`
- **定点抽帧**（仅视频）：`{ "timestamps": [0.12, 0.5, 1.0], "autoMatting"?: false, "folderId"?: null }` —— 秒（浮点），排序去重，最多 64 个；GIF 传 timestamps 返回 400。服务端对每个时间点跑一次 `ffmpeg -ss T -i … -frames:v 1`（可取消）。

### POST /api/materials/:id/matting

入队抠图任务（`matting` job，队列并发 2），响应 `{ "jobId": "…" }`；素材不存在 404，缺 raw 文件 400。**同一素材已有 queued/running 抠图任务时 409**（禁止重复入队）。引擎解析顺序见 `GET /api/config`——自定义 CLI → 内置 rembg → PATH rembg → passthrough 复制（passthrough 警告写入 `job.progress`）。完成后 `status` 置 `matted` 并广播 `material_updated`；rembg 模型首次使用需下载（可达数百 MB），进度经 WS `job_*` 事件推送。

### POST /api/materials/batch-matting

`{ "ids": ["…", "…"] }` → `{ "ok": true, "count": 2, "skipped": 1 }`。仅对 `status=raw` 的素材入队抠图；已抠图或**已有进行中抠图任务**计入 `skipped`（详情页单条仍可重新抠，但进行中会 409）。

### POST /api/materials/:id/replace-image

multipart/form-data：`file`（PNG）+ `slot`（`"raw"` | `"processed"`）。剪裁工具的落盘端点：覆盖对应槽位文件；`slot=processed` 且尚无 processed 时建立之并置 `status=matted`，`slot=raw` 不影响已有 processed。响应 `{ "material": {…} }`，广播 `material_updated`。

### POST /api/materials/:id/unmatting

删除 processed、还原为 `raw` 状态。响应 `{ "material": {…} }`。

### POST /api/materials/:id/import

```json
// 请求
{ "projectId": "…", "count": 2 }
// 响应
{ "ok": true, "count": 2, "frameIds": ["…", "…"] }
```

把素材复制为待编排项目帧并放入左侧帧池。素材存在有效抠图结果时，导入帧的全部图片槽位都使用抠图图，避免后续操作静默退回原图；否则使用原图。素材库仍保留原图，仅用于明确的原图对比、还原抠图、重新抠图及原图导出。只有完成 placement 后才进入时间轴。`source` 与 metadata 均保留。`count` 1–16，默认 1。广播 `frames_changed`。

### POST /api/materials/batch-delete

`{ "ids": ["…", "…"] }` → `{ "ok": true, "deleted": 2 }`（连同磁盘文件），广播 `materials_changed`。

### POST /api/materials/batch-import

`{ "ids": ["…", "…"], "projectId": "…" }` → `{ "ok": true, "count": 2 }`。按给定顺序各导入 1 帧。

## 任务

### GET /api/jobs

→ `{ "jobs": [ {…}, … ] }`，按创建时间倒序取最近 50 条（前端任务面板初始加载用，之后以 WS 事件为主）。

### GET /api/jobs/:id

```json
{
  "job": {
    "id": "…", "project_id": "…", "type": "extract_frames",
    "status": "done", "progress": "完成", "error": null, "created_at": 1785912000000
  }
}
```

`status`：`queued` / `running` / `done` / `error` / `cancelled`。任务负载在内存中，服务重启时会把遗留的 `queued` / `running` 任务标记为 `error`（「服务重启，任务中断」）。

### POST /api/jobs/:id/cancel

取消排队中或运行中的任务 → `{ "ok": true }`。`queued` 直接出队标 `cancelled`；`running` 触发 AbortSignal（杀掉 `runCmd` 子进程 / 打断 API 轮询）。已结束状态返回 409。广播 `job_cancelled`。

## 文件夹 /api/folders

素材库与项目列表共用多级文件夹（`kind`: `material` | `project`）。资源通过 `folder_id` 归属；删除文件夹时内容上移到父级（不删资源）。

### GET /api/folders?kind=material|project

→ `{ "folders": [ { id, kind, parent_id, name, sort, created_at }, … ] }`（扁平列表，前端组树）。

### POST /api/folders

`{ "kind": "material", "name": "角色", "parentId": null }` → `{ "folder": {…} }`，广播 `folders_changed`。

### PATCH /api/folders/:id

`{ "name"?, "parentId"? }`（禁止移到自身或子孙下）。

### DELETE /api/folders/:id

子树内资源上移到父级后删除整棵文件夹子树。

### POST /api/folders/move-items

`{ "kind": "material", "ids": ["…"], "folderId": null }` → `{ "ok": true, "moved": n }`（`folderId: null` = 未分组）。

## WebSocket /ws

服务端 → 客户端单向广播，JSON：

```json
{ "type": "frame_updated", "payload": { "id": "…", "projectId": "…" } }
```

| type | 时机 |
| --- | --- |
| `job_queued` / `job_running` / `job_progress` / `job_done` / `job_error` / `job_cancelled` | 任务生命周期 |
| `frame_updated` | PATCH / 替换 / 帧抠图完成 |
| `frames_changed` | 导入完成 / 复制 / 删除 / 素材导入项目 |
| `frames_reordered` | 换序 |
| `project_deleted` | 删除项目 |
| `material_updated` | 素材重命名 / 抠图完成 / 还原原图 / 剪裁替换图片 |
| `materials_changed` | 素材上传 / 生成 / 批量删除 / 移动文件夹 |
| `folders_changed` | 文件夹增删改 / 移动 |
| `settings_changed` | 设置写入（layout / theme / lang / genProvider / matting） |

前端建议：收到 `frame_updated` / `frames_reordered` / `frames_changed` / `job_done` 后重拉帧列表，收到 `material_updated` / `materials_changed` 后重拉素材列表；断线 3s 重连。

## 界面偏好 /api/settings

布局（编辑器面板尺寸）、主题模式、界面语言、生成 provider、抠图配置等持久化在服务端 `settings` 表（SQLite），换浏览器/重启不丢；主题与语言前端以 localStorage 为首屏即时缓存，服务端不可达时静默降级。

### GET /api/settings

返回整个 kv 对象（value 已 JSON 解析）：

```json
{
  "layout": { "sidebarW": 260, "timelineH": 160 },
  "theme": "dark",
  "lang": "zh",
  "genProviders": [
    {
      "id": "…", "name": "OpenAI", "type": "api",
      "cliTemplate": "", "apiBaseUrl": "https://api.openai.com/v1", "apiKey": "sk-…",
      "apiModels": ["gpt-image-1"], "apiSize": "1024x1024"
    },
    { "id": "…", "name": "本地 mygen", "type": "cli", "cliTemplate": "mygen --prompt \"{prompt}\" -o {output}", "apiBaseUrl": "", "apiKey": "", "apiModels": [], "apiSize": "" }
  ],
  "matting": { "cliTemplate": "", "model": "u2net" }
}
```

### PUT /api/settings/:key

```json
// 请求（key 白名单：layout、theme、lang、genProviders、matting、imageLayers、promptEnhancers；其他 key 返回 400）
{ "value": { "sidebarW": 260, "timelineH": 160 } }
// 响应
{ "ok": true }
```

`theme` 的合法值：`"system"`（跟随系统）/ `"light"` / `"dark"`。`lang` 的合法值：`"zh"` / `"en"`。写入后广播 `settings_changed` `{ key }`。

`genProviders`：生成 provider 列表。连接凭证只存一次（`apiBaseUrl` / `apiKey`），能力按 `imageModels` / `videoModels` / `textModels` 分类，图片与视频默认尺寸分别为 `imageSize` / `videoSize`。服务端仍读取旧 `apiModels` / `apiSize`：旧模型按名称迁移到图片或视频能力，旧尺寸同时作为两类尺寸 fallback；设置页只写新字段。CLI 继续使用 `cliBin`、各参数名与 `cliExtraArgs` 的结构化 argv，不经 shell；列表为空时 env `FRAMEBAKER_GEN_CLI` 兜底。

`promptEnhancers` 元素为 `{ id, name, providerId, model }`，复用 `api` 或 `dashscope` provider 的连接凭证；旧 `{ apiBaseUrl, apiKey, apiModel }` 仍可读取运行。`POST /api/enhance-prompt` 可传 `mediaKind: "image" | "video"` 与 `referenceImageCount`（0–10），服务端据此选择文生、单引用图或有序多引用图的提示词语义。

`matting`：结构化抠图命令 `cliBin` / `cliInputArg` / `cliOutputArg` / `cliModelArg`（均留空走 env `FRAMEBAKER_MATTING_CLI` 模板 → 自动探测）；`model` 留空回退 `FRAMEBAKER_MATTING_MODEL` / 默认 `u2net`。

`imageLayers`：独立的图片分层服务配置 `{ "apiBaseUrl", "apiKey", "model" }`，不再归属生成 Provider，执行时调用 `POST {apiBaseUrl}/images/layers`。若该设置从未保存，服务端会临时读取首个旧 `genProviders[].layerModels` 配置以兼容迁移。

### POST /api/materials/:id/layers

创建语义场景分层任务，把扁平图重建为背景、完整主体、道具和前景等可编辑 RGBA 层；不承诺人物肢体拆件，也不是严格的像素标签分割。素材必须为图片（优先 processed，再回退 raw），且独立的 `imageLayers` 设置必须填写 Base URL、API Key 和模型。异步任务类型为 `image_layers`。完整场景通常应传 `autoMatting: false` 保留上下文；继续细分已独立前景且素材没有处理图时，才可传 `autoMatting: true`，在同一任务内先抠图再调用分层服务。抠图失败或取消时不会发送分层请求。

```json
{ "layers": 4, "numInferenceSteps": 50, "trueCfgScale": 4, "negativePrompt": "", "seed": 0, "autoMatting": false }
```

范围：`layers` 1–4（当前 Gitee Qwen-Image-Layered 端点会拒绝大于 4 的值）、`numInferenceSteps` 1–100（UI/MCP 默认 `50`，与上游质量配置一致）、`trueCfgScale` 0–20（默认 `4`）、整数 `seed >= 0`。返回 `{ "jobId": "…" }`；结果图层作为 raw 素材写入原素材文件夹。如需继续细分，可对某个输出图层再次递归分层。

## 动画资产 /api/animation-assets

- `GET /api/animation-assets?kind=...` 列出 Skeleton 与 MotionClip 动作资产。CharacterBinding 只属于项目，不会由该资产库暴露。
- `POST /api/animation-assets` 以 `{ asset, folderId? }` 创建资产；`GET`、`PUT`、`DELETE /api/animation-assets/:id` 分别读取、整体替换和删除单项 Skeleton 或 MotionClip。提交 CharacterBinding 会被拒绝。
- `GET /api/projects/:id/skeletal-document` 读取骨骼项目文档，`PUT` 整体替换。项目文档拥有角色 CharacterBinding 和素材引用；项目动作只能引用 `skeletonId` 完全相同的 MotionClip。
- MotionClip `schemaVersion: 1` 保持轨道级 `step | linear`。MotionClip `schemaVersion: 2` 不再含轨道级 interpolation，每个 key 必须携带 `outInterpolation`：非末尾 key 使用 `{ type: "step" | "linear" }` 或 `{ type: "cubic-bezier", x1, y1, x2, y2 }`，末尾 key 固定为 `null`。贝塞尔控制量必须是 `[0, 1]` 内的有限数值。
- 读取或保存 v1 不会自动升级；只有用户明确选择曲线时编辑器才升级到 v2。`.fbanim` 包版本与包内 MotionClip schema 版本独立演进。

## 其他

- `GET /api/health` → `{ "ok": true, "name": "FrameBaker" }`
- `GET /api/config` → 服务端能力探测（每次请求实时解析，设置页改动即时生效）：

```json
{
  "matting": {
    "engine": "rembg-bundled",
    "model": "u2net",
    "hint": null,
    "modelCached": true
  },
  "imageLayers": {
    "configured": true,
    "model": "Qwen-Image-Layered"
  },
  "gen": {
    "providers": [
      { "id": "…", "name": "OpenAI", "type": "api", "models": ["gpt-image-1"], "configured": true }
    ]
  }
}
```

  `engine`：`custom-cli`（设置页 matting.cliTemplate 或 `FRAMEBAKER_MATTING_CLI`）/ `rembg-bundled`（`.venv-matting` 内置）/ `rembg-path`（PATH 中找到）/ `none`（未安装，抠图仅复制原图，`hint` 为安装提示）。`model` 为 rembg 模型名（设置页 matting.model → `FRAMEBAKER_MATTING_MODEL` → 默认 `u2net`），`modelCached` 表示模型文件已在 `storage/models`（未缓存首次抠图自动下载）。`imageLayers` 只返回独立图片分层服务的可用状态，不暴露 API Key。`gen.providers` 为全部生成 provider 的摘要（不含 apiKey；模型能力列表供生成弹窗使用，`configured` 表示关键字段齐备，`video` 表示支持视频生成——仅 cli/dashscope/minimax，映射见共享常量 `PROVIDER_VIDEO_SUPPORT`）。
- `GET /api/doctor` → 体检：逐项检查存储目录可写 / ffmpeg / 抠图引擎与模型缓存 / 独立图片分层服务 / 每个生成 provider（CLI 校验命令存在；OpenAI 兼容实发 `GET /models`、Gemini 实发 `GET /v1beta/models`、百炼实发 `GET /compatible-mode/v1/models` 联通测试；MiniMax 无探测端点仅校验字段）→ `{ "checks": [{ "id", "ok", "label", "detail" }] }`。
- `POST /api/provider/test` → API provider 联通测试（用表单当前值，不要求已保存）：`{ "type"?, "apiBaseUrl", "apiKey", "apiModel?" }`；api 实发 `GET {baseUrl}/models` + Bearer、gemini 实发 `GET {baseUrl}/v1beta/models`（x-goog-api-key）、dashscope 实发 `GET {baseUrl}/compatible-mode/v1/models` + Bearer，返回 `{ "ok", "status", "latencyMs", "modelsFound" }`（401/403 判定为认证失败）；minimax 无轻量探测端点，仅校验字段并在 `note` 说明。
- `POST /api/provider/models` → API provider 模型列表（设置页「获取模型」，用表单当前值拉取，不要求已保存）：`{ "type", "apiBaseUrl", "apiKey" }` → `{ "ok", "models": ["…"] }`；端点与联通测试同源（api `/models`、dashscope `/compatible-mode/v1/models`、gemini `/v1beta/models` 去 `models/` 前缀；minimax 为 best-effort 试 `/v1/models`），失败返回 `{ "ok": false, "error" }`，前端保持手填。
- `POST /api/enhance-prompt` → 提示词加强（设置页配置的加强模型，OpenAI 兼容 `chat/completions`，系统模板内置于服务端）：`{ "enhancerId"?, "prompt", "style"?, "mediaKind"?, "referenceImageCount"? }` → `{ "enhanced", "enhancerName" }`。`style` 选择像素/动漫/插画/3D/写实/不限风格的规则与示例；`mediaKind` 区分图片和视频；`referenceImageCount`（0–10）区分文生、单引用图和按 Image 1…N 排序的多引用图语义。前端传入当前选择，选择变化时清除旧对比；聊天回答或澄清问题会自动纠正一次，仍无效则明确报错。
- `GET /fonts/:name` → `apps/web/public/fonts/` 下的字体文件（woff2 / OFL.txt）
- `GET /imageops/imageOps.worker.js` → 前端剪裁 worker 脚本（服务端按需 `Bun.build` 打包 `apps/web/src/imageops/imageOps.worker.ts` 下发；开发模式每次重建，生产缓存）

## MCP（Model Context Protocol）端点

当前 `/mcp` 为鉴权制作白名单，实际能力见生产1.3门面；无令牌上游服务的宽工具列表只作历史代码参考。

### 传输

基于 `@modelcontextprotocol/server` SDK v2 的 Streamable HTTP 传输，自动兼容 2025-era（`initialize` 握手）和 2026-07-28（无状态核心）协议版本。

- `POST /mcp`：接收 JSON-RPC 请求，返回 JSON 响应
- `GET /mcp`：SSE 通道（服务端→客户端通知）
- `DELETE /mcp`：结束会话

SDK负责协议协商；当前制作适配器仍校验原始鉴权Request，并调用共用服务契约。

### 客户端配置

在仓库中使用源码CLI的stdio桥：

```powershell
.\sfs.cmd mcp --stdio --workspace "D:\素材工作区"
```

支持启动可执行程序的MCP客户端可使用以下配置；先将Bun、源码和工作区路径替换为本机实际绝对路径：

```json
{
  "mcpServers": {
    "sprite-motion-studio": {
      "command": "C:\\path\\to\\bun.exe",
      "args": ["D:\\projects\\Sprint-Motion-Studio\\apps\\cli\\src\\index.ts", "mcp", "--stdio", "--workspace", "D:\\assets\\workspace"]
    }
  }
}
```

桥接器从工作区发现服务并鉴权，保持健康租约，只公开制作白名单。先调用 `inspect_capabilities` 读取实际工具列表和限额；stdio桥不另开TCP端口、不授予人工批准。直接HTTP `/mcp` 需要活动实例的发现地址与制作凭据，固定且未鉴权的URL不是当前有效配置。

### 握手（2025-era 客户端）

```json
// 请求
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "my-client", "version": "1.0" } } }
// 响应
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} }, "serverInfo": { "name": "framebaker", "version": "1.0.8" } } }
```

握手后发送 `notifications/initialized` 通知（无需响应），随后可 `tools/list` 和 `tools/call`。2026-07-28 客户端无需握手，直接调用即可。

### 上游宽工具列表（历史参考，常规入口禁用）

| 工具 | 说明 |
| --- | --- |
| `list_projects` | 列出全部项目 |
| `get_project` | 获取单个项目详情 |
| `create_project` | 创建项目 |
| `update_project` | 更新项目名/文件夹 |
| `delete_project` | 删除项目及其帧/任务/文件 |
| `list_frames` | 列出项目全部帧 |
| `update_frame` | 更新帧图片属性/变换 |
| `delete_frame` | 删除帧 |
| `clear_frame_cell` | 清空时间轴单元格但不删除可复用资产文件 |
| `get_timeline` | 获取轨道、步骤、图片单元格和独立特效单元格 |
| `upsert_attack_effect` | 在任意轨道×步骤单元格创建或替换攻击特效 |
| `duplicate_frame` | 复制帧 1–16 份 |
| `reorder_frames` | 重排帧顺序 |
| `generate_frames` | 为项目生成帧（AI provider） |
| `generate_materials` | 生成素材（AI provider） |
| `list_materials` | 列出全部素材 |
| `rename_material` | 重命名单个图片或视频素材 |
| `matting_material` | 单素材抠图 |
| `split_material_layers` | 使用独立图片分层服务拆分素材图层 |
| `batch_matting` | 批量抠图 |
| `extract_material_frames` | 视频/GIF 素材抽帧 |
| `import_material_to_project` | 素材导入为项目帧 |
| `batch_import_materials` | 批量素材导入项目 |
| `batch_delete_materials` | 批量删除素材 |
| `unmatting_material` | 还原图（删除抠图结果） |
| `list_folders` | 列出文件夹 |
| `create_folder` | 创建文件夹 |
| `update_folder` | 更新文件夹 |
| `delete_folder` | 删除文件夹（内容上移） |
| `move_items_to_folder` | 移动素材/项目到文件夹 |
| `list_jobs` | 列出最近任务 |
| `get_job` | 查询单个任务状态 |
| `cancel_job` | 取消任务 |
| `get_config` | 获取服务端配置（provider/抠图引擎） |
| `run_doctor` | 体检 |
| `get_settings` | 获取全部设置 |
| `update_setting` | 更新单个设置项 |
| `enhance_prompt` | 提示词加强 |

### 上游调用示例（历史参考）

```json
// 列出项目
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_projects", "arguments": {} } }

// 创建项目
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "create_project", "arguments": { "name": "走路循环" } } }

// 生成帧
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "generate_frames", "arguments": { "projectId": "…", "prompt": "pixel art knight walk cycle", "count": 4 } } }

// 查询任务状态
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "get_job", "arguments": { "jobId": "…" } } }
```

工具返回 `content: [{ type: "text", text: "…" }]` 格式（text 为 JSON 字符串）；错误时 `isError: true`。
# 小兵工坊 P1 本地 API 补充

通过 `sfs.cmd` 启动的隔离服务复用上游业务数据库，只监听 `127.0.0.1`。除 `/api/health` 外，API / WebSocket 需要 Bearer token 或本地 HttpOnly cookie；Host 必须匹配服务，存在 Origin 时必须匹配同源。令牌从工作区 `.sfs/service.json` 读取，不能提交或打印。

| 路由 | 输入 | 结果 |
|---|---|---|
| POST `/api/v1/projects` | JSON `name` | `data.project`、`project_id` |
| GET `/api/v1/projects/:id` | ID | `data.project/sources/clips` 和修订号 |
| POST `/api/v1/sources/import` | multipart `projectId/file` | 不可变视频、SHA256、完整探测，`data.source_id` |
| POST `/api/v1/clips` | JSON `project_id/source_id/name` | 复用动画轴和主轨，`data.clip_id` |
| POST `/api/v1/extract` | JSON `project_id/clip_id/mode:"all"/base_revision?` | accepted，真实 `job_id` |
| GET `/api/v1/jobs/:id` | ID | 持久任务参数/状态/结果/异常 |
| POST `/api/v1/jobs/:id/cancel` | ID | 取消当前任务自己的操作 |

统一响应含 `schema_version:"1.0"`、`ok`、`status`、`project_id`、`requires_user_action`、`data`、`artifacts`、`warnings`、`error`，任务操作另含 `job_id`。旧 done/error 对外映射 succeeded/failed；重启遗留任务为 interrupted。CLI `job status` 成功查询可退出0并返回失败状态，`job wait` 则反映终态退出码，详见 [README_SFS.md](../README_SFS.md)。

上游 `/api/import/upload` 的 MP4 默认转入同一完整源帧服务；仅明确 `mode=fps` 使用旧采样。源 PNG 为完整未抠图画面，不得把抽帧成功称为透明处理成功。精确时序独立于上游整数 tick，预览量化会报告 `PREVIEW_TIMING_QUANTIZED`。源帧采用 `frame_000000.png` 零起始索引；未来游戏动作导出命名属 P4。

隔离入口禁用生成/provider/云体检/宽权限 MCP。桌面视频/GIF 的项目导入和素材库上传均采用完整抽帧；`/api/config` 当前返回 `sfs.phase=P2`。上传自动抠图返回409/USE_P2_MATTE，应导入项目后使用P2遮罩接口。薄 MCP 属 P4。

### 桌面素材库自动保留（2026-10-11）

- `POST /api/import/upload`：图片任务完成时同时生成独立库副本；视频/GIF 原件导入时保留到素材库，完整抽帧提交时把每个源帧登记入库。桌面入口忽略旧 `mode=fps`，统一保留全部原始帧。
- `POST /api/materials/upload`：图片返回 `{materialId}`；视频/GIF 返回 `{materialId,jobId,mode:"all"}`。保留原视频，并把全部显示帧及精确有理数时序保留到库中；`folderId` 同时作用于原件及帧。视频验证失败返回400，缺少依赖返回503；失败文件仍保留。
- `POST /api/materials/:id/extract`：桌面请求 `{}` 即完整抽帧，返回 `{jobId,mode:"all"}`；已有同源帧复用固定ID，不重复登记。旧 `fps` 不参与采样，非空 `timestamps` 返回409，`autoMatting:true` 返回409/USE_P2_MATTE。
- `GET /api/materials`：包含视频/GIF 原件（`kind=video`）及可复用PNG。`metadata.source_id/source_frame_id/source_index/timing` 保留完整源谱系。项目帧选择器只展示图片，原视频在素材库预览/抽帧。
- `POST /api/materials/batch-import`：沿用 `ids/projectId/target`；复制到目标项目，编辑或删除项目不改变库中原文件。未提供 `target` 时进入帧池，提供轴/轨道时进入时间轴。
- 服务首次升级启动时一次性补登记已有的P1源视频/完整帧及旧项目图片；库文件均保存到 `STORAGE_ROOT/materials`。补登记标记防止用户主动删除素材后再次自动添加。保留的是导入原素材；项目后续P2修正不会自动覆盖库原件。

桌面上传界面关闭自动抠图、FPS采样及云生成入口。上游非隔离模式的采样接口继续兼容，以下旧接口示例不代表桌面开放能力。
# SFS P2 本地遮罩接口

2026-10-10修正：`region` 是保留区域，框外透明。区域几乎全是纯背景返回 `REGION_NO_FOREGROUND`，自动结果为空/仅弱透明噪声返回 `MATTE_NO_FOREGROUND`（HTTP 422 / 队列任务failed），不会提交整批遮罩或覆盖旧头版本；中间文件保留。帧报告新增 `method: edge_color|rembg|brush|existing`、`visible_fraction`，以alpha>128的前景检测 `LOW_CONFIDENCE`。空/弱遮罩不能通过review。边缘近纯色用与外边连通的背景色法，其他场景使用本地模型，不删除分离装备。

受鉴权的隔离桌面服务支持 `POST /api/v1/matte`：`project_id`、`frame_ids`、可选 `region: [x,y,width,height]` 与 `base_revision`。共享队列初稿完成后返回 `waiting_user`、`requires_user_action: true`、模型登记、异常帧和本地预览/遮罩/RGBA路径。同批使用一个CPU Rembg session，Worker不隐式下载模型。

纯色背景批次和仅缓存命中的批次现在返回 `session_count: 0`，仅有帧需要模型推理时才初始化并复用一个 Rembg session。四邻域背景连通标记使用现有 scipy 依赖；连通的近背景色压缩噪声全部透明，避免形成半透明灰雾，内部浅色细节仍由连通性保护。抠图缓存算法 v3 不复用此前产生灰雾的旧输出。

`POST /api/v1/matte` 增加可选 `background_points: {"帧ID": [[x,y], ...]}`，最多2000个所选帧，每帧128个完整源图整数像素坐标。背景点额外选中近背景色连通区，可清除腿间封闭空隙，同时保留未标记的浅色衣服。帧须属于本批，点须位于保留ROI内；落在深色前景、越界或复杂背景上明确失败。CLI使用 `matte --background-points points.json`；共享recipe的 `matting.background_points` 同步提供给maker MCP的 `submit_pipeline`。缓存v5包含逐帧背景点与当前背景边缘算法，保留原件和旧遮罩版本，不记录人工批准。

`GET /api/v1/masks/:frameId` 返回当前遮罩、项目修订与不可变历史。`GET .../image?kind=raw|mask|rgba|preview&version=...` 仅提供已登记路径。`POST .../strokes` 接收 `version_id`、`revision` 和 `strokes: [{mode: "erase"|"restore", size, points:[[x,y],...]}]`。`POST .../undo`、`POST .../review` 需要同样的版本/修订对。所有坐标和笔刷直径使用完整原图，不删除分离连通块。`GET /api/v1/projects/:id/masks` 供重开后读取审核/异常状态。参数错误400、版本冲突409、依赖/模型缺失503。GUI与CLI共用，正式导出与MCP仍属于后续阶段。见 [P2说明](p2-guide.md)。
遮罩确认将审核标记、项目修订和相关抠图任务状态放在同一事务提交。历史批次引用已删除或已移出项目的帧时标记为 `cancelled`、`requires_user_action: false`，保留任务参数、结果和文件；不会阻塞现存帧确认，也不会冒充审核通过。帧完整的批次仍需全部帧的当前遮罩有效且已确认，才能标记 `done`。提交后才发送任务事件；事务失败时审核和修订一起回滚。

## SFS P3–P5 正式管线接口（2026-10-11）

所有接口通过同一鉴权本地服务，JSON沿用v1信封；主轨按动画步索引排序。详见[使用与调用说明](p3-p5-guide.md)。

| 接口 | 契约 |
| --- | --- |
| POST `/api/v1/images/import` | multipart projectId、files、name；1–2000张PNG，保留原件Alpha、自然文件名排序、需人工确认 |
| GET/POST `/api/v1/alignment` | 查询/保存 project_id、axis_id、config；保存要求base_revision |
| POST `/api/v1/alignment/check` | 全动作空帧/越界检查，与正式合成同Worker |
| GET `/api/v1/preview/:id?axis_id=...` | 公共画布RGBA PNG；输入与输出摘要校验缓存 |
| POST `/api/v1/review/apply` | 当前base_revision、用户明确confirmation和source；每帧遮罩必须先确认 |
| POST `/api/v1/collaboration/candidates/:id/reviews/whole` | 仅当前桌面审核人；`{context,patch:{content_hash,playback_hash,confirmed:true}}`。用户明确确认已检查全部最终帧及整体播放后，在一个审核事务中登记整段并触发原交付流程；版本或审核修订冲突、未提交/未选定候选、未解决阻断问题及需修复帧均拒绝。无CLI或maker MCP批准工具。 |
| POST `/api/v1/export` | draft、base_revision、max_texture、gap、margin、timing可选；返回持久任务 |
| POST `/api/v1/pipeline` | recipe schema1.0、可选clip_id；提交下一未完成阶段，不自动审核 |
| POST `/api/v1/jobs/:id/resume` | 中断/失败/取消任务以当前输入创建新任务 |
| GET `/api/v1/exports/:id/file?path=...` | 白名单ZIP、清单、报告、校验和、Cocos说明、序列/图集PNG、联系表和MP4 |

正式导出必须与审核修订及原图/遮罩/前景/参数摘要一致。发布前再次核验，导出到新目录而非覆盖旧成功版本；原文件失效报INPUT_NOT_FOUND，修订冲突报REVISION_CONFLICT/STALE_JOB_RESULT。草稿明确标记；不去重、不逐帧裁边、不旋转，Alpha与有理数时长保持一致。

鉴权模式 `/mcp` 公开下文生产1.3制作白名单，不提供人工批准工具。SDK HTTP与CLI stdio桥共用业务校验；原上游广工具仅在无令牌开发模式可用。import_source不读取服务器任意路径，接收有上限的明确提供字节。stdio客户端健康租约防止空闲停服。

历史1.0.1渲染修复：当时 `/api/config.sfs.production_api_version` 升至1.1；当前源码握手使用1.3。manifest每帧新增transform（offset_x、offset_y、正负scale、弧度rotation、opacity），先围绕完整源图中心处理，再执行地面基准对齐；预览/越界/审核/导出共用。更改帧属性使旧审核与缓存失效。图集不自动旋转格子，用户设置的帧旋转会实际烘焙到像素。

导入/人工修正PNG的Alpha可以全为半透明；遮罩详情和项目摘要统一纠正旧导入记录的LOW_CONFIDENCE提示，不改像素或审核状态。真正空RGBA与自动抠图低置信遮罩仍被阻止。JSON schema/envelope版本保留1.0，旧manifest读取方可以忽略新增的变换来源字段。

首页装饰资源：固定同源 GET `/illustrations/creative-candy.png`，PNG响应，不接受动态文件名；工作区令牌模式沿用本地鉴权。开发版从web/public/art读取，便携版从runtime/assets/art读取。

### 本机会话角色与生产 API 1.3

实例会话、桌面管道及受保护的 `.sfs/desktop-bootstrap.json` 全部就绪后才发布 `.sfs/service.json`。其中 token 仅有制作能力；旧 `sfs_token` Cookie 仍为制作身份。当前实例有效的 `sfs_reviewer` Cookie 优先，并同时允许 GUI 手工制作；失效 Cookie 不提升制作凭据。Cookie 使用 HttpOnly、Strict、host-only 与 `/`。Host、Origin、WebSocket 约束保持，health 只提供实例/PID身份。客户端精确匹配 API `1.3`，不强杀不兼容服务。

不提供制作凭据升级的 HTTP 端点。可信桌面主进程核对描述和活跃服务身份，通过本机管道交换绑定 PID、30秒有效、只能消费一次的 nonce，加载页面前设置审核 Cookie。后续协作审核 adapter 必须使用 `getRequestActor(request)` 及 `requireRole(actor,'reviewer')`；请求 body/header 中的 actor 声明不可信。本基础任务不替换现有手工审核/导出业务。

### 协作制作草稿（API1.2历史基础，当前运行API1.3）

`/api/v1/collaboration` 薄适配器使用服务绑定的本地制作/审核身份；请求体角色字段不能授权。`POST /tasks` 接收 `{brief,request_key}`。`GET /draft?project_id=...&axis_id=...` 返回实际字节内容身份、独立期望源选择及有理数输出时长；未配置对齐时明确返回 `alignment:null`，固定候选必须拒绝缺少对齐。`POST /timing` 接收 `{context,timing,base_content,request_key}`；timing 带字段来源，策略为 source_pts/confirmed_fps/explicit_durations，源PTS元数据保持原样。

`POST /images` multipart字段：project_id、axis_id、PNG files，以及JSON options（request_key、可选ordered_names、timing、base_content）。JSON文本（含前导空白）与Elysia解析后的对象共用严格的maker导入选项schema；拒绝无效JSON、非对象和未知选项字段。CLI显式发送平面文件名。名称须为唯一平面NFC PNG文件名；显式清单必须恰好覆盖全部输入，无清单使用自然排序。占用动作拒绝隐式追加或替换。PNG源提供png_sequence类型探测清单和独立原帧映射，没有视频PTS；视频抽帧入口拒绝PNG源。原件与编辑副本分别保存。

`POST /tasks/:id/rework` 接收parent_candidate_id、base_content、request_key，固定父候选保持原样。`POST /tasks/:id/matte` 接收frame_ids及可选base_revision/region；服务检查全部帧属于该任务动作。协作计算置done，遮罩仍未审核；同项目其他旧动作仍waiting_user，恢复重新验证原协作上下文。动作FPS更新返回output_timing：confirmed_fps更新全部输出时长，source_pts/explicit_durations保留绝对时长；手工步骤时长更新物化明确有理数输出时长。协作CLI/MCP命令、候选验收及交付由后续任务接入。

任务公共画布/锚点/比例/重采样与已有共享预设冲突时返回 ALIGNMENT_PRESET_CONFLICT；只有没有预设时才从任务要求初始化。根轨迹和偏移仍按动作保存。非编辑器任务创建、PNG导入和输出时序成功提交后使旧编辑撤销链失效；失败写入和已完成操作的相同重试保留后来建立的编辑历史。

### 固定私有候选（Task 4 服务基础）

collaboration/candidates.ts 提供 createPrivateCandidate(request, actor)、buildPrivateCandidate(request, signal?, progress?)、readCandidate/readCandidateManifest、candidateFilePath 与 submitCandidate(id, expectedHash, actor)。现有 queue 注入窄调度回调，调度前载入 queue。请求保留 request_key、任务/动作、原 base_content 及可选父候选；重放返回同一 operation/job/私有候选，不重新合成或重新选择历史版本。未配置对齐、主轨缺格或所选源顺序/映射错误均阻断。本任务不增加 HTTP/MCP/CLI 候选路由，适配器由 Task 10 接入。

checkCandidate(id) 使用现有 Pillow Worker 逐项读取全部已保存 PNG 及冻结输入，报告绑定 id、candidate_id、content_hash、manifest_sha256、checked_frame_count、blocking_errors、warnings。缺失/损坏帧算已尝试检查但不能通过。候选路径相对候选根；传输层只允许清单登记文件经 candidateFilePath 解析。最终 PNG 已应用制作变换，显示时不能再次合成。清单保存 raw/mask/RGBA 哈希、源尺寸、Canvas 正逆矩阵、期望 step/source 覆盖、固定图集页/矩形、合成器源码/Pillow 身份与辅助文件哈希。

提交必须同时满足预期哈希、当前文件完整性、完整技术检查通过及下文 Task 5 真实持久自检。缺少、未完成、空、过期或事实不一致的自检返回 SELF_CHECK_REQUIRED。已提交候选重放不会改选历史版本。


### 候选采样与观察事实（Task 5）

以下 `/api/v1/collaboration` 路由要求服务绑定的制作能力身份：

| 路由 | 输入 / 结果 |
| --- | --- |
| `GET /candidates/:id/sampling?limit=12` | 保存或重放唯一身份绑定 SamplingPlan；调用上限为正整数。 |
| `POST /candidates/:id/observations` | `{plan_hash,observations}`；整批原子校验和追加事实，返回自检。 |
| `GET /candidates/:id/selfcheck` | 返回校验过的 CandidateSelfCheck，首次写入前为 null。 |

共用服务位于 collaboration/samplingStore.ts：getCandidateSamplingPlan、recordSampleObservations、readCandidateSelfCheck；submitCandidate 使用相同权威验证器。候选创建/技术检查/提交的 CLI 与 MCP adapter 属 Task 10。身份只读 getRequestActor，body 不能授予权限。

预算为 min(12,max(1,floor(N/2)),冻结要求上限,调用上限)，更大上限不能提高公式。B=1 选最高风险或首帧；B>=2 强制首尾。风险最多新增4帧，常规最多8帧且包含首尾。优先级按小值排序：修复0、修复邻帧100、工具警告高/中/低200/201/202、其它帧内容变化300。线索来自技术元数据、修复关联及 Task 6 完整父候选比较：直接影响优先级300、受影响邻帧100。已有保存计划保留原风险输入与样本集合。同级按序列位置、重复理由确定去重；未覆盖风险只表示最终未选中的风险 ID，与已选但未观察帧分别报告。

常规时刻 j*T/(R-1) 覆盖完整播放区间，使用 BigInt 有理数精确比较。共享边界选早帧，重复目标按到未选区间的精确距离补选，同距选早序列位置。provenance 绑定 rational-interval-v1、完整清单 SHA256、调用/用户上限与规范风险。候选只有一个不可替换的保存计划；之后修改上限/风险元数据不扩展样本集合。源图、Alpha、背景切换仍是同一帧名额。

SampleObservation 绑定候选/内容/计划/帧身份，记录 viewed、ok/issue/uncertain、非空 explanation/evidence_source 与 evidence_candidate_id。省略证据候选时 writer 记录当前候选。复用要求同任务祖先已有 viewed=true 的真实存储记录、完全相同帧内容哈希及原来源/结果/解释，保留原始证据候选。外来、重复、计划外、过期或矛盾事实整批拒绝；viewed=false 只能为 uncertain。部分写入仍未完成；精确重放不新增记录，不同事实返回 OBSERVATION_CONFLICT；已提交记录保留完整观察事实，只允许精确重放或仅刷新当前 technical_check/blocking_errors。自检 ID、保存计划、全部观察及覆盖事实不变；重新记录的技术阻断仍禁止提交。

CandidateSelfCheck 保存 id/candidate_id/content_hash/manifest_sha256/plan_hash、observations、completed、完整 technical_check 与 blocking_errors，以及 viewed_frame_ids、unviewed_frame_ids、reused_frame_ids、issue_frame_ids、uncovered_risks。completed 表示所有选中事实与全量技术报告一致且完整，可诚实记录不确定性与提示问题，不代表美术通过。同一冻结内容重新技术检查后，旧自检失效，writer 可只刷新技术事实并保留原观察与计划。技术阻断仍不能提交。观察不会写人工审核或增加 review_revision；计划/观察/读取/提交均验证文件及清单身份。这些机制不能证明模型实际看过像素，也不能证明未抽中画面没有视觉缺陷。


### 候选影响服务（Task 6）

`collaboration/impact.ts` 导出纯函数 `compareCandidates(parent, next): ImpactReport`，本任务不增加传输入口。`changed_frame_ids` 包含仍存在的内容/时长/相对位置直接变化帧与改变的有向连接端点；`recheck_frame_ids` 再加入只扩展一次的旧/新邻帧，均按新候选顺序返回。`inheritable_frame_ids` 仅表示结构继承资格；Task 7 仍须核对当前真实父批准、问题/修复上下文和撤销状态。邻帧即使 PNG 相同也排除继承。`reasons` 提供中文解释并保留被删除的旧帧 ID；旧 ID 不进入新候选复审列表。公共画布/锚点/比例/重采样改变时，`preset_impacts` 标记被比较的动作。

`playback_changed` 表示播放内容改变或要求重新验收，相同播放 hash 不能覆盖遮罩/输入/变换/上下文影响。有理数时长与同模式冻结时长要求精确比较；已知要求变化须对应实际源顺序/时长/对齐结果。根插值、端点保持及偏移继续按序号表达，使用冻结实际几何。纯打包、抽样上限、要求来源标签变化，或来源/质量上下文已知且不变的同字节新遮罩版本标签，可保留结构资格。缺失/未知字段、质量变化、源映射歧义、上下文或父子关系不可证明、合成器变化均保守全量复审。比较器不读文件或证明字节真实性，候选完整性及技术检查仍须执行。

`collaboration/presetImpact.ts` 导出只读 `affectedActionsForPreset(projectId, changedPresetHash): WorkContext[]`。hash 表示调用方的新公共设置 SHA256（64位小写十六进制）。当前预设按项目全局共享且无法独立证明历史绑定，因此服务按 idx/id 返回项目全部动作，包括未对齐动作，不凭可能过期的绑定过滤。项目不存在或 hash 非法则拒绝。调用方将这些上下文与报告的公共预设原因组合展示；不修改历史候选、批准、任务或预设。

### 协作审核事务（Task 7）

`GET /api/v1/collaboration/candidates/:id/review-state` 返回共同 `ReviewState`：完整最终帧集合、判定及有效性、原操作/审核者依据、显式继承链、与候选相关的问题及修复/例外依据、播放状态、类型化错误和当前有效接受代次（`number | null`）。Task 的 `acceptance_epoch` 仍是非空单调计数器。历史候选完成审核不会抢占当前选择。

写入使用范围明确的候选 `/candidates/:id/reviews/{frame,playback}`、候选 `/candidates/:id/issues`、问题 `/issues/:id/{repair,accept-source-defect}`，请求 `{context,patch}`；context为 `{task_id,candidate_id,base_review_revision,request_key}`，patch使用对应共享类型。`/candidates/:id/reviews/inherit` 请求 `{context,parent_candidate_id}`，服务重算Task6影响；`/tasks/:id/selection` 使用 `CandidateSelectionRequest`（任务、候选、预期选中候选、预期任务代次及幂等键）。选择CAS独立于候选审核CAS，不生成批准。制作CLI/MCP不开放人工批准。旧flat别名在API1.3移除，见迁移表。

只有当前服务签发的 reviewer 可写帧、播放、问题、源缺陷例外、显式继承和选择。Maker 可读、关联完整修复。请求体 actor、角色或旧幂等键不能提升权限；认证早于成功重放。同键同业务输入在 CAS 前返回原结果，允许换用新合法 reviewer 会话，原执行者仍持久保留。改输入报 `REQUEST_CONFLICT`，新键旧修订报 `REVIEW_REVISION_CONFLICT` 或 `TASK_SELECTION_CONFLICT`。`server:` 键保留给服务。

修复 context 绑定原问题候选。要求同任务真实后代及完整稳定问题帧集；部分映射或删除问题帧拒绝。关联固定子候选当前审核修订，只进入 `repair_linked`；之后全范围新的明确人工帧确认及新的子候选播放才派生 `resolved`。此前/继承批准不能代替。撤销或改关联会重算；修复子候选不洗掉原父候选或旁支的缺陷。源缺陷例外需 reviewer 明确范围和理由，只覆盖原已接受的未改变帧内容，不能绕过技术阻断。advisory 保留批准和有效代次。

每个新候选都需独立播放，包括仅打包参数变化。显式帧继承同时核对当前真实父批准、稳定 ID/内容、结构影响及问题/修复排除，保存原操作、修订、执行者和哈希依据。子帧独立重新确认之前依赖当前祖先链；祖先撤销会使依赖接受失效。

接受要求完整准确最终帧 ID 集、当前同身份技术检查/自检、冻结文件、当前选择、全部有效帧批准、播放及无相关阻断。一个 immediate 事务写审核修订/证据、接受快照、递增代次及唯一 `claimed` 的 `deliver_candidate` 操作。提交后调用注入调度器，回调缺失/失败仍保留待交付操作。Task 8 实现队列/打包，Task 9 实现启动协调，本接口不声称它们完成。

`withAcceptedDelivery(request, synchronousCommit)` 是最终发布共用同步边界；核验原操作负载/哈希、当前选择/代次及最新事实。advisory 导致修订前进本身不撤销。失效接受持久撤销，恢复文件或批准也不会复活旧代次；已发布操作/结果/文件保留，检查点追加撤销依据，结果 `approval_status='withdrawn'`。新接受分配新代次/操作。Maker 新私有候选实际提交及 `startRework` 使用相同撤销边界；重放已提交候选不重新选择它。

Task 7 阶段规则：新登记接受必须处于 `awaiting_review`。`startRework` 后的读取、advisory 写入和成功重放保持返工；重放只返回原操作历史结果，不改变当前状态。reviewer 显式选择（包括返工时同一候选）通过任务选择/代次 CAS 开启审核。Maker 新私有候选提交正常开启审核。已有有效接受的重验与新建代次分开，不因私有构建正在运行就撤销它。

### 固定候选交付（Task 8）

人工接受事务提交后唤醒 `queueAcceptedDelivery(operationId)`；既有队列先原子持久化 job 与原 operation 尝试关联，再执行 `deliver_candidate`。`packageAcceptedCandidate(request, signal?, progress?)` 复制固定 PNG/图集及有理数时长，不调用源图合成。其参数顺序与旧 `exportAssets(payload, progress?, signal?)` 不同。

`GET /api/v1/export/resolve?project_id=…&axis_id=…&format=sequence|png_sequence|spritesheet` 返回 `data.mode=legacy`、带固定 `files[{file,url}]` 的 `candidate`，或带全部 `task_ids` 的类型化 `ambiguous`；不猜最近任务。缺少候选固定格式返回 `NEW_CANDIDATE_REQUIRED`，尚未正式提交返回 `DELIVERY_NOT_COMMITTED`。序列下载既有完整包，图集逐页下载原文件；裁定失败绝不降级为浏览器 Canvas。

`GET /api/v1/deliveries/:id` 读取原 succeeded 操作结果。`GET /api/v1/deliveries/:id/file?path=…` 仅允许正式提交清单中的文件，重新校验 hash，并返回 `X-Approval-Status: approved|withdrawn`。仅移动目录不构成交付。撤销保留 succeeded 操作、结果身份、文件和历史。完整 CLI/MCP 发现接口仍属 Task 10；现有 maker 导出/recipe 共用 core 闸门，不增加审核写权限。

所有协作动作旧正式导出的创建、准备、执行和发布都返回 `IMMUTABLE_DELIVERY_REQUIRED`，接受后也不能重渲染。显式草稿保留 `DRAFT_NOT_APPROVED`，不创建协作正式提交。素材、遮罩、骨骼文档和旧历史包读取保留原职责。

包包含原字节 `candidate-manifest.json`、交付 `manifest.json`、记录完整技术检查及实际抽样/viewed/unviewed/reused/uncovered 事实的 `quality-report.json`、固定 PNG/图集/联系表、可选从固定 PNG 生成的 MP4、接入说明和 ZIP。包内 `checksums.json` 只校验 payload，不含自己及 ZIP；原操作结果另存 `archive_sha256`。撤销后包内历史接受快照保留，当前批准状态须读取服务。

交付完整性还要求在归档前将生成 manifest/QA/checksums 的预期序列化字节固定为校验依据。即使 staging 松散文件曾被临时篡改后恢复，实际 ZIP 条目仍必须与同一可信清单一致；包内校验表自洽本身不能授权发布。本次完整性修正不改变 HTTP 契约。

### 稳定操作恢复（Task 9）

`resumeCollaborationOperation(id, actor): Promise<OperationRecord>` 要求当前实例实际认证的 maker / reviewer 对象。队列只使用原规范负载、base 与 operation ID，原子追加尝试 job 后才 pump；先核验原业务提交，再检查后来草稿版本。未提交且输入变化记为 `needs_input / INPUT_IDENTITY_CONFLICT`，归属冲突、损坏文件保留并拒绝自动认领。部分交付继续使用异步操作前保存的预期字节 hash，核验真实 ZIP 条目，不能从暂存文档重新计算预期身份。

`prepareExtractionOperation(payload, {request_key}, actor)` 是下一适配任务可调用的内部稳定抽帧入口，保留 raw / timing、GUI 副本、主轨事务和结果检查点。旧无 operation 抽帧入口保持原兼容行为。`POST /api/v1/jobs/:id/resume` 改为异步；持久 `operation_id` 决定严格恢复，即使调用者省略该字段也必须有当前请求认证。无稳定操作的协作任务不能静默清除 base 重跑；旧正式导出仍受协作闸门约束。

取消先持久化再尽力 abort；已提交业务事实优先于迟到取消，启动不复活明确取消。取消候选只有显式 Task 返工且原内容身份相同才可继续；交付接受撤销永久有效。启动先取得工作区锁再加载 DB，暂停队列、逐操作协调，然后才 pump 并加载监听服务；锁 / DB 全局失败不发布 ready。所有历史尝试和文件保留，进程退出测试不等于断电耐久性认证。



## 生产1.3制作门面与固定候选HTTP接口

Token模式MCP实际白名单由 `mcp/makerTools.ts` 定义，`inspect_capabilities` 返回全部实际名称、恢复能力与限制。支持项目/动作创建、来源导入与稳定提帧、PNG导入、制作阶段提交、job查询/取消、完整帧与产物读取、显式基础的遮罩编辑/撤回/对齐/时序、任务创建/读取/取消、候选创建/读取/全帧检查/抽样/观察/提交/比较、问题分页与修复关联、返工、原操作读取/恢复/取消，以及已接受固定候选交付。准确英文工具名见本文件末尾清单；无 `apply_review_patch` 或人工批准/继承/源缺陷接受工具。旧审核命令在token模式需要实际当前reviewer。

新任务不可变brief必须保存 `goal:{value:用户原话,origin:"user"}` 和服务核对原件字节的 `source_identity`（原件SHA256及PNG原帧哈希）。客户端不可虚构来源；历史brief不补写原话。已知目标/来源改变或历史上下文不明均保守复审。create_task输入为brief和request_key；context/source必需。缺目标/对齐/PNG时序集中返回needs_input、原因、建议及原输入/幂等键。复用已有制作对齐/时序；默认全源帧、视频有理数PTS、loop=false、sampling_limit=12、max_texture=1024/gap=0/margin=0及PNG/图集/联系表/ZIP，字段标注inferred或preset。PNG不虚构PTS；无内部LLM或隐式模型下载。

`/api/v1/collaboration`下新增白名单POST `/maker/:name`、任务/候选读写、完整帧与问题分页、review-state、原操作读取/恢复/取消、任务取消。GUI薄接口包括候选 `/reviews/frame`、`/reviews/playback`、`/reviews/inherit`、候选issues、issue `/accept-source-defect`、Task `/selection`，必须实际reviewer；issue `/repair`允许maker但不批准。审核body为共享context与patch，路径范围必须一致；继承使用parent_candidate_id，选择使用独立Task CAS。API1.3已移除旧flat `/reviews/*`别名及重复 `/candidates/:id/reviews`，使用范围路径与review-state；见迁移表。`/candidates/:id/file?path=…`仅供固定清单列出的已校验字节；`/deliveries/:id`及其file仅用已提交交付权威。`/action-export/resolve`明确多Task歧义；MCP/CLI export_assets可显式task_id，读取已接受交付或恢复原操作，不猜最新、不重渲染。已提交操作可以没有job，外部job_id为null。

帧/问题分页默认32、上限300，完整输出items/total/next_cursor/complete/content_token；依next_cursor读取至complete。draft游标绑定内容与上下文，candidate绑定固定身份；ReviewIssuePage另含并绑定review_revision。变化返回PAGE_CONFLICT。CLI保留完整manifest/影响/问题/嵌套帧数组，每命令stdout一个JSON，日志stderr。新增action create、source extract、task create|inspect|cancel、candidate create|inspect|samples|observe|submit|compare|check、issue list|repair、rework start、operation inspect|resume|cancel、frames list。结构输入--file，明确--request-key/--base-content/--base-mask-version以及ID/游标/上限；`import images --project ID --axis ID --directory DIR --file options.json`使用协作multipart，options包含幂等键/基础/确认时序，省略axis保留旧导入。离线schema新增task_brief/candidate_manifest/review_issue_page/impact。

失败历史查询exit0；等待/执行失败返回非零。超时保留原job/op，timed_out=true且cancelled_job=false，不自动取消。稳定extract_source/build_candidate/deliver_candidate按原payload/base/key恢复。旧协作matting没有稳定操作，恢复明确RECOVERY_UNSUPPORTED；能力与创建响应如实说明。操作取消只针对该操作；Task取消单独epoch CAS并保留协作模式。

stdio逐行最多1,048,576 UTF-8字节，不含LF/CRLF。原始字节有界缓冲，超限丢弃到换行，只发一次id:null错误并继续下一行；不解析超大输入，不宣称进程RSS硬上限。MCP HTTP JSON另限1,048,576字节。inline规范base64跨文件总量786,432 ASCII字符/589,824解码字节。更大文件使用鉴权HTTP multipart；实际Bun请求上限134,217,728字节/128MiB，包含multipart开销。SDK2.0.0使用原鉴权Request及parsedBody，legacy/modern并发保持原请求与actor；无body角色、重建身份、全局lastActor或HTTP自调用。

实际工具名：`inspect_capabilities`, `create_project`, `create_action`, `inspect_project`, `import_source`, `extract_source`, `import_images`, `submit_pipeline`, `get_job`, `cancel_job`, `list_frames`, `get_frame_artifacts`, `get_review_artifacts`, `edit_mask`, `undo_mask`, `save_alignment`, `set_output_timing`, `create_task`, `inspect_task`, `inspect_action_collaboration`, `create_candidate`, `inspect_candidate`, `check_candidate`, `get_candidate_samples`, `record_sample_observations`, `submit_candidate`, `list_review_issues`, `record_issue_repair`, `compare_candidates`, `start_rework`, `inspect_operation`, `resume_operation`, `cancel_operation`, `cancel_task`, `export_assets`。

新的公开任务创建在同一事务内把规范化的实际提交输入绑定到原create_task操作及当时解析的不可变brief。相同输入/键在草稿对齐、时序改变或配置移除后仍复用原brief；显式提交字段改变会冲突。仍先验证当前真实身份，并复核原素材字节。needs_input不占用创建键，可用同键提交回答后首次成功。没有实际提交输入证据的历史记录保持原resolved负载校验，不补写推测的省略字段。

Task11 最终区域契约：审核问题 `rect` 为有限连续像素边界 `[x,y,width,height]`，保留小数。位置非负、宽高为正，全部边界必须位于冻结最终画布内；负值、零宽高、非有限值及越界拒绝。审核身份、幂等键、审核 CAS 与接受失效规则不变。GUI 使用同源 HttpOnly Cookie 和固定候选文件路径，完整读取问题分页并在冲突后重新读取；浏览或播放不会写批准。

### 编辑器协作上下文（生产协议1.3）

`GET /api/v1/collaboration/action?project_id=…&axis_id=…` 与 maker 工具 `inspect_action_collaboration` 返回 shared `ActionCollaborationState`：`{mode, tasks: CollaborationTask[], timing: TaskBrief["timing"] | null}`。两者校验项目/动作归属，要求当前服务认证的制作能力（桌面审核会话同时具备制作能力）。完整列出任务，多任务必须明确选择；取消任务不清除协作模式。`timing` 是当前制作副本的权威策略。

`GET /api/v1/export/resolve` 与 `POST /api/v1/collaboration/action-export/resolve` 可带 `task_id` 明确选择当前动作内的任务；未知或跨动作任务返回 `TASK_CONTEXT_MISMATCH`。省略时保留原有明确歧义结果。仍须通过接受状态、固定格式、原操作和已提交交付校验；不降级实时渲染。

Editor 以已知任务ID打开局部验收模态框。工作台先完成 `start_rework`，再通过 `DraftEditContext` 将任务、父候选和返回内容令牌交给制作副本。显式时序切换复用 `/timing` CAS 操作。maker 的返工和时序适配器将 `{request_key}` 操作身份与负载字段分别传入；CLI、HTTP maker 与 MCP 仍使用相同的内容冲突检查和幂等重放规则。交付展示在挂载、审核变更、连接失效通知及5秒回退轮询时读取任务/审核/操作和已提交交付；短暂任务通知不是发布依据。撤回批准的历史文件保留可读并显示撤回状态。

旧版无令牌服务的 `/collaboration/action` 仍返回401；面板如实显示不可用，不安装推测身份。Alignment正式出口与浏览器导出共用原 `/export/resolve`，因此无协作的旧动作仍能正常导出。解析器鉴权、冲突或其他错误直接中止，绝不作为旧导出的回退信号。输入复用已有严格 `context` schema，输出为上述 shared 类型；无新数据库结构或审核权限。

## 工作区与服务管理（API1.3）

源码CLI、桌面与 `bun run start` / `bun run dev` 共用解析规则：显式 `--workspace` > `SFS_WORKSPACE` > 登记表当前工作区 > 默认目录。源码登记表为 `<repo>/.sfs/workspaces.json`，默认 `<repo>/workspaces/default`；1.0.8便携版为 `%LOCALAPPDATA%/SpriteMotionStudio/workspaces.json` 与同处 `workspaces/default`。旧版1.0.7二进制保留原选择方式。登记/选择只改变管理记录，不搬移或合并数据库；现有工作区与固定文件来源保留。

| 命令 | 行为 |
| --- | --- |
| `sfs.cmd workspace list --json` | 列出登记/默认/当前路径、是否存在及服务状态；不启动服务、不显示令牌，健康PID/实例核实后才显示当前端口。 |
| `sfs.cmd workspace current --json` | 返回实际选用目录与登记表位置。 |
| `sfs.cmd workspace add --name NAME --directory DIR` | 登记已有目录，拒绝名称/路径冲突；不会自动切换。 |
| `sfs.cmd workspace use --name NAME` | 选择已登记工作区；也可用 `workspace use --directory DIR` 选择已有目录。 |
| `sfs.cmd service status [--workspace DIR] --json` | 核查服务/锁归属与健康状态，不启动后端、不暴露凭据。 |
| `sfs.cmd service stop [--workspace DIR] --json` | 核实当前实例与任务，请求协作退出并等待，不按外部PID强杀；先保存并关闭GUI/MCP。 |
| `sfs.cmd service clean [--workspace DIR] --json` | 持有排他恢复锁，只清理已证明退出且归属匹配的发现记录及 `before-human-desktop` 备份；活动、损坏或归属不明时拒绝。 |

登记与选择要求目录已存在；业务命令显式指定的新目录可由启动创建。显式路径或 `SFS_WORKSPACE` 会覆盖登记的当前选择，切换时须清除旧环境变量覆盖。start/dev进入 `runtimeBootstrap.ts`：先取得工作区锁，再初始化审核管道与会话、加载DB并协调恢复，最后发布就绪。默认 `PORT=0`，每个活动工作区只有一个回环HTTP端口；`/api`、`/api/v1`、`/api/v1/collaboration`、`/ws`、`/mcp`共用，分别承载已有编辑器、流水线与协作职责。桌面named pipe保留独立人工权限边界，不是重复HTTP服务。

经过鉴权的 `POST /api/v1/runtime/stop` 不需要body。没有排队/运行任务、其他正在处理的HTTP请求或WebSocket客户端时返回 `202 {ok:true,status:"stopping"}`；忙时返回409，`error.code="WORKSPACE_BUSY"`。接受后新请求返回 `503 SERVICE_STOPPING`，25毫秒后协作关闭，退出处理释放本实例记录。CLI将身份不明/忙的服务作为冲突报告（退出码6），不强制终止。clean保留日志、数据库、原始素材、失败staging、固定候选和审核历史；损坏或归属不明的恢复/私密记录需人工核查。

### API1.2审核路由迁移

API1.3移除以下无消费者别名。路径均相对 `/api/v1/collaboration`；旧入口返回404，不写入审核记录。body、服务绑定真实身份、审核/选择CAS及幂等仍使用既有共享契约，范围路径与body中的ID必须一致。

| 旧入口（已移除） | 当前入口 |
| --- | --- |
| GET `/candidates/:id/reviews` | GET `/candidates/:id/review-state` |
| POST `/reviews/frame` | POST `/candidates/:id/reviews/frame` |
| POST `/reviews/playback` | POST `/candidates/:id/reviews/playback` |
| POST `/reviews/issue` | POST `/candidates/:id/issues` |
| POST `/reviews/repair` | POST `/issues/:id/repair` |
| POST `/reviews/source-exception` | POST `/issues/:id/accept-source-defect` |
| POST `/reviews/inheritance` | POST `/candidates/:id/reviews/inherit` |
| POST `/reviews/selection` | POST `/tasks/:id/selection` |

当前客户端与服务须精确匹配生产API **1.3**；API1.1便携包与API1.2历史服务不兼容，不自动强杀。先保存、完成任务并关闭原客户端，再用匹配源码重启。
