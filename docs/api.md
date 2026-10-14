# FrameBaker API

Base URL: `http://localhost:3000`; unless noted otherwise, all endpoints use the `/api` prefix. Request/response type definitions in `packages/shared/src/types.ts`.

Conventions:

- IDs are opaque strings: ordinary entities use UUIDs; automatically retained library assets use deterministic lineage digest IDs
- Frame `tags` / `metadata` are parsed as JSON in API output (stored as strings in DB)
- Error responses: non-2xx + plain text error message
- Write operations trigger WS broadcast (`/ws`, message format `{ "type": string, "payload": any }`, types listed at the end)

## Projects

### GET /api/projects

Project list, sorted by creation time descending. `has_thumbnail` reflects whether a project thumbnail PNG exists (see below).

```json
{
  "projects": [
    { "id": "…", "name": "走路循环", "created_at": 1785912000000, "frame_count": 8, "first_frame_id": "…", "has_thumbnail": false }
  ]
}
```

### POST /api/projects

```json
// Request
{ "name": "走路循环" }
// Response
{ "id": "…", "name": "走路循环" }
```

### GET /api/projects/:id

```json
{ "project": { "id": "…", "name": "…", "created_at": 1785912000000, "frame_count": 8, "has_thumbnail": false } }
```

### PUT /api/projects/:id/thumbnail

Uploads a project thumbnail rendered by the frontend. Body is the raw PNG binary (`Content-Type: image/png`, max 2 MB; PNG magic bytes are validated). Stored at `storage/thumbnails/projects/<id>.png`. 404 if the project does not exist → `{ "ok": true }`.

### GET /api/projects/:id/thumbnail

Returns the stored PNG (`Content-Type: image/png`, ETag/Last-Modified supported); 404 when the project or its thumbnail does not exist. Append `?v=<timestamp>` to bust caches after an update.

### PATCH /api/projects/:id

`{ "name": "New Name" }` → `{ "ok": true }`

### DELETE /api/projects/:id

Deletes the project and all its frames, jobs, and disk files (including the project thumbnail) → `{ "ok": true }`, broadcasts `project_deleted`.

## Frames

### GET /api/projects/:id/frames

Returns frames sorted by `idx` ascending:

Compatibility view: this returns only the default axis primary track, ordered by canonical shared steps. `track_id` and `step_id` are included. Step `idx`/`duration` are authoritative; frame fields mirror them.

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

PNG image stream. `type=processed` falls back to raw when no processed file exists. The optional integer `size` returns a cached thumbnail whose width and height are each at most that value; invalid or out-of-range values return the original image. Thumbnail generation uses ImageMagick or ffmpeg and gracefully falls back to the original image when neither is available. Responses include `ETag` / `Last-Modified`; URLs with `v` use a one-year immutable cache, while unversioned URLs revalidate. 404: frame or file not found.

### PATCH /api/frames/:id

Updatable fields (at least one required, all optional): `offset_x` / `offset_y` (-100000–100000), `scale` (0.1–8), `rotation` (radians, -π–π), `opacity` (0–1), `duration` (int 1–600), `is_keyframe` (0/1), and `tags` (string[]). Attack effects are independent timeline cells and use the endpoints below rather than frame patches.

```json
// Request
{ "offset_x": 12.5, "duration": 3, "is_keyframe": 1 }
// Response
{ "frame": { /* updated full frame */ } }
```

Broadcasts `frame_updated`.

### POST /api/frames/:id/replace

multipart/form-data: `file` (PNG, server validates file signature). The editor first crops/encodes via CropModal, then writes to `processed/<id>_replaced.png`; old processed file is cleaned up, `source` set to `upload`, status set to `ready`. Response `{ "frame": {…} }`, broadcasts `frame_updated`.

### POST /api/frames/:id/duplicate?count=N

Duplicates N copies (1–16, default 1) inserted after the original, copies image files and all properties, `source=duplicate`, subsequent frame indices shifted. Response `{ "ok": true, "count": 2 }`, broadcasts `frames_changed`.

### DELETE /api/frames/:id

Deletes frame and image files; subsequent frames in the same project have their idx decremented. `{ "ok": true }`, broadcasts `frames_changed`.

## Canonical composited timeline

- `GET /api/projects/:id/timeline?axisId=` — all project axes plus the selected/default axis, ordered tracks, shared steps, image `frames`, independent attack-effect `effects`, unassigned `poolFrames`, and reusable left-panel `assetFrames`.
- `POST /api/projects/:id/axes` (`name`, optional `fps`); `PATCH /api/axes/:id`; `DELETE /api/axes/:id` (the sole axis is protected).
- `POST /api/axes/:id/tracks`; `PATCH|DELETE /api/tracks/:id`; `POST /api/axes/:id/tracks/reorder` with exact unique `trackIds`. The primary/sole track is protected.
- `POST /api/axes/:id/steps`; `PATCH|DELETE /api/steps/:id`; `POST /api/axes/:id/steps/reorder` with exact unique `stepIds`. Step duration is 1–600 ticks and is mirrored to every cell.
- `PATCH /api/frames/:id/placement` with `{ "trackId", "stepId", "swap"?, "copy"? }`. Timeline moves use the existing frame; left-panel assembly uses `copy: true` to create an instance while keeping the source asset visible and reusable. With `swap: true`, an occupied target returns to the asset panel.
- `DELETE /api/frames/:id/placement` clears one timeline cell without deleting reusable image files. Asset frames return to the asset panel; copied timeline instances are discarded.
- `POST /api/tracks/:id/place-frames` with `{ "frameIds": [...], "startStepId"? }` copies same-project frame assets into consecutive cells on the target track. Occupied cells return to the asset panel, and missing trailing steps are appended atomically. Cross-project and non-asset sources are rejected before the timeline changes.
- `PUT /api/tracks/:id/steps/:stepId/effect` creates or replaces the effect in any track × step cell, including a cell with no image. The body contains up to 128 strokes; each stroke stores a `#RRGGBB` color, size 1–256, optional deterministic texture `brush` (`slash`, `bristle`, `dry`, `spark`, or `echo`; defaults to `slash`), and up to 4096 `{x,y,pressure}` points, plus independent offset/scale/rotation/opacity and optional `style` (`flame`, `energy`, or `ink`). `DELETE` on the same URL clears only the effect and leaves an image in the same cell untouched.

Timeline mutations broadcast `timeline_changed` with `projectId` and relevant axis/track/step/frame IDs. Deleting a cell prunes its step only when empty. Legacy duplication inserts shared steps after the source; legacy reorder is accepted only for an unambiguous primary-track one-cell-per-step shape.

- `POST /api/projects/:id/undo` restores the most recent successful timeline/frame edit for the project. The server keeps up to 50 per-project snapshots. Database-only edits do not copy image files; operations that replace, delete, duplicate, or import project images also snapshot the project files. Same-project edits and undo requests are serialized, and a failed restore rolls back without consuming the snapshot. Completed asynchronous jobs and MCP project mutations clear older history so stale snapshots cannot overwrite newer artifacts. A successful restore broadcasts `timeline_changed` and `frames_changed`; a project with no undo history returns 404.

### POST /api/projects/:id/reorder

```json
// Request: must contain exactly all frame ids of the project
{ "frameIds": ["id3", "id1", "id2"] }
// Response
{ "ok": true }
```

Rewrites idx by array order (transaction). 400: set mismatch. Broadcasts `frames_reordered`.

## Import

### POST /api/import/upload

multipart/form-data:

| Field | Description |
| --- | --- |
| `file` | Source file |
| `projectId` | Target project |
| `type` | `gif` (all frames) / `mp4` (extract at fps) / `image` (single image → one frame) |
| `fps` | Optional, mp4 extraction fps, default 8 (1–60) |
| `autoMatting` | Optional, `"true"` to auto-queue matting for each frame |

Response `{ "jobId": "…" }`, then poll `GET /api/jobs/:id` or wait for WS `job_done`.

```bash
curl -F "file=@test.gif" -F "projectId=$PID" -F "type=gif" http://localhost:3000/api/import/upload
```

### POST /api/import/generate

```json
// Request
{ "projectId": "…", "prompt": "pixel art knight", "count": 4, "autoMatting": false, "providerId": "…", "model": "wanx2.1-image", "size": "1328*1328", "references": [{ "kind": "material", "id": "…" }, { "kind": "frame", "id": "…" }], "mediaKind": "image" }
// Response
{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }
```

Provider resolution: if `providerId` is passed, looks up by id (not found → 400); default uses the first fully configured provider (settings page can configure multiple coexisting providers, types: `cli` / `api` (OpenAI-compatible) / `dashscope` (DashScope native) / `gemini` (banana) / `minimax`; when list is empty, env `FRAMEBAKER_GEN_CLI` synthesizes an id=`env` CLI provider as fallback). Optional `size` overrides the provider's `apiSize` at generation time (format varies by provider type: api e.g., `1024x1024`, dashscope e.g., `1328*1328`, gemini/minimax e.g., `16:9`; preset tiers in shared constant `GEN_SIZE_PRESETS`; CLI providers ignore size).

- **CLI provider**: structured fields assemble argv (`cliBin` + parameter name mappings: `cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`, empty = positional arg or not sent), no shell. For multiple references, `cliReferenceArg path` is repeated in selection order. Env `FRAMEBAKER_GEN_CLI` and legacy data use the legacy template placeholders (`{prompt}` `{output}` `{index}` `{reference}` `{model}`) and therefore support only one reference.
- **API provider (OpenAI-compatible, incl. OpenAI official / VolcEngine Doubao Seedream / various gateways)**: no reference image → `POST {apiBaseUrl}/images/generations` (JSON `{ model, prompt, size?, n: 1 }`); with references → `POST {apiBaseUrl}/images/edits` (multipart uses `image` for one file and repeated `image[]` for multiple files, plus prompt/model/size; requires an edits-capable model e.g., gpt-image series; dall-e-3 doesn't support edits). Response takes `data[0].b64_json` or `data[0].url` to download.
- **DashScope provider (native)**: `POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation` (wan2.7-image / qwen-image etc., not in compatible mode); no reference image content is `[{text}]` only; each reference prepends one `{image: dataURI}` item in selection order. Response takes `output.choices[0].message.content[*].image` URL to download (24h valid). `apiSize` can be `2K`/`1K`/`4K` or star format (e.g., `2048*2048`) passed through as-is. **Base URL normalization** (`normalizeDashscopeBaseUrl`): accepts Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com`, or docs-style compatible address `…/compatible-mode/v1` / trailing `/api/v1` (server strips suffix then appends native path); pay-as-you-go commonly uses `https://dashscope.aliyuncs.com`.
- **Gemini provider (banana / nano-banana)**: `POST {apiBaseUrl}/v1beta/models/{model}:generateContent` (`x-goog-api-key` header); each reference is sent as an ordered `{inlineData: {mimeType,data}}` part before the text part; `apiSize` maps to `imageConfig.aspectRatio` (e.g., `16:9`). The adapter searches every candidate/part for `inlineData.data` (and tolerates proxy `inline_data`), reports `promptFeedback.blockReason`, candidate `finishReason`, safety categories, model refusal text, and `responseId` when HTTP 200 contains no image, and retries once only for `NO_IMAGE`, `IMAGE_OTHER`, or a transient empty-candidate response.
- **MiniMax provider**: `POST {apiBaseUrl}/v1/image_generation` (Bearer); reference image via `subject_reference` (subject feature preservation, one image limit, base64 dataURI); `apiSize` maps to `aspect_ratio` (e.g., `16:9`); `response_format=base64`, response takes `data.image_base64[0]`; `base_resp.status_code` non-0 = failure.

Model defaults to request's `model`, then first item in provider's model list; neither available = job error. Provider not found or unconfigured = job set to `error` with explanation. `count` 1–16. In image mode, each requested output is queued as an independent job and runs under the global queue concurrency limit; `jobId` remains the first ID for compatibility and `jobIds` contains the full batch.

- **Video mode**: `mediaKind: "video"` — only generates and saves a single video material (`raw.mp4`, no frame extraction; `count`/`fps` ignored). Only supported by CLI / DashScope / MiniMax. After completion, use `POST /api/materials/:id/extract` (fps or timestamps) to extract frames.

- **CLI provider**: `{output}` given `.mp4` suffix path; output detected as video by magic bytes (ftyp/EBML/RIFF-AVI) → ffmpeg frame extraction. **In image mode, CLI output that is actually video also auto-converts to frame extraction** (`count` ignored in this case).
- **MiniMax provider**: protocol by model — `MiniMax-Hailuo-*` / `T2V-*` use v1: `POST {apiBaseUrl}/v1/video_generation` (`{ model, prompt, duration? }`) → `task_id`; poll `GET {apiBaseUrl}/v1/query/video_generation?task_id=` (`status`: Success/Fail etc.) to get `file_id`, then `GET {apiBaseUrl}/v1/files/retrieve?file_id=` to get `download_url`. `MiniMax-H3` etc. use v2: `POST {apiBaseUrl}/v2/video_generation` (`{ model, content:[{type:"text",text}], duration, ratio? }`) → `task_id`; poll `GET {apiBaseUrl}/v2/query/video_generation/{task_id}` (`task.status`: succeeded/failed/cancelled), success takes `task.content.url` to download. Default `duration=6`; text-to-video defaults to `ratio=16:9`.
- **DashScope provider (Wanxiang / HappyHorse)**: `POST {apiBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis` (header `X-DashScope-Async: enable`). Text-to-video `happyhorse-1.1-t2v`: `input:{prompt}` + `parameters:{resolution,ratio,duration,watermark:false}`; image-to-video `*-i2v`: exactly one `input.media[{type:first_frame,url}]`; reference-to-video `*-r2v`: one ordered `{type:reference_image}` media item per reference. → `output.task_id`; poll `GET {apiBaseUrl}/api/v1/tasks/{task_id}` (`output.task_status`: PENDING/RUNNING/SUCCEEDED/FAILED), success takes `output.video_url` to download. Legacy wanx can pass `apiSize` as `size`.

Video is async (approximately 1–5 minutes); progress is written to `job.progress` and pushed via WS. DashScope i2v accepts one reference and r2v accepts multiple; MiniMax video rejects references rather than silently ignoring them. CLI behavior depends on its configured argument.

Reference images are passed as an ordered `references` array (maximum 10): `{ "kind": "material" | "frame", "id": "…" }`. Sources can be mixed. The server resolves every id to a file path (prefers processed, falls back to raw), preventing client path injection. Legacy `referenceMaterialId` / `referenceFrameId` remain supported for one image but cannot be combined with `references`. OpenAI-compatible, DashScope, and Gemini image protocols support multiple references; MiniMax and legacy CLI templates explicitly reject more than one.

Optional `flattenBackground` must be a `#RRGGBB` color and only takes effect when at least one reference image is present. Before invoking the provider, the server uses ImageMagick to temporarily flatten every resolved reference onto that solid background in `storage/staging/genbg_*`; source materials/frames are never modified, and the staging directory is removed after completion, failure, or cancellation. If ImageMagick is unavailable, generation continues with the original references and the completed job retains a background-flattening warning in `job.progress`.

## Material Library /api/materials

Materials are first generated/uploaded to the library, matted, compared, then imported to a project as frames. Material `source` semantics are the same as frames (`cli`/`api`/`dashscope`/`gemini`/`minimax`/`upload`/`gif`/`mp4`/`image`/`duplicate`; AI generation writes actual provider type, no longer always `cli`); `status` is `raw` (original) / `matted` (background removed). Both materials and projects can have a `folder_id` (see `/api/folders`).

### GET /api/materials

Each material includes `project_ids: string[]`, the sorted, unique IDs of its associated **existing** projects. The library groups these virtually as project → video/photos; `kind` classifies videos/GIFs as `video`, and still/extracted frames as `image`. Associations come only from explicit metadata or recorded source/frame/material IDs, never filenames. Reused materials may belong to several projects. `[]` means unassigned. A one-time upgrade preserves provable legacy associations in metadata; later frame deletion does not erase those associations. Deleting a project removes it from the returned IDs while retaining library originals. Custom `folder_id` organization stays independent; grouping does not move or rewrite media files. The legacy `list_materials` MCP tool returns the same field; the desktop MCP whitelist is unchanged.

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

Rename one image or video material. Request `{ "name": "New material name" }` (trimmed, 1–200 characters) → `{ "material": {…} }`. Returns 404 when the material does not exist and broadcasts `material_updated` on success.

### GET /api/materials/:id/image?type=raw|processed&size=64..1024&v=VERSION

Material image/video stream. `type=processed` falls back to raw when no processed file exists. For image materials, the optional integer `size` returns a cached thumbnail whose width and height are each at most that value; invalid or out-of-range values return the original image. Thumbnail generation uses ImageMagick or ffmpeg and gracefully falls back to the original image when neither is available. Responses include `ETag` / `Last-Modified`; URLs with `v` use a one-year immutable cache, while unversioned URLs revalidate. Video responses ignore `size`.

### POST /api/materials/upload

multipart/form-data: `file` + optional `processedFile`, `metadata` (JSON object string; Elysia's multipart object parsing is also accepted), `autoMatting` (`"true"`), and `fps` (video extraction, default 8). `processedFile` creates a material with both raw/processed slots and `status=matted`; grid splitting uses it to preserve real before/after pairs.

Optional `projectId` assigns the upload to that project's library partition without adding timeline frames. It is validated before files or jobs are created (missing project: 404), applies to video originals and extracted photos, and is independent of `folderId`. Successful material-to-project imports add that project association without removing existing ones and broadcast `materials_changed`.

Project associations also include materials referenced by skeletal project binding attachments. Saving a valid skeletal document persists those associations and broadcasts `materials_changed`; later unbinding keeps the material's project partition. Rejected document saves create no associations.
PNG/JPG single image → directly creates 1 material, response `{ "materialId": "…" }`; GIF/MP4 → queued frame extraction, one material per frame, response `{ "jobId": "…" }`.

```bash
curl -F "file=@slime.png" http://localhost:3000/api/materials/upload
curl -F "file=@walk.gif" -F "autoMatting=true" http://localhost:3000/api/materials/upload
```

### POST /api/materials/generate

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "references": [{ "kind": "material", "id": "…" }], "flattenBackground": "#FF00FF" }` → `{ "jobId": "…", "jobIds": ["…", "…", "…", "…"] }` (provider resolution, independent image jobs, multi-reference rules, and temporary `flattenBackground` handling are the same as `/api/import/generate`). Each completed material job broadcasts `materials_changed`, so an open material library refreshes incrementally. Optional `name`: material naming base (defaults to first 24 chars of prompt); output named `name #i` (count>1) — material detail "multi-action generation" passes "materialName_action". Supports `mediaKind: "video"`: only generates and saves video material (`kind=video`), **no frame extraction**; use the extract endpoint below to split into frames. Skeletal part generation accepts paired `gridRows` / `gridCols` values from 1–8; both generated metadata and the grid-split editor preserve them. The humanoid default is `gridRows: 3`, `gridCols: 4` (12 parts). A `skeletal-character` two-stage request may put the same fields inside `followUp` for its generated parts sheet. Skeletal requests no longer need a pre-created `characterPartSetId`: when omitted, the server creates the internal part set automatically and returns its ID alongside `jobId`; an explicit ID remains supported for API compatibility.

### POST /api/materials/:id/extract

Extract video/GIF material frames into individual image materials → `{ "jobId": "…" }`. Copies source file to staging then enqueues **one** `extract_frames` job; output named "originalName #i", defaults to same folder. Non-video/GIF returns 400.

- **Full-range by fps** (default, GIF/video): `{ "fps"?: 8, "autoMatting"?: false, "folderId"?: null }`
- **Point extraction** (video only): `{ "timestamps": [0.12, 0.5, 1.0], "autoMatting"?: false, "folderId"?: null }` — seconds (float), sorted and deduplicated, max 64; GIF with timestamps returns 400. Server runs one `ffmpeg -ss T -i … -frames:v 1` per timestamp (cancellable).

### POST /api/materials/:id/matting

Queues matting job (`matting` job, queue concurrency 2), response `{ "jobId": "…" }`; material not found → 404, missing raw file → 400. **Same material with existing queued/running matting job → 409** (prevents duplicate queueing). Engine detection order see `GET /api/config` — custom CLI → bundled rembg → PATH rembg → passthrough copy (passthrough warning written to `job.progress`). On completion, `status` set to `matted` and broadcasts `material_updated`; rembg model auto-downloads on first use (can be hundreds of MB), progress pushed via WS `job_*` events.

### POST /api/materials/batch-matting

`{ "ids": ["…", "…"] }` → `{ "ok": true, "count": 2, "skipped": 1 }`. Only queues matting for `status=raw` materials; already matted or **with active matting job** counted as `skipped` (detail page can still re-mat individually, but active job returns 409).

### POST /api/materials/:id/replace-image

multipart/form-data: `file` (PNG) + `slot` (`"raw"` | `"processed"`). Crop tool's save endpoint: overwrites the corresponding slot file; `slot=processed` when no processed exists creates one and sets `status=matted`; `slot=raw` doesn't affect existing processed. Response `{ "material": {…} }`, broadcasts `material_updated`.

### POST /api/materials/:id/unmatting

Deletes processed, restores to `raw` status. Response `{ "material": {…} }`.

### POST /api/materials/:id/import

```json
// Request
{ "projectId": "…", "count": 2 }
// Response
{ "ok": true, "count": 2, "frameIds": ["…", "…"] }
```

Copies material as unassigned project frame(s) into the left-side frame pool. When a material has a valid matted image, all imported frame image slots use that matted result so downstream operations cannot silently revert to the original; otherwise they use the raw image. The material library still retains the original for explicit compare, restore, rematting, and raw-export actions. Frames enter a timeline only after placement. `source` and metadata are preserved. `count` 1–16, default 1. Broadcasts `frames_changed`.

### POST /api/materials/batch-delete

`{ "ids": ["…", "…"] }` → `{ "ok": true, "deleted": 2 }` (including disk files), broadcasts `materials_changed`.

### POST /api/materials/batch-import

`{ "ids": ["…", "…"], "projectId": "…" }` → `{ "ok": true, "count": 2 }`. Imports 1 frame each in the given order.

## Jobs

### GET /api/jobs

→ `{ "jobs": [ {…}, … ] }`, latest 50 by creation time descending (used for frontend job panel initial load; afterwards WS events are primary).

### GET /api/jobs/:id

```json
{
  "job": {
    "id": "…", "project_id": "…", "type": "extract_frames",
    "status": "done", "progress": "完成", "error": null, "created_at": 1785912000000
  }
}
```

`status`: `queued` / `running` / `done` / `error` / `cancelled`. Job payloads are in memory; on server restart, orphaned `queued` / `running` jobs are marked as `error` ("server restarted, job interrupted").

### POST /api/jobs/:id/cancel

Cancels a queued or running job → `{ "ok": true }`. `queued` immediately dequeued and marked `cancelled`; `running` triggers AbortSignal (kills `runCmd` subprocess / interrupts API polling). Already-finished status returns 409. Broadcasts `job_cancelled`.

## Folders /api/folders

Material library and project list share multi-level folders (`kind`: `material` | `project`). Resources belong via `folder_id`; deleting a folder moves contents up to the parent (resources are not deleted).

### GET /api/folders?kind=material|project

→ `{ "folders": [ { id, kind, parent_id, name, sort, created_at }, … ] }` (flat list, frontend builds tree).

### POST /api/folders

`{ "kind": "material", "name": "Characters", "parentId": null }` → `{ "folder": {…} }`, broadcasts `folders_changed`.

### PATCH /api/folders/:id

`{ "name"?, "parentId"? }` (cannot move to self or descendants).

### DELETE /api/folders/:id

Moves subtree resources up to parent, then deletes the entire folder subtree.

### POST /api/folders/move-items

`{ "kind": "material", "ids": ["…"], "folderId": null }` → `{ "ok": true, "moved": n }` (`folderId: null` = ungrouped).

## WebSocket /ws

Server → client one-way broadcast, JSON:

```json
{ "type": "frame_updated", "payload": { "id": "…", "projectId": "…" } }
```

| type | When |
| --- | --- |
| `job_queued` / `job_running` / `job_progress` / `job_done` / `job_error` / `job_cancelled` | Job lifecycle |
| `frame_updated` | PATCH / replace / frame matting complete |
| `frames_changed` | Import complete / duplicate / delete / material import to project |
| `frames_reordered` | Reorder |
| `project_deleted` | Delete project |
| `material_updated` | Material rename / matting complete / restore raw / crop replace image |
| `materials_changed` | Material upload / generate / batch delete / move folder |
| `folders_changed` | Folder add/remove/update / move |
| `settings_changed` | Setting written (layout / theme / lang / genProvider / matting) |

Frontend recommendation: on receiving `frame_updated` / `frames_reordered` / `frames_changed` / `job_done`, re-fetch frame list; on `material_updated` / `materials_changed`, re-fetch material list; reconnect 3s after disconnect.

## UI Preferences /api/settings

Layout (editor panel sizes), theme mode, interface language, generation providers, matting config, etc. are persisted server-side in `settings` table (SQLite) — survives browser changes and restarts; theme and language use frontend localStorage as first-paint cache only, silently degrades when server is unreachable.

### GET /api/settings

Returns entire kv object (values JSON-parsed):

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
    { "id": "…", "name": "Local mygen", "type": "cli", "cliTemplate": "mygen --prompt \"{prompt}\" -o {output}", "apiBaseUrl": "", "apiKey": "", "apiModels": [], "apiSize": "" }
  ],
  "matting": { "cliTemplate": "", "model": "u2net" }
}
```

### PUT /api/settings/:key

```json
// Request (key allowlist: layout, theme, lang, genProviders, matting, imageLayers, promptEnhancers; other keys return 400)
{ "value": { "sidebarW": 260, "timelineH": 160 } }
// Response
{ "ok": true }
```

`theme` valid values: `"system"` (follow system) / `"light"` / `"dark"`. `lang` valid values: `"zh"` / `"en"`. Broadcasts `settings_changed` `{ key }` after write.

`genProviders`: generation provider list. Connection credentials stored once (`apiBaseUrl` / `apiKey`); capabilities split by `imageModels` / `videoModels` / `textModels`; default sizes for image and video are `imageSize` / `videoSize` respectively. Server still reads legacy `apiModels` / `apiSize`: legacy models are migrated by name to image or video capabilities; legacy sizes serve as fallback for both types; settings page only writes new fields. CLI continues using `cliBin`, parameter names, and `cliExtraArgs` structured argv — no shell; when list is empty, env `FRAMEBAKER_GEN_CLI` is fallback.

`promptEnhancers` elements are `{ id, name, providerId, model }`, reusing `api` or `dashscope` provider connection credentials; legacy `{ apiBaseUrl, apiKey, apiModel }` still readable at runtime. `POST /api/enhance-prompt` accepts `mediaKind: "image" | "video"` and `referenceImageCount` (0–10). The server selects text-to-generation, single-reference, or ordered multi-reference prompt semantics from that complete context.

`matting`: structured matting command `cliBin` / `cliInputArg` / `cliOutputArg` / `cliModelArg` (all empty → falls back to env `FRAMEBAKER_MATTING_CLI` template → auto-detection); `model` empty falls back to `FRAMEBAKER_MATTING_MODEL` / default `u2net`.

`imageLayers`: standalone image-layer service configuration `{ "apiBaseUrl", "apiKey", "model" }`. It is independent from generation providers and calls `POST {apiBaseUrl}/images/layers`. If this setting has never been saved, the server temporarily reads the first legacy `genProviders[].layerModels` entry for migration compatibility.

### POST /api/materials/:id/layers

Queues semantic scene-layer decomposition. It reconstructs editable RGBA layers such as background, whole subject, props, and foreground; it does not promise character body parts or strict pixel-label segmentation. Source must be an image (processed preferred over raw), and the standalone `imageLayers` setting must contain Base URL, API key, and model. The async job type is `image_layers`. Full scenes should normally use `autoMatting: false` to preserve context. For an already isolated foreground without a processed image, set `autoMatting: true` to remove its background within the same job before the layer service is called; if matting fails or is cancelled, the layer request is not sent.

```json
{ "layers": 4, "numInferenceSteps": 50, "trueCfgScale": 4, "negativePrompt": "", "seed": 0, "autoMatting": false }
```

Ranges: `layers` 1–4 (the current Gitee Qwen-Image-Layered endpoint rejects values above 4), `numInferenceSteps` 1–100 (UI/MCP default `50`, matching the upstream quality configuration), `trueCfgScale` 0–20 (default `4`), integer `seed >= 0`. Returns `{ "jobId": "…" }`; result layers become raw materials in the source folder. For deeper decomposition, split one returned layer again recursively.

## Animation Assets /api/animation-assets

- `GET /api/animation-assets?kind=...` lists stored Skeleton and MotionClip action assets. CharacterBinding is project-local and is never exposed by this library.
- `POST /api/animation-assets` creates `{ asset, folderId? }`; `GET`, `PUT`, and `DELETE /api/animation-assets/:id` read, replace, and delete one Skeleton or MotionClip. Posting a CharacterBinding is rejected.
- `GET /api/projects/:id/skeletal-document` reads a skeletal project's document; `PUT` replaces it. The document owns its character's CharacterBinding and material references. Project actions may reference only MotionClips with the exact same `skeletonId`.
- MotionClip `schemaVersion: 1` keeps track-level `step | linear`. MotionClip `schemaVersion: 2` removes track-level interpolation and requires every key to carry `outInterpolation`: non-terminal keys use `{ type: "step" | "linear" }` or `{ type: "cubic-bezier", x1, y1, x2, y2 }`, while the terminal key uses `null`. Bézier controls must be finite values in `[0, 1]`.
- Reading or saving v1 does not upgrade it. The editor upgrades to v2 only when the user explicitly selects a cubic curve. `.fbanim` package versions remain independent from embedded MotionClip schema versions.

## Other

- `GET /api/health` → `{ "ok": true, "name": "FrameBaker" }`
- `GET /api/config` → server capability detection (resolved in real-time per request, settings page changes take effect immediately):

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

  `engine`: `custom-cli` (settings page matting.cliTemplate or `FRAMEBAKER_MATTING_CLI`) / `rembg-bundled` (`.venv-matting` bundled) / `rembg-path` (found in PATH) / `none` (not installed, matting only copies raw, `hint` contains install instructions). `model` is rembg model name (settings page matting.model → `FRAMEBAKER_MATTING_MODEL` → default `u2net`); `modelCached` indicates model file exists in `storage/models` (uncached models auto-download on first matting). `imageLayers` reports the standalone image-layer service state without exposing its API key. `gen.providers` is a summary of all generation providers (no apiKey; model capability lists feed generation dialogs, `configured` indicates key fields are complete, `video` indicates video generation support — CLI/DashScope/MiniMax only, mapping in shared constant `PROVIDER_VIDEO_SUPPORT`).
- `GET /api/doctor` → health check: checks storage directory writable / ffmpeg / matting engine & model cache / standalone image-layer service / each generation provider (CLI validates command existence; OpenAI-compatible sends `GET /models`, Gemini sends `GET /v1beta/models`, DashScope sends `GET /compatible-mode/v1/models` for connectivity test; MiniMax has no probe endpoint, field validation only) → `{ "checks": [{ "id", "ok", "label", "detail" }] }`.
- `POST /api/provider/test` → API provider connectivity test (uses current form values, no need to save first): `{ "type"?, "apiBaseUrl", "apiKey", "apiModel?" }`; api sends `GET {baseUrl}/models` + Bearer, gemini sends `GET {baseUrl}/v1beta/models` (x-goog-api-key), dashscope sends `GET {baseUrl}/compatible-mode/v1/models` + Bearer, returns `{ "ok", "status", "latencyMs", "modelsFound" }` (401/403 = authentication failure); minimax has no lightweight probe endpoint, field validation only with explanation in `note`.
- `POST /api/provider/models` → API provider model list (settings page "Fetch Models", uses current form values, no need to save first): `{ "type", "apiBaseUrl", "apiKey" }` → `{ "ok", "models": ["…"] }`; endpoints same source as connectivity test (api `/models`, dashscope `/compatible-mode/v1/models`, gemini `/v1beta/models` strips `models/` prefix; minimax best-effort tries `/v1/models`); failure returns `{ "ok": false, "error" }`, frontend keeps manual input.
- `POST /api/enhance-prompt` → prompt enhancement (enhancer model configured in settings page, OpenAI-compatible `chat/completions`, enhancement system prompt built in server-side): `{ "enhancerId"?, "prompt", "style"?, "mediaKind"?, "referenceImageCount"? }` → `{ "enhanced", "enhancerName" }`. `style` selects pixel/anime/illustration/3d/realistic/general rules and examples; `mediaKind` selects image/video guidance; `referenceImageCount` (0–10) selects text-to-generation, single-reference, or ordered Image 1…N multi-reference semantics. The frontend forwards current selections and clears stale comparisons when they change. Invalid conversational/clarification responses are corrected once, then rejected with a clear error.
- `GET /fonts/:name` → font files from `apps/web/public/fonts/` (woff2 / OFL.txt)
- `GET /imageops/imageOps.worker.js` → frontend crop worker script (server `Bun.build`s `apps/web/src/imageops/imageOps.worker.ts` on demand; development mode rebuilds each time, production caches)

## MCP (Model Context Protocol) Endpoint

FrameBaker includes a built-in MCP server that allows AI assistants (Claude Desktop / Claude Code / Cursor / Windsurf etc.) to operate on projects, frames, materials, jobs, and all other features via the MCP protocol.

### Transport

Based on `@modelcontextprotocol/server` SDK v2 Streamable HTTP transport, auto-compatible with 2025-era (`initialize` handshake) and 2026-07-28 (stateless core) protocol versions.

- `POST /mcp`: receives JSON-RPC requests, returns JSON responses
- `GET /mcp`: SSE channel (server → client notifications)
- `DELETE /mcp`: end session

Protocol version negotiation and session management are handled automatically by the SDK; all tools are stateless direct db operations.

### Client Setup

**Claude Desktop** (macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Code** (CLI):

```bash
claude mcp add framebaker --transport http http://localhost:3000/mcp
```

**Cursor** (`.cursor/mcp.json` in project root, or global settings):

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "framebaker": {
      "serverUrl": "http://localhost:3000/mcp"
    }
  }
}
```

### Quick Start for AI Agents

Copy and paste the following to your AI agent to get started:

```
FrameBaker is running at http://localhost:3000 with an MCP server at /mcp (Streamable HTTP).
Connect to it and use `list_projects` to get started.
Available tools: list_projects, create_project, list_frames, generate_frames, list_materials, matting_material, list_jobs, get_config, and 40 more.
All tools manage pixel-art animation projects — frames, materials, generation, matting, folders, jobs, and settings.
```

### Handshake (2025-era Clients)

```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "my-client", "version": "1.0" } } }
// Response
{ "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} }, "serverInfo": { "name": "framebaker", "version": "1.0.7" } } }
```

After handshake, send `notifications/initialized` notification (no response needed), then `tools/list` and `tools/call` are available. 2026-07-28 clients can skip the handshake and call directly.

### Tool List

| Tool | Description |
| --- | --- |
| `list_projects` | List all projects |
| `get_project` | Get single project details |
| `create_project` | Create a project |
| `update_project` | Update project name/folder |
| `delete_project` | Delete project and all its frames/jobs/files |
| `list_frames` | List all frames in a project |
| `update_frame` | Update frame image properties/transform |
| `delete_frame` | Delete a frame |
| `clear_frame_cell` | Clear a timeline cell without deleting reusable asset files |
| `get_timeline` | Get tracks, steps, image cells, and independent effect cells |
| `upsert_attack_effect` | Create or replace an attack effect in any track × step cell |
| `duplicate_frame` | Duplicate frame 1–16 copies |
| `reorder_frames` | Reorder frames |
| `generate_frames` | Generate frames for a project (AI provider) |
| `generate_materials` | Generate materials (AI provider) |
| `list_materials` | List all materials |
| `rename_material` | Rename one image or video material |
| `matting_material` | Single material background removal |
| `split_material_layers` | Split an image material with the standalone image-layer service |
| `batch_matting` | Batch background removal |
| `extract_material_frames` | Extract video/GIF material frames |
| `import_material_to_project` | Import material as project frame |
| `batch_import_materials` | Batch import materials to project |
| `batch_delete_materials` | Batch delete materials |
| `unmatting_material` | Restore raw (remove matting result) |
| `list_folders` | List folders |
| `create_folder` | Create folder |
| `update_folder` | Update folder |
| `delete_folder` | Delete folder (contents move up) |
| `move_items_to_folder` | Move materials/projects to folder |
| `list_jobs` | List recent jobs |
| `get_job` | Query single job status |
| `cancel_job` | Cancel job |
| `get_config` | Get server config (providers/matting engine) |
| `run_doctor` | Health check |
| `get_settings` | Get all settings |
| `update_setting` | Update a single setting |
| `enhance_prompt` | Enhance prompt |

### Tool Call Examples

```json
// List projects
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "list_projects", "arguments": {} } }

// Create project
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "create_project", "arguments": { "name": "走路循环" } } }

// Generate frames
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "generate_frames", "arguments": { "projectId": "…", "prompt": "pixel art knight walk cycle", "count": 4 } } }

// Query job status
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "get_job", "arguments": { "jobId": "…" } } }
```

Tools return `content: [{ type: "text", text: "…" }]` format (text is a JSON string); on error `isError: true`.
# Soldier Frame Studio P1 local API supplement

The isolated `sfs.cmd` entry shares upstream business storage and binds to `127.0.0.1`. API/WebSocket requests except `/api/health` require a Bearer token or local HttpOnly cookie; Host must match and an Origin header must be same-origin. Read credentials from workspace `.sfs/service.json`; never log or commit them.

| Endpoint | Input | Output |
|---|---|---|
| POST `/api/v1/projects` | JSON name | data.project, project_id |
| GET `/api/v1/projects/:id` | ID | project/sources/clips and revision |
| POST `/api/v1/sources/import` | multipart projectId/file | immutable copy, SHA256, complete probe, source_id |
| POST `/api/v1/clips` | JSON project_id/source_id/name | existing axis/main track, clip_id |
| POST `/api/v1/extract` | JSON project_id/clip_id/mode:"all"/base_revision? | accepted and real job_id |
| GET `/api/v1/jobs/:id` | ID | persisted payload/state/result/error |
| POST `/api/v1/jobs/:id/cancel` | ID | cancellation scoped to that job |

Responses contain schema_version "1.0", ok, status, project_id, requires_user_action, data, artifacts, warnings and error; job operations include job_id. Upstream done/error map to succeeded/failed; restart leftovers become interrupted. `job status` can query failed history with exit0; `job wait` reflects the terminal outcome. See [README_SFS.md](../README_SFS.md).

Legacy `/api/import/upload` defaults MP4 to the same complete-frame service; explicit mode=fps preserves old sampling. Source PNGs still include scene backgrounds. Exact timing is independent of integer timeline ticks; preview quantization reports PREVIEW_TIMING_QUANTIZED. Source files use zero-based frame_000000.png; game export naming belongs to P4.

The isolated entry disables generation, provider/cloud diagnostics and broad upstream MCP. Desktop project and library video/GIF imports both use complete extraction; `/api/config` currently reports sfs.phase=P2. Upload-time auto-matting returns 409/USE_P2_MATTE; import into a project and use the P2 mask API. Thin MCP integration remains P4 scope.

### Desktop reusable library retention (2026-10-11)

- `POST /api/import/upload`: completed image jobs retain independent library copies. Video/GIF import retains the original; extraction commits register every original frame. Desktop imports always use all frames, ignoring legacy `mode=fps`.
- `POST /api/materials/upload`: images return `{materialId}`; video/GIF returns `{materialId,jobId,mode:"all"}`. Original media, every display frame and exact rational timing are retained. `folderId` applies to both the original and its frames. Invalid media returns400; missing dependencies503. Failed files remain available for diagnosis.
- `POST /api/materials/:id/extract`: desktop `{}` queues all-frame extraction and returns `{jobId,mode:"all"}`. Existing source frames reuse their deterministic IDs. Legacy `fps` does not sample; nonempty `timestamps` returns409 and `autoMatting:true` returns409/USE_P2_MATTE.
- `GET /api/materials`: includes video/GIF originals (`kind=video`) and reusable PNGs. Metadata preserves `source_id/source_frame_id/source_index/timing`. Project frame pickers show images; original videos can be previewed/extracted in the library.
- `POST /api/materials/batch-import`: existing `ids/projectId/target` semantics copy independent project files. Project edits/deletion do not affect library originals. Without `target`, assets enter the frame pool; an axis/track target places them on its timeline.
- On first upgraded startup, existing P1 source videos, complete frames and legacy imported project images are retained under `STORAGE_ROOT/materials`. A persisted marker prevents deleted library records from being resurrected on restart. Retention preserves imported originals; later P2 project corrections do not automatically overwrite library assets.

Desktop upload controls disable upload-time matting, FPS sampling and cloud generation. Non-isolated upstream sampling remains compatible; legacy examples below do not indicate desktop capabilities.
# SFS P2 local mask API

2026-10-10 fix: `region` selects the area to keep; pixels outside become transparent. Nearly uniform background-only regions fail with `REGION_NO_FOREGROUND`; empty or almost invisible automatic masks fail with `MATTE_NO_FOREGROUND` (HTTP 422 / failed queue job). The entire batch retains its previous heads, with staging preserved. Frame diagnostics include `method: edge_color|rembg|brush|existing` and `visible_fraction` (alpha > 128), plus `LOW_CONFIDENCE`. Empty/weak masks cannot be reviewed. Nearly uniform image borders select connected background-color removal; other scenes use the local model. Detached equipment remains eligible foreground.

The authenticated isolated desktop service exposes `POST /api/v1/matte` with `project_id`, `frame_ids`, optional `region: [x,y,width,height]` and `base_revision`. A shared queue job returns `waiting_user`, `requires_user_action: true`, model provenance, anomaly IDs and local preview/mask/RGBA paths. One CPU Rembg session serves a batch; no implicit model download occurs.

Pure-background batches and cache-only batches now report `session_count: 0`; a Rembg session is initialized once only if a frame requires model inference. Four-connected background labeling uses the existing scipy dependency, and connected near-background compression noise is fully transparent rather than a translucent haze. Internal light details remain protected by connectivity. Matting cache algorithm v3 prevents reuse of the previous haze-producing outputs.

`POST /api/v1/matte` also accepts optional `background_points: {"FRAME_ID": [[x,y], ...]}` (at most 2000 selected frame IDs and 128 integer source-pixel points per frame). These points identify additional near-background-color connected regions, including enclosed leg gaps, without deleting all light clothing. Points must belong to the selected frames and retained ROI; foreground-colored, out-of-bounds, or complex-background points fail explicitly. CLI: `matte --background-points points.json`. The shared recipe `matting.background_points` exposes the same capability through maker MCP `submit_pipeline`. Cache v5 binds the per-frame points and current background-edge algorithm. Original images and previous mask versions are retained; no approval is recorded.

`GET /api/v1/masks/:frameId` returns the current version, project revision and immutable history. `GET /api/v1/masks/:frameId/image?kind=raw|mask|rgba|preview&version=...` serves only recorded local paths. `POST .../strokes` accepts `version_id`, `revision`, and `strokes: [{mode: "erase"|"restore", size, points:[[x,y],...]}]`. `POST .../undo` and `POST .../review` require the same version/revision pair. Coordinates and brush diameters are in the full original image, with no largest-component filtering. `GET /api/v1/projects/:id/masks` provides review/anomaly state after reopening. Invalid input returns 400, stale revisions 409, missing dependencies/models 503. CLI and GUI share these endpoints; formal export and MCP remain later phases. See [P2 guide](p2-guide.md).
Mask review commits the reviewed flag, project revision and affected matting job states in one transaction. Historical batches referencing deleted frames or frames moved to another project become `cancelled` with `requires_user_action: false`; their payloads, results and files remain retained. They cannot block review of a present frame or count as successful approval. Intact batches become `done` only when every referenced frame has a valid reviewed mask. Job events are sent after commit; a failed transaction leaves review and revision unchanged.

## SFS P3–P5 production API (2026-10-11)

Authenticated local shared service; all JSON responses use the existing v1 envelope. Project/axis IDs identify the primary track ordered by animation-step index.

| Endpoint | Contract |
| --- | --- |
| POST `/api/v1/images/import` | Multipart `projectId`, `files[]` (1–2000 PNG), optional `name`; retain originals/alpha, natural filename order, never auto-approve |
| GET `/api/v1/alignment` | Query `project_id`, `axis_id`; config, revision and approval |
| POST `/api/v1/alignment` | IDs, `config`, exact `base_revision`; update character canvas/anchor/scale and action roots |
| POST `/api/v1/alignment/check` | IDs; all frame bounds/empty checks through the same compositor |
| GET `/api/v1/preview/:id` | `axis_id` query; source-derived RGBA canvas PNG, checked cache |
| POST `/api/v1/review/apply` | IDs, current `base_revision`, explicit human `confirmation` and `source`; all masks must already be reviewed |
| POST `/api/v1/collaboration/candidates/:id/reviews/whole` | Current desktop reviewer only; `{context,patch:{content_hash,playback_hash,confirmed:true}}`. Explicit human confirmation of all final frames and playback atomically records full review and uses the existing delivery flow. Reject identity/CAS conflicts, unsubmitted/unselected candidates, blocking issues and repair verdicts. No CLI or maker MCP approval tool. |
| POST `/api/v1/export` | IDs; optional `draft`, `base_revision`, `max_texture`, `gap`, `margin`, `timing` (`source_pts`/`constant`); durable job |
| POST `/api/v1/pipeline` | IDs, recipe schema1.0 and optional `clip_id`; next incomplete stage, `continue_required` |
| POST `/api/v1/jobs/:id/resume` | New job from current inputs; only interrupted, failed or cancelled jobs |
| GET `/api/v1/exports/:id/file` | Allowlisted `path`: assets.zip, manifest/report/checksums/readme, sequence/grid PNG, contact sheet or preview MP4 |

Formal export requires exact reviewed revision and hashes of raw, mask, foreground and parameters. Export writes a new staging directory and validates the snapshot again before immutable publication. Missing files return INPUT_NOT_FOUND; concurrent edits return REVISION_CONFLICT/STALE_JOB_RESULT. Draft output is visibly marked. PNG/grid output uses shared scale, untrimmed cells, straight RGBA, no rotation/deduplication and rational frame durations.

Token-mode `/mcp` exposes the maker-only production1.2 whitelist documented below; it excludes all human approval tools. SDK Streamable HTTP and CLI stdio bridge share internal validated services. The broad upstream MCP remains for tokenless upstream development only. Source import accepts explicitly supplied bounded base64 bytes, never arbitrary server filesystem paths. CLI heartbeat prevents idle shutdown while an MCP client is connected.

CLI schemas are available offline through `schema --name alignment|recipe|manifest --json`. See [calling guide](p3-p5-guide.md). HTTP editing, GUI, CLI and MCP share one workspace service; packaged startup resolves sibling runtimes and writable user data.

1.0.1 rendering correction: `/api/config.sfs.production_api_version` is `1.1`; clients reject older service instances. Manifest frames include `transform` (`offset_x`, `offset_y`, signed `scale`, radian `rotation`, `opacity`), applied around the full source-image center before ground alignment. Preview/bounds/review/export share these values; any transform edit invalidates old approval and cached pixels. Packing does not automatically rotate cells.

Imported/manual nonempty PNG alpha may be entirely semi-transparent. `/masks/:id` and the project mask summary normalize legacy imported LOW_CONFIDENCE hints without changing persisted pixels or review state. Empty actual RGBA and automatic low-confidence masks remain rejected. JSON schema/envelope version stays 1.0; existing manifest consumers may ignore the added transform provenance field.

Home decoration: fixed same-origin GET `/illustrations/creative-candy.png` returns PNG without accepting dynamic filenames. Token-mode service retains local authorization; development reads web/public/art and packaged builds read runtime/assets/art.

### Local roles and production API 1.2

The runtime publishes `.sfs/service.json` only after the instance session registry, local desktop broker and protected `.sfs/desktop-bootstrap.json` are ready. Its token is maker-only. `sfs_token` retains maker behavior; a valid current-instance `sfs_reviewer` HttpOnly, Strict, host-only cookie takes precedence and also permits manual production. Invalid reviewer cookies never elevate a maker. Host, Origin and WebSocket checks remain enforced; health exposes only live instance/PID identity. Production clients must explicitly match API `1.2`; incompatible services are left running.

There is no HTTP endpoint to upgrade a maker credential. Trusted desktop main processes verify descriptor and live service identity, exchange a PID-bound,30-second, single-use nonce over a local named pipe and install the reviewer cookie before loading a page. Future collaboration review adapters must use `getRequestActor(request)` plus `requireRole(actor, 'reviewer')`; body/header actor assertions are untrusted. Existing manual review/export behavior is not replaced by this foundation task.

### Collaboration draft preparation (API 1.2 foundation)

All `/api/v1/collaboration` adapters use the server-bound local maker/reviewer actor; body actor fields cannot grant authority. `POST /tasks` takes `{brief,request_key}`. `GET /draft?project_id=...&axis_id=...` returns actual byte-bound content, the independent expected source selection, rational output durations, and `alignment:null` for an unconfigured draft. Candidate building must reject missing alignment. `POST /timing` takes `{context,timing,base_content,request_key}`; timing is a TaskField with source_pts, confirmed_fps, or explicit_durations. It preserves source PTS metadata.

`POST /images` is multipart: `project_id`, `axis_id`, PNG `files`, and JSON `options` containing request_key, ordered_names (optional), timing, and base_content. JSON text (including leading whitespace) and the object parsed by Elysia share the strict maker import-options schema; malformed JSON, non-object values and unknown option fields are rejected. CLI uploads send flat basenames explicitly. Names must be unique flat NFC PNG filenames; explicit order must cover all files. Natural order is used otherwise. Occupied axes are rejected. PNG sources expose a typed png_sequence probe with canonical source-frame mappings and no video PTS; video extraction endpoints reject PNG sources. Originals and editable raw copies are separate.

`POST /tasks/:id/rework` takes parent_candidate_id, base_content, and request_key; it preserves fixed parent pixels. `POST /tasks/:id/matte` takes frame_ids and optional base_revision/region. The service verifies every frame against that task axis. Computation completes as done with masks still unreviewed; unrelated legacy jobs retain waiting_user. Collaborative matting without a persistent operation rejects resume with RECOVERY_UNSUPPORTED. Editing an axis FPS returns output_timing; confirmed_fps retimes the complete output sequence, while source_pts/explicit_durations retain absolute timing. Manual duration edits materialize explicit rational output durations. The complete CLI/MCP collaboration facade is documented below.

Task creation rejects a public canvas/anchor/scale/resampling mismatch with the existing shared preset as ALIGNMENT_PRESET_CONFLICT; it initializes the public preset only when absent. Roots and offsets stay action-local. Successful non-editor task creation, PNG import and output timing changes invalidate older editor undo snapshots after commit. Failed writes and already-completed identical retries preserve later editor history.

### Fixed private candidates (Task 4 service foundation)

`collaboration/candidates.ts` exposes createPrivateCandidate(request, actor), buildPrivateCandidate(request, signal?, progress?), readCandidate/readCandidateManifest, candidateFilePath and submitCandidate(id, expectedHash, actor). The existing queue injects its narrow scheduler; import queue before scheduling. Requests retain request_key, task/context, original base_content and optional parent. A replay returns the same operation/job/private candidate, without rendering or reselecting history. Missing alignment, missing primary cells or ordered source mapping mismatches reject production. HTTP, MCP and CLI candidate adapters are documented in the production1.2 facade section below.

`checkCandidate(id)` reads every saved PNG and frozen input through the existing Pillow worker. Its appended report binds id, candidate_id, content_hash, manifest_sha256, checked_frame_count, blocking_errors and warnings. Missing/corrupt frames count as attempted but block submission. Candidate paths are root-relative; use candidateFilePath only for registered manifest files, and display the final PNG without applying editor transforms again. The manifest includes raw/mask/RGBA hashes and source dimensions, resolved forward/inverse Canvas matrices, expected step/source coverage, fixed sheet rectangles/pages, compositor source/Pillow identity and all auxiliary file hashes.

Submission requires the exact expected hash, current file integrity, a complete passing technical report, and the actual persisted Task 5 selfcheck described below. Missing, incomplete, empty, stale or inconsistent selfchecks reject SELF_CHECK_REQUIRED. Resubmission of an already submitted candidate does not change task selection.


### Candidate sampling and observation facts (Task 5)

Authenticated maker-capable routes under `/api/v1/collaboration`:

| Route | Input / result |
| --- | --- |
| `GET /candidates/:id/sampling?limit=12` | Saves or replays the one identity-bound SamplingPlan; caller limit is a positive integer. |
| `POST /candidates/:id/observations` | `{plan_hash,observations}`; atomically validates and appends facts, returns the selfcheck. |
| `GET /candidates/:id/selfcheck` | Validated CandidateSelfCheck, or null before the first write. |

Service functions are `getCandidateSamplingPlan`, `recordSampleObservations` and `readCandidateSelfCheck` in collaboration/samplingStore.ts; submitCandidate uses its same authoritative validator. Candidate creation/check/submit CLI and MCP adapters use these same services. New routes trust only getRequestActor, never body actor fields.

Budget is min(12,max(1,floor(N/2)),frozen brief user limit,caller limit). Higher limits cannot raise the formula. B=1 uses the highest risk or first frame; B>=2 retains first and last. At most four new risk frames precede at most eight regular frames (including endpoints). Priorities ascend: repair 0, repair neighbor 100, high/medium/low warning 200/201/202, other frame content change 300. Risk inputs include technical metadata, repair links and the complete Task 6 parent comparison: direct impact has priority 300 and affected neighbors 100. Existing saved plans retain their original risk inputs and sample set. Equal ranks use sequence position; duplicate reasons canonicalize deterministically. Uncovered risks are risk IDs absent from the final selection, separate from selected but unviewed frames.

Regular targets j*T/(R-1) span the complete playback intervals using BigInt rational arithmetic. Exact shared boundaries choose the earlier frame; repeated targets select the nearest unselected interval by exact distance, then earlier sequence position. Plan provenance binds strategy rational-interval-v1, complete manifest SHA256, caller/user limits and canonical risk inputs. A saved plan is immutable: later limits/metadata cannot replace its sample set. Source/Alpha/background changes use the same frame slot.

Observations bind candidate/content/plan/frame hashes, viewed, result (ok/issue/uncertain), nonempty explanation/evidence_source and evidence_candidate_id. The writer defaults the evidence candidate to the current candidate. Reuse requires a viewed=true stored observation in this task's candidate ancestry with the identical frame content hash, original source, result and explanation; preserve the original evidence candidate. Foreign, duplicate, unselected, stale or contradictory facts reject the entire batch. viewed=false requires uncertain. Partial writes stay incomplete; exact replay adds no record, and a conflicting replay rejects OBSERVATION_CONFLICT. Submitted records preserve the complete observation facts and allow identical replay or a refresh of only the current technical_check/blocking_errors. Selfcheck ID, saved plan, observations and all coverage facts stay unchanged; newly recorded technical blockers still reject submission.

CandidateSelfCheck stores id/candidate_id/content_hash/manifest_sha256/plan_hash, observations, completed, the full technical_check report and blocking_errors, viewed_frame_ids, unviewed_frame_ids, reused_frame_ids, issue_frame_ids and uncovered_risks. completed means every selected fact is recorded consistently with the complete technical report, including honest uncertainty or advisory issues; it is not artistic approval. Rerunning a technical check on unchanged frozen content invalidates the old selfcheck until a writer refreshes technical facts while preserving the plan and observations. Technical blockers still prevent submission. No observation updates human review rows or review_revision. Files and manifest identity are verified at plan/observation/read/submit boundaries; these mechanisms cannot prove that a model actually viewed pixels or that unselected frames are visually correct.


### Candidate impact services (Task 6)

`collaboration/impact.ts` exports the pure `compareCandidates(parent, next): ImpactReport`. No transport is added in this task. `changed_frame_ids` records surviving direct content/timing/relative-position changes and changed directed-edge endpoints; `recheck_frame_ids` also includes old/new neighbors, expanded once. Both use next-candidate order. `inheritable_frame_ids` is structural eligibility only; Task 7 must intersect current authentic parent approvals, issue/repair context and revocation state. Neighbor rechecks are excluded even with equal PNGs. `reasons` includes Chinese explanations and removed old IDs; removed IDs never appear in the next review lists. `preset_impacts` identifies the compared action when public canvas/anchor/scale/resampling changes.

`playback_changed` means either changed playback content or required reacceptance; identical playback hashes cannot override mask/input/transform/context impact. Rational timing and same-mode frozen timing requirements compare exactly; known brief changes must correspond to actual source order/timing/alignment. Root interpolation/clamp and offsets remain index-based and use frozen resolved geometry. Pure packing, sampling-limit and origin-only brief differences, or known unchanged mask provenance with a new opaque version label, can retain eligibility. Missing/unknown fields, quality changes, source mapping ambiguity, unresolved context, compositor changes or unprovable lineage conservatively require every next frame. This comparator does not read files or attest byte authenticity: candidate integrity/technical checks remain mandatory.

`collaboration/presetImpact.ts` exports read-only `affectedActionsForPreset(projectId, changedPresetHash): WorkContext[]`. The hash denotes the caller's new public-setting SHA256 (64 lowercase hex characters). Since presets are currently global per project and historical bindings are not independently proven, the service deliberately returns all project actions in idx/id order, including unaligned actions; it does not suppress actions by comparing a possibly stale binding. An unknown project or invalid hash rejects. The caller combines these contexts with the report's preset reason. No historical candidate, approval, task or preset is modified.

### Collaboration review transactions (Task 7)

`GET /api/v1/collaboration/candidates/:id/reviews` returns the shared `ReviewState`: the complete final-frame set, verdict and validity, original operation/actor provenance, explicit inheritance basis, candidate-relevant issues and repair/exception evidence, playback, typed errors, and the currently valid acceptance epoch (`number | null`). The Task's `acceptance_epoch` remains a monotonic nonnull counter. These are separate meanings; a historical candidate never selects itself by being reviewed.

Review writes use `POST /api/v1/collaboration/reviews/{frame,playback,issue,repair,source-exception}` with `{context,patch}`. `context` is `{task_id,candidate_id,base_review_revision,request_key}`; patches are the shared `FrameReviewPatch`, `PlaybackReviewPatch`, `IssuePatch`, `IssueRepairPatch`, and `SourceDefectPatch`. Inheritance uses `/reviews/inheritance` with `{context,parent_candidate_id}`; the server computes actual Task 6 impact. Selection uses `/reviews/selection` with `CandidateSelectionRequest` (`task_id,candidate_id,expected_selected_candidate_id,expected_acceptance_epoch,request_key`). Selection CAS is independent of candidate review CAS and creates no approval. The maker CLI/MCP adapters are documented below; maker capabilities do not expose human approval.

Only the current server-issued reviewer may write frames, playback, issues, source exceptions, inheritance or selection. Maker may read and associate a complete repair. Neither body actor fields nor a remembered request key upgrades authority. Authentication precedes replay. Same business key/input returns its original result before CAS, including after a fresh reviewer session; changed input conflicts (`REQUEST_CONFLICT`), while a new stale key returns `REVIEW_REVISION_CONFLICT` or `TASK_SELECTION_CONFLICT`. Original actor evidence remains in the operation checkpoint. `server:` request keys are reserved.

Repair context belongs to the original issue candidate. It requires same-task descendant lineage and the complete stable issue-frame set; removal or partial mapping rejects. Association records the child's review revision and leaves `repair_linked`. Only fresh explicit child frame confirmations and fresh child playback after association derive `resolved`; inherited/earlier approvals do not. Retargeting and revocation rederive status. A resolved child does not exonerate the original defective parent or a sibling branch. Source exceptions require explicit reviewer scope and reason; they cover only the accepted unchanged frame content and never bypass technical errors. Advisory issues retain frame approval and a valid epoch.

Every candidate requires its own explicit playback, including packing-only changes. Explicit frame inheritance verifies current ancestral approval, equal stable frame/content identities, structural impact and issue/repair exclusions. Original operation/revision/actor/hash evidence is retained. Dependency continues through the current ancestral chain until a fresh independent confirmation on the child; ancestor revocation invalidates dependent acceptance.

Acceptance requires the exact full final-frame ID set, current technical/selfcheck identity and all frozen files, current selected candidate, all valid frame approvals, playback, and no relevant blocker. One immediate transaction writes review revision/evidence, the acceptance snapshot, a new monotonic epoch, and one `claimed` `deliver_candidate` operation. Scheduler injection is invoked after commit; a missing or failed scheduler leaves a durable pending operation. Task 8 owns packaging/queue execution, Task 9 startup reconciliation; this API does not claim either is complete.

`withAcceptedDelivery(request, synchronousCommit)` is the shared final-publication serialization seam. It validates original operation payload/hash, current selection/epoch and latest evidence; advisory revision advancement alone is permitted. Invalid acceptance is durably revoked and cannot revive after bytes or approval return. Published operation/results and files are retained; revocation adds checkpoint evidence and `result.approval_status='withdrawn'`. Consumers must display withdrawn history as history. A new valid acceptance creates a new epoch/operation. Actual new-private maker submission and `startRework` invalidate the previous active reference through this boundary; replaying a submitted candidate does not select it.

Task 7 stage rule: registering a NEW acceptance requires `awaiting_review`. `startRework` remains in rework through reads, advisory writes and successful replay; replay returns the historical operation result without changing current state. An explicit reviewer selection, including the same candidate during rework, performs Task selection/epoch CAS and opens review. New-private maker submission opens review normally. Revalidating an existing valid active acceptance is separate and does not revoke it merely because a private build is in flight.

### Fixed candidate delivery (Task 8)

Human acceptance wakes `queueAcceptedDelivery(operationId)` after the review transaction commits. The existing queue persists the job and operation attempt association together before pumping `deliver_candidate`. `packageAcceptedCandidate(request, signal?, progress?)` copies frozen PNG/sheet bytes and rational timing; it never invokes source composition. Its argument order differs from legacy `exportAssets(payload, progress?, signal?)`.

`GET /api/v1/export/resolve?project_id=…&axis_id=…&format=sequence|png_sequence|spritesheet` returns `data.mode=legacy`, `candidate` with immutable `files[{file,url}]`, or typed `ambiguous` with all `task_ids`. Multiple tasks are never resolved by creation time. A missing frozen format returns `NEW_CANDIDATE_REQUIRED`; acceptance without a committed operation returns `DELIVERY_NOT_COMMITTED`. Sequence downloads the existing full package; spritesheet downloads each exact fixed page. Resolver errors never authorize browser Canvas fallback.

`GET /api/v1/deliveries/:id` reads the original succeeded operation result. `GET /api/v1/deliveries/:id/file?path=…` serves only committed inventoried files after hash verification and returns `X-Approval-Status: approved|withdrawn`. A moved directory without the succeeded operation is not a delivery. Withdrawal retains the succeeded operation, result identity, all package files and history. CLI/MCP discovery uses the production1.2 facade below; current maker export/recipe calls converge through the guarded core and cannot write acceptance.

All old formal collaboration export creation, preparation, execution and publication return `IMMUTABLE_DELIVERY_REQUIRED`, even after acceptance. Explicit drafts retain `DRAFT_NOT_APPROVED` and never create a collaboration publication. Materials, masks, skeletal documents and historical legacy export reads keep their prior role.

The delivery package contains the exact `candidate-manifest.json`, a delivery `manifest.json`, full technical checks and honest sampled/viewed/unviewed/reused/uncovered facts in `quality-report.json`, fixed PNG/sheets/contact sheet, optional fixed-PNG-derived MP4, integration notes and ZIP. The ZIP's `checksums.json` covers payload files, excludes itself and the archive; the operation result stores `archive_sha256` separately. Current approval must be read from the service: historical package approval snapshots do not change after withdrawal.

Delivery integrity also binds generated manifest/QA/checksums bytes to their intended serialization before archive creation. Actual ZIP entries must match the same trusted inventory even if staged loose files were temporarily altered and restored; archive-local checksum agreement alone cannot authorize publication. HTTP contracts are unchanged by this integrity correction.

### Stable operation recovery (Task 9)

`resumeCollaborationOperation(id, actor): Promise<OperationRecord>` requires an actual current authenticated maker or reviewer object. The queue uses the original canonical payload, base and operation ID; attempt jobs are atomically appended before pumping. A committed original result is verified and replayed before checking a later draft revision. Pending changed inputs become `needs_input` with `INPUT_IDENTITY_CONFLICT`; malformed ownership and corrupt artifacts are retained and rejected. Partial delivery packaging uses the previously persisted intended-byte hashes and verifies actual ZIP entries; it never learns expected document hashes from staged files.

`prepareExtractionOperation(payload, {request_key}, actor)` is the internal stable extraction seam for the next adapter task. It retains verified raw/timing checkpoints, GUI copy identities and the main-track/result commit. Existing no-operation extraction calls preserve legacy behavior. `POST /api/v1/jobs/:id/resume` is asynchronous: persisted `operation_id` selects strict recovery and requires current request authentication even when callers omit operation fields. Collaboration-mode jobs without a stable operation cannot silently rebase; old formal exports retain their collaboration guard.

Cancellation is persisted before best-effort abort. A prior domain commit wins late cancellation; explicit cancellation is not revived at startup. A cancelled candidate may continue only after explicit Task rework with the same original content. Delivery revocation remains permanent. Bootstrap acquires the workspace lock before DB loading, pauses the queue, reconciles individual operations and only then starts pumping and imports the listening server. Global lock/DB failure does not publish readiness. Recovery retains every historical attempt and artifact; OS process-crash tests do not certify power-loss durability.



## Production 1.2 maker facade and fixed candidate HTTP adapters

The token-mode MCP whitelist is implemented in `mcp/makerTools.ts`, registered by `mcp/sfs.ts`. `inspect_capabilities` returns its actual names and limits. Implemented tools: `inspect_capabilities`, `create_project`, `create_action`, `inspect_project`, `import_source`, `extract_source`, `import_images`, `submit_pipeline`, `get_job`, `cancel_job`, `list_frames`, `get_frame_artifacts`, `get_review_artifacts`, `edit_mask`, `undo_mask`, `save_alignment`, `set_output_timing`, `create_task`, `inspect_task`, `inspect_action_collaboration`, `create_candidate`, `inspect_candidate`, `check_candidate`, `get_candidate_samples`, `record_sample_observations`, `submit_candidate`, `list_review_issues`, `record_issue_repair`, `compare_candidates`, `start_rework`, `inspect_operation`, `resume_operation`, `cancel_operation`, `cancel_task`, `export_assets`. No maker approval, inheritance, source-exception or `apply_review_patch` tool exists. Legacy review commands require a current reviewer in token mode.

New Task creation freezes `goal:{value:<literal user words>,origin:"user"}` and server-verified `source_identity` (original SHA256 and canonical PNG frame hashes) in the immutable brief. Callers cannot assert a different source digest. Historical briefs remain readable without fabricated intent. New known goal/source changes, and missing historical provenance, require conservative impact/review. `create_task` accepts `{brief,request_key}`; context/source are required. Missing goal, alignment or PNG timing returns one `needs_input` bundle with reasons, recommendations and unchanged resume input/key. Existing draft alignment/timing and deterministic inferred defaults are reused; all source frames, rational source video timing, loop=false, sampling_limit=12, max_texture=1024/gap=0/margin=0 and PNG/sheet/contact/ZIP are defaults. There is no internal LLM. PNG requires confirmed timing. Caller alignment/selection/output fields remain authoritative and validated.

Under `/api/v1/collaboration`, maker routes include `POST /maker/:name` (only the whitelist), `POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/candidates`, `GET /candidates/:id`, `/frames`, `/candidates/:id/frames`, `/candidates/:id/samples`, `/candidates/:id/issues`, `/candidates/:id/review-state`, `POST /candidates/:id/observations`, `/candidates/:id/submit`, `/tasks/:id/rework`, `/operations/:id/resume`, `/operations/:id/cancel`, `/tasks/:id/cancel`, and `GET /operations/:id`. `GET /candidates/:id/file?path=…` uses the immutable manifest whitelist plus byte verification, never arbitrary directory files. `GET /deliveries/:id` and `/deliveries/:id/file?path=…` use committed delivery authority. `POST /action-export/resolve` accepts project_id, axis_id, format and returns explicit task ambiguity. `export_assets` accepts an explicit task_id when needed; it returns an existing committed delivery or its original pending operation, never guesses latest Task or renders current draft. An already committed operation may truthfully return job_id=null.

GUI writes use reviewer-only `POST /candidates/:id/reviews/frame`, `/reviews/playback`, `/reviews/inherit`, `/candidates/:id/issues`, `/issues/:id/accept-source-defect`, `/tasks/:id/selection`. `POST /issues/:id/repair` permits a maker but does not approve. Review bodies carry `{context:{task_id,candidate_id,base_review_revision,request_key},patch}`; inheritance replaces patch with parent_candidate_id; selection uses the separate shared CandidateSelectionRequest CAS. Paths and body scope must agree. Existing flat `/reviews/*` aliases remain. Content and review revisions remain separate.

Frame/issue pages default to32, max300, and return all `items,total,next_cursor,complete,content_token`. Follow next_cursor until complete. Draft cursors bind current content/context; candidate cursors bind immutable candidate content; `ReviewIssuePage` also contains/binds review_revision. Changes return PAGE_CONFLICT. Full manifests, reports, issue arrays and nested frame IDs remain complete on CLI stdout.

CLI adds `action create`, `source extract`, `task create|inspect|cancel`, `candidate create|inspect|samples|observe|submit|compare|check`, `issue list|repair`, `rework start`, `operation inspect|resume|cancel`, `frames list`. Structured input uses `--file`; explicit `--request-key`, `--base-content` JSON, `--base-mask-version`, task/candidate/operation identifiers and cursor/limit override corresponding fields. `import images --project ID --axis ID --directory DIR --file options.json` uses multipart collaborative PNG import (options contain request_key, base_content and confirmed timing); omitting axis preserves legacy import. Offline schema names include task_brief, candidate_manifest, review_issue_page and impact alongside recipe/alignment/manifest. Each command writes one complete JSON result to stdout; diagnostics use stderr. Querying historical failed job/operation is exit0; waiting reports failure. Wait timeout reports original IDs with timed_out=true, cancelled_job=false and never cancels. Stable extract_source/build_candidate/deliver_candidate operations resume original payload/base/key. Collaborative matting has no persistent recovery operation and returns RECOVERY_UNSUPPORTED on resume; capabilities and its HTTP creation result declare this. Explicit operation cancellation differs from Task cancellation (epoch CAS, sticky collaboration mode).

Stdio accepts at most1,048,576 UTF-8 bytes excluding LF or CRLF. A bounded byte buffer discards one oversize line through newline, emits one JSON-RPC error id:null and continues with later lines. It does not parse oversized content or claim a hard process RSS bound. MCP HTTP JSON has a separate1,048,576-byte bound. Inline canonical base64 aggregates at most786,432 ASCII characters across all files (589,824 decoded bytes); larger assets use authenticated HTTP multipart. The Bun listener allows at most134,217,728 bytes (128 MiB) per request, including multipart overhead. SDK2.0.0 is called with the original authenticated Request and `{parsedBody}` so legacy and modern tools receive the same request-scoped current actor. No body role, reconstructed actor, shared last actor or HTTP self-call is used.

New public task creation atomically binds the canonical supplied input to its originally resolved immutable brief in the original create_task operation. Identical input/key replays reuse that brief after draft alignment/timing changes or configuration removal; explicit supplied changes conflict. Current actor and original source bytes are still verified. needs_input consumes no creation key, so an answer bundle can first commit with the same key. Historical records without supplied-input evidence retain their original resolved-payload checks and are never rewritten to invent omitted input.

Task11 final-region contract: reviewer issue `rect` is a finite continuous pixel-edge `[x,y,width,height]`, including fractions. Position must be nonnegative, extents positive, and all edges within the frozen final canvas. The service preserves fractions; invalid/NaN/infinite/out-of-bounds values reject. Authenticated reviewer, request-key replay, review CAS and acceptance invalidation are unchanged. The GUI uses same-origin HttpOnly Cookies and immutable candidate file URLs, with complete issue pagination and conflict refetch; browsing/playback never creates approval.

### Editor collaboration context (production 1.2)

`GET /api/v1/collaboration/action?project_id=…&axis_id=…` and maker tool `inspect_action_collaboration` return the shared `ActionCollaborationState`: `{mode, tasks: CollaborationTask[], timing: TaskBrief["timing"] | null}`. Both validate project/axis ownership and require the current authenticated maker capability (the desktop reviewer includes maker capability). The list is complete; multiple tasks require explicit selection. Cancellation does not remove the action mode. `timing` is the current draft policy, not a guessed candidate policy.

`GET /api/v1/export/resolve` and `POST /api/v1/collaboration/action-export/resolve` accept optional `task_id` to select a known task within the exact action. An unknown or foreign task fails with `TASK_CONTEXT_MISMATCH`; omission retains the existing explicit ambiguity result. Acceptance, fixed formats and committed operation/delivery validation still apply. No live rendering fallback is permitted.

The Editor opens the existing review modal by known Task ID. `start_rework` completes before `DraftEditContext` navigates to the editable copy, preserving task ID, parent candidate ID and returned content token. Manual output policy changes use the existing `/timing` CAS operation. Maker adapters for rework and timing pass `{request_key}` as request identity separately from operation payload fields; CLI, HTTP maker and MCP retain the same content conflict and replay checks. Durable delivery display reads task/review/operation and committed delivery records on mount, review mutations, connection invalidation and a five-second poll; transient job notifications do not establish publication. Historical withdrawn bytes stay readable and carry their withdrawn status.

The historical token-free service still returns401 for `/collaboration/action`; the panel reports this unavailable state without installing an inferred actor. Alignment formal export and browser export share the existing `/export/resolve`, preserving unrelated legacy exports. Resolver authentication, conflict or other errors abort; none is a legacy fallback signal. Inputs reuse the existing strict context schema and outputs use the shared type above; there is no new database schema or review authority.
