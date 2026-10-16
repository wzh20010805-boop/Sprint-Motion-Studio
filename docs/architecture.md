# FrameBaker Architecture

## Overview

Current source production API is **1.3**. CLI, desktop and runtime bootstrap resolve the same selected workspace, and each active workspace owns one authenticated loopback HTTP listener shared by GUI, API, WebSocket and maker MCP. The diagram below retains upstream modules for code navigation; its broad generation/provider/MCP surface is historical and disabled in the normal SFS entry. See [Unified workspace and service lifecycle](#unified-workspace-and-service-lifecycle) for current ownership.

```
                        ┌──────────────────────────────────────────────┐
                        │              Browser (React 19)               │
                        │  TopNav (Projects/Materials/Settings)         │
                        │  ProjectList   Editor ─ FrameEditor(PixiJS)  │
                        │  Timeline(DnD) PlaybackBar    ImportModal     │
                        │  MaterialsPage MaterialModal(comparison/crop) │
                        │  CropModal ─ imageops/ (Web Worker image ops) │
│  JobPanel (right-side persistent job queue, WS-driven)  │
                        │        │ fetch /api        │ WebSocket /ws   │
                        └────────┼───────────────────┼────────────────┘
                                 │                   │
┌────────────────────────────────▼───────────────────▼────────────────┐
│                    Bun.serve (apps/server/src/index.ts)             │
│  routes: "/" "/project/:id" "/materials" "/settings" → HTML import  │
│  fetch:  /ws → server.upgrade ──────► ws.ts (client set broadcast)  │
│          rest → Elysia app (app.ts)                                │
│                                                                     │
│  Elysia /api                                                        │
│   ├─ api/projects.ts   Project CRUD                                 │
│   ├─ api/frames.ts     Frame query/PATCH/replace/delete/dup/reorder │
│   │                    + image stream                               │
│   ├─ api/import.ts     Upload/extract / generate → create job       │
│   │                    (project frames)                             │
│   ├─ api/materials.ts  Material CRUD/matting/batch matting/crop/     │
│   │                    import to project                            │
│   ├─ api/settings.ts   Settings table read/write (layout/theme/     │
│   │                    lang/genProviders/matting allowlist)          │
│   └─ /api/jobs(/:id)   Job list (panel initial load) / single query │
│                                                                     │
│  mcp/ (MCP server: POST /mcp JSON-RPC 2.0 Streamable HTTP)         │
│       48 tools directly operating db/internal modules for AI agents │
│                                                                     │
│  provider.ts (multi-gen provider / matting config: settings > env)  │
│  providerAdapter.ts (generation validation/execution adapter +      │
│                      provider model detection)                      │
│  doctor.ts (health check + API connectivity: /api/doctor            │
│             /api/provider/test)                                     │
│  queue.ts (in-memory queue, concurrency 2; JobTarget = project |   │
│            materials)                                               │
│   ├─ jobs/extract.ts   extract_frames / generate_frames             │
│   │                    ├─ CLI template (jobs/run.ts)                 │
│   │                    ├─ OpenAI-compatible API (jobs/generateApi.ts)│
│   │                    ├─ Video generation (DashScope/MiniMax async  │
│   │                    │   polling → mp4)                           │
│   │                    └─ generatedArtifacts.ts (classify & commit   │
│   │                       frames/materials)                         │
│   └─ jobs/matting.ts   matting (frame | material; engine detection   │
│                        below)                                       │
│                                                                     │
│  db.ts (bun:sqlite, WAL) ── jobs/frames/projects/materials tables   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ read/write (absolute paths via import.meta.dir)
                        ┌───────▼────────┐        ┌────────────┐
                        │ storage/ (root) │        │ ffmpeg/CLI │
                        │ framebaker.db  │        │ external   │
                        │ projects/...   │        │ processes  │
                        │ materials/...  │        └────────────┘
                        └────────────────┘

         packages/shared: front/back shared types & constants (no build, exports point to src/index.ts)
```

## Monorepo Layout (Bun workspaces)

| Package | Path | Description |
| --- | --- | --- |
| `@framebaker/server` | `apps/server` | Elysia API + job queue + SQLite; also serves frontend via Bun fullstack mode |
| `@framebaker/web` | `apps/web` | React 19 + PixiJS v8 frontend, `index.html` as bundle entry, fonts in `public/fonts` |
| `@framebaker/shared` | `packages/shared` | `Frame`/`Project`/`Job`/`Material`/`FramePatch`/enums (FRAME_STATUSES, FRAME_SOURCES, JOB_TYPES, JOB_STATUSES, MATERIAL_STATUSES, GEN_PROVIDER_TYPES, WS_EVENTS) / SOURCE_COLORS / `GenProviderSettings` / `MattingSettings` / API response types |

Root `tsconfig.base.json` provides shared compilerOptions (strict, moduleResolution: bundler, noEmit); each app's `tsconfig.json` extends it and adds its own lib/jsx/types.

Root `scripts/version.ts` implements the `MAJOR.WEEK.BUG` main-release policy and keeps the root/workspace package versions, Bun lockfile workspace versions, MCP-reported version, and bilingual changelog release headings synchronized. The week is a monotonic development-week counter within a major, not an ISO calendar week. Version history lives in `docs/CHANGELOG.md` and `docs/CHANGELOG.zh-CN.md`; policy details live in `docs/VERSIONING.md` and `docs/VERSIONING.zh-CN.md`.

## Key Design

- **HTML import fullstack**: `apps/server/src/index.ts` does `import index from "../../web/index.html"`, `Bun.serve`'s `routes` mounts it at `/` and `/project/:id`; the editor page frontend reads `location.pathname` to restore project context (no router library). In development mode (`NODE_ENV !== "production"`), each request re-bundles with HMR support.
- **storage independent of cwd**: `db.ts` uses `import.meta.dir` to traverse three levels up to find the repo root, `STORAGE_ROOT = <root>/storage`; DB columns `raw_path`/`processed_path` store absolute paths. Running from root `bun dev` or from within `apps/server` both point to the same location.
- **Job queue**: `queue.ts` in-memory FIFO, concurrency limit 2; job status persisted to SQLite (queued/running/done/error/cancelled + progress/error), payloads (staging paths, prompts, etc.) only in memory — unfinished jobs are not recovered after restart; on startup, orphaned queued/running jobs are marked as error ("server restarted, job interrupted"). `POST /api/jobs/:id/cancel` can cancel queued/running jobs (AbortSignal → `runCmd` kills process / API polling interrupted). All state changes broadcast via `ws.ts`; frontend `JobPanel` (right-side persistent panel mounted at App root) shows progress via WS `job_*` events + `GET /api/jobs(/:id)` fallback polling; queued/running can be cancelled. Scheduler dependency is one-way: `queue.ts` calls `jobs/*` workers; matting jobs after extraction/generation are queued via narrow callbacks injected by the scheduler — workers never reverse-depend on queue.
- **WS broadcast**: `ws.ts` maintains a client Set, `broadcast(type, payload)` sends JSON; event names defined centrally in shared `WS_EVENTS`. Frontend on receiving `frame_updated/frames_reordered/frames_changed/job_done` re-fetches frame list; on `material_updated/materials_changed` re-fetches material list.
- **Material source semantics**: image-layer outputs use the shared `layers` source and “Layers” badge rather than the generic `api` source. Startup migration identifies legacy outputs by `metadata.provider=imageLayers` and relabels them.
- **Frame extraction numbering**: ffmpeg extracts to `staging/extract_<uuid>/frame_%04d.png`, then scans the raw directory for the current highest number and renumbers sequentially into `raw/frame_XXXX.png`; multiple imports don't overwrite each other; `duplicate` generates `dup_<uuid>.png` which doesn't match the scan pattern and won't be accidentally collected.
- **Injection safety**: external commands (generation CLI / matting CLI) don't use template strings: settings page configures structured fields (command + parameter name mappings), server assembles argv array (Bun.spawn, no shell); legacy env templates (FRAMEBAKER_GEN_CLI / FRAMEBAKER_MATTING_CLI) are split by whitespace into argv then placeholders are replaced — also no shell, safe even with spaces in prompts.
- **Generation provider resolution** (`provider.ts`, reads settings table in real-time on each call): settings `genProviders` list models — CLI / OpenAI-compatible API / DashScope native / Gemini (banana) / MiniMax can coexist; when list is empty, env `FRAMEBAKER_GEN_CLI` synthesizes an id=`env` CLI provider (legacyTemplate path) as fallback. Generation requests select by `providerId` (default: first fully configured); `type=cli` uses structured argv assembly (`cliBin` + parameter name mappings `cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`; empty name = positional arg or not sent); `type=api`/`dashscope`/`gemini`/`minimax` uses `jobs/generateApi.ts`:
  - api (OpenAI-compatible): no reference image `POST {base}/images/generations` (JSON); with reference image `POST {base}/images/edits` (multipart image+prompt, needs gpt-image series or similar edits-capable models); `data[0].b64_json` or `data[0].url` fetched, 120/180s timeout.
  - dashscope (DashScope native, wan2.7-image / qwen-image etc. not in compatible mode): `POST {base}/api/v1/services/aigc/multimodal-generation/generation`, messages content as `[{image: dataURI}?, {text}]` (reference image uploaded as base64), synchronous response `output.choices[0].message.content[*].image` URL downloaded; `apiSize` supports `2K`/`1K`/`4K` or `width*height`; `apiBaseUrl` normalized via `normalizeDashscopeBaseUrl` stripping `/compatible-mode/v1` and `/api/v1` (Token Plan default `https://token-plan.cn-beijing.maas.aliyuncs.com`, Key `sk-sp-`).
  - gemini (banana / nano-banana): `POST {base}/v1beta/models/{model}:generateContent` (x-goog-api-key), parts `[{text}, {inlineData}?]`; the dedicated response adapter scans all candidates, classifies prompt/output safety and text-only refusals from Gemini metadata, and retries one transient `NO_IMAGE`/`IMAGE_OTHER` result; `apiSize` maps to `imageConfig.aspectRatio`.
  - minimax: image `POST {base}/v1/image_generation` (Bearer), reference image via `subject_reference` (one image limit, subject feature preservation), `response_format=base64`, response takes `data.image_base64[0]`; `apiSize` maps to `aspect_ratio`.
  Model defaults to request `model`, then first item in provider's model list; neither available = job error. `GET /api/config` delivers `gen.providers` and `promptEnhancers` summary (no apiKey; providers carry `video` flag, mapping from shared constant `PROVIDER_VIDEO_SUPPORT`).
- **Video generation** (`generateFrames` with `mediaKind="video"`, only cli/dashscope/minimax): only generates and saves `materials/{id}/raw.mp4` (no frame extraction); extraction via `POST /api/materials/:id/extract` (`fps` full-range or `timestamps` point-extract, single job) → `extract_frames`. CLI/DashScope/MiniMax video protocols as above; polling 5s interval, 10-minute timeout. **In image mode, CLI output detected as video also stored as video material**.
- **Capability layering**: provider connection (Base URL / Key) is separated from model capabilities; models managed by `imageModels` / `videoModels` / `textModels`, default sizes by `imageSize` / `videoSize`. Adapter only selects model from target media capability and validates. Prompt enhancers reuse api/dashscope connections via `providerId + model`; legacy standalone credentials handled by runtime compat layer.
- **Prompt enhancement** (`enhance.ts`): `POST /api/enhance-prompt` calls OpenAI-compatible `chat/completions` from settings `promptEnhancers` list (enhancement system prompt built-in, pixel-art oriented), returns enhanced text; frontend preserves original and shows both side by side for selection.
- **Health check & connectivity test** (`doctor.ts` + `providerAdapter.ts`): `GET /api/doctor` checks storage writable / ffmpeg / matting engine & model cache / each generation provider (CLI checks command existence; OpenAI-compatible, DashScope-compatible, and Gemini send actual model list requests; MiniMax has no lightweight probe endpoint, field validation only) / each enhancer model (sends `GET /models`); `POST /api/provider/test` tests a specific API provider or enhancer model with unsaved form values (8s timeout, 401/403 = auth failure, standard model list verifies model is present).
- **Matting engine detection** (`jobs/matting.ts`, resolved in real-time on each call, visible via `GET /api/config`): a. custom CLI (settings page `matting.cliBin` structured fields take priority, otherwise env `FRAMEBAKER_MATTING_CLI` legacy template `{input}` `{output}` optional `{model}`) → b. `<repo>/.venv-matting` bundled rembg (POSIX: `bin/rembg`, Windows: `Scripts/rembg.exe`; installed by `scripts/setup_matting.sh` / `setup_matting.ps1`: python3 venv + `pip install "rembg[cli,cpu]"`) → c. `rembg` in PATH → d. passthrough copy with install hint in job.progress / response warning. rembg invocation: `rembg i -m <MODEL> in out`, model name from settings page `matting.model` → `FRAMEBAKER_MATTING_MODEL` → default u2net, model cache in `storage/models` (spawn injects `U2NET_HOME`). Frontend upload/generate form "background removal" toggle defaults on; `GET /api/config` drives engine status display.
- **Image processing worker** (`apps/web/src/imageops/`): crop decode / transparent-edge bounding box scan / PNG encode run in Web Worker (OffscreenCanvas). Bun's HTML bundler doesn't handle `new Worker(new URL(...))` — worker script served via server route `GET /imageops/imageOps.worker.js` which `Bun.build`s on demand same-origin; `client.ts` lazy-loads singleton and auto-degrades to main-thread canvas on worker unavailable/error; pure computation (`ops.ts`) shared by both sides.
- **Frame transform geometry** (`apps/web/src/frameGeometry.ts`): centralizes center-anchor, offset, rotation, scale axis-aligned bounding box, fit-to-view, and rotation normalization; Pixi `FrameEditor` and Canvas `export.ts` are two render adapters sharing the same geometric semantics.
- **Import workflow** (`apps/web/src/hooks/useImportWorkflow.ts`): project import and material import share file state transitions, sequential upload, job polling, partial failure, timer cleanup, and completion summary; the two modals only provide their own FormData/API adapters; crop phase handled by `useCropQueue`.
- **Web client boundaries**: `apps/web/src/api.ts` remains the compatibility facade for typed HTTP API methods and shared response types; media URL builders live in `api/mediaUrls.ts`, while the reconnecting application WebSocket client lives in `api/ws.ts`. New transport concerns should be added to their owning module instead of growing the facade.
- **Generation provider adapter & artifact submission**: `providerAdapter.ts` resolves provider in real-time per job, encapsulates config/model/capability validation, CLI argv, API/CLI output dispatch, and doctor's model detection; `jobs/generatedArtifacts.ts` handles artifact allocation, media classification, frame/material/video commit, staging cleanup, broadcast, and auto-matting finalization. `jobs/extract.ts` only coordinates "output → commit"; API vendor protocols remain in `jobs/generateApi.ts`.

## Data Flows

### MCP (AI Agent Calls)

```
AI client → POST /mcp { jsonrpc, method: "initialize" }
  → server returns protocolVersion/capabilities/serverInfo + Mcp-Session-Id
  → client sends notifications/initialized
  → tools/list returns 48 tools
  → tools/call { name, arguments } → direct db ops → returns { content: [{ type:"text", text:JSON }] }
```

`mcp/` tools directly call `db` / `queue.ts` / `providerAdapter.ts` / `enhance.ts` / `doctor.ts`; logic is consistent with corresponding `/api/*` handlers but without HTTP self-calls.

### Import (GIF/MP4/Single Image)

```
Browser FormData → POST /api/import/upload
  → saves to staging/<uuid>/input.<ext>, creates extract_frames job (enqueued)
  → extract.ts: ffmpeg (gif full-frame / mp4 with fps filter / image direct copy)
  → per-frame INSERT frames (status=ready, or matting when autoMatting)
  → autoMatting: each frame re-enqueued as matting job → matting.ts (CLI or passthrough copy as processed)
  → broadcasts frames_changed / job_done → frontend refreshes frame list
```

### Editing

```
Drag Pixi sprite → pointerup → PATCH /api/frames/:id {offset_x, offset_y}
  → SQLite update → broadcasts frame_updated → all clients sync
Toolbar step-adjust scale / rotation / opacity → same PATCH to persist
Attack FX draw mode samples pointer paths into per-stroke color/size/pressure points
  → pointerup PUT /api/tracks/:id/steps/:stepId/effect; empty image cells are valid targets
  → compact live brush preview mirrors Catmull-Rom smoothing and wide-start/narrow-tail multi-layer flame/energy/ink rendering
  → copy/paste duplicates vectors between cells so every step can independently move/scale/rotate/fade them
Replace image → CropModal crops and encodes PNG → POST /api/frames/:id/replace
  → writes to processed slot and cleans up old processed file
Timeline HTML5 DnD → original-grid insertion boundary → CSS-only displacement preview
  → drop a same-track cell: POST /api/tracks/:id/cells/reorder {frameId,beforeStepId?}
  → drop a column header: POST /api/axes/:id/steps/reorder {stepIds}
  → one queued commit → broadcasts timeline_changed; cancel sends no request
```

### Timeline insertion and column movement

`apps/web/src/timelineInsertion.ts` is the pure source of insertion ordering and original-grid hit testing. `Timeline` uses native HTML5 drag events, an insertion line and CSS `translateX` with a 180ms transition; transformed cards never redefine the hit coordinates. A requestAnimationFrame loop scrolls at the horizontal edges and recomputes the boundary. Hover previews only local visual state; Escape or cancellation resets it without persistence. A valid drop invokes one editor action.

Same-track image dragging moves the entire image/independent-effect cell, rotating intervening cells including empty and effect-only cells. `timeline.ts`'s atomic `reorderTrackCells` transaction advances a vacant coordinate and preserves frame/effect IDs, transforms, metadata and original files. Other tracks and shared steps retain their positions and durations; each moved image's compatibility `idx/duration` mirrors its destination step. Production rational durations remain bound to frame IDs, and the independent expected-source selection remains intact. Dropping a top frame-number header instead uses `reorderSteps`: every track and the shared column duration move together. Existing cross-track move/swap and asset-pool copy behavior remain separate.

`Editor` queues both drop paths through `queueTimelineAction`, waits for preceding frame/effect saves and applies an optimistic order with rollback on failure. Project Undo uses the same queue, so Ctrl/Cmd+Z after a drop restores that committed edit in order. Invalid or locked-source cell moves fail without partial changes; a no-op insertion creates no undo entry. The REST route and `reorder_track_cells` MCP tool share the backend operation; API details live in [the timeline contract](api.md#canonical-composited-timeline).

### Animation Export (Pure Frontend, No Server)

```
Fetch all visible timeline cells → createImageBitmap
  → compute one global bounding box for transformed images and vector attack effects
  → bake with imageSmoothing off as either individual transparent PNGs or one horizontal sprite-sheet PNG
  → ZIP images plus <name>.frames.json (file/x/y/w/h/duration, origin and FPS)
```

### Material Library (Material → Matting → Import to Project)

The job queue's extract/generate/matting three job types use `JobTarget` (`{kind:"project"} | {kind:"materials"}`) to differentiate where outputs land; the same ffmpeg/CLI logic serves both targets without code duplication; material-type jobs store empty string in `jobs.project_id`.

```
Upload single image → POST /api/materials/upload → materials/<id>/raw.png direct commit (source=image)
Upload GIF/MP4 → same endpoint → staging temp store → extract_frames(target=materials)
  → ffmpeg frame extraction → one material per frame (name=filename #i, source=extract)
Generate → POST /api/materials/generate → generate_frames(target=materials)
  → providerAdapter per CLI / OpenAI-compatible / DashScope / Gemini / MiniMax output
  → generatedArtifacts classifies and commits image or video material (source=provider type, metadata stores prompt/provider/model/size)
Matting → POST /api/materials/:id/matting → creates matting job, tracked by JobPanel
  → engine detection order see "Key Design"; success produces processed.png, status='matted'
  → no engine: passthrough copy with explanation in job.progress
  → frontend comparison slider views raw vs processed; POST /:id/unmatting deletes processed to restore
  → multi-select materials can POST /api/materials/batch-matting for batch queueing (secondary processing triggered on demand)
Crop → CropModal (frontend worker crops to PNG blob) → POST /api/materials/:id/replace-image
  → overwrites currently displayed image slot (processed ?? raw), broadcasts material_updated
Import → POST /api/materials/:id/import or /batch-import
  → raw / processed slots copied separately as project frames (raw/mat_<frameId>.png, mat_ prefix avoids extraction scan pattern),
    preserving both original and matted result, idx appended to project end, source inherited from material
  → broadcasts frames_changed, open project editor auto-refreshes via WS
```

## Storage Layout

```
storage/
  framebaker.db            # SQLite (WAL): projects / frames / jobs / materials
  projects/<projectId>/
    raw/frame_0000.png ... # extracted/generated originals (dup_<uuid>.png for duplicates, mat_<uuid>.png for material imports)
    processed/<frameId>.png        # matted or replaced image
    processed/<frameId>_replaced.png
  materials/<materialId>/
    raw.png                # material original
    processed.png          # matted output (optional)
  models/u2net.onnx etc.   # rembg model cache (U2NET_HOME, auto-downloaded on first matting)
  staging/<jobId>/         # upload staging (cleaned after job completion)
  staging/extract_<uuid>/  # extraction staging (cleaned after completion)
```

Database tables (`apps/server/src/db.ts`, created on startup with CREATE TABLE IF NOT EXISTS):

- `projects(id, name, folder_id, created_at)`
- `frames(id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe, offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)`
- Canonical animation model: `animation_axes(project_id, idx, fps)` → `animation_tracks(axis_id, idx, visible, locked, is_primary)` plus shared `animation_steps(axis_id, idx, duration)`; `frames.track_id + step_id` is a unique composited cell coordinate. Legacy `frames.idx/duration` remain synchronized mirrors.
- Startup migration is transactional/idempotent: every historical or empty project gets `Default` (8 fps) / `Main`; historical frames become one deterministic step each ordered by `idx,id`, preserving frame IDs, files, transforms, order, and durations. `frames.is_asset` separates reusable left-panel assets from timeline instances. Dragging an asset creates an instance without consuming the source; same-track cell dragging inserts and shifts, while cross-track dragging retains the existing move/swap behavior.
- `jobs(id, project_id, type, status, progress, error, created_at)`
- `materials(id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at)`
- `folders(id, kind, parent_id, name, sort, created_at)`: multi-level directories for materials/projects (kind=`material`|`project`)
- `settings(key, value, updated_at)`: UI preferences (layout / theme / lang) and runtime config (genProvider / matting), server-side authoritative persistence; theme and language use frontend localStorage only as first-paint cache, load order: "local renders immediately → server value overwrites"; writes are dual-written (layout PUT debounced ~500ms); silently degrades offline

## Frontend Pages & Components

- `App.tsx`: `/` project list ↔ `/project/:id` editor ↔ `/materials` material library ↔ `/settings` settings page (history.pushState + popstate); globally suppresses browser native context menu (preserves input/textarea for paste; frames use custom ContextMenu)
- `TopNav`: primary nav (Projects / Materials / Settings) + theme toggle (three-state: follow system / light / dark) + language toggle (zh/en, `LangToggle`); editor page has its own top bar and doesn't show this
- `SettingsPage`: generation provider list management (CLI / API multiple coexisting, add/remove/edit + save + API test connection), matting config (CLI template / default model datalist + cache status), doctor (health check result list)
- `ProjectList`: pixel card grid (motion stagger entrance, hover lift), new/delete modals
- `MaterialsPage`: material library page — left directory tree (`FolderTree`) + right card grid (source color badge per provider, bottom-left "matted" badge, checkbox + Cmd/Shift multi-select, drag into folders), batch bar (delete / import to project / batch matting raw-only / cancel)
- `ProjectList`: project list same left-tree-right-grid layout, new projects land in current folder
- `FolderTree`: All / Ungrouped + multi-level folder CRUD / HTML5 DnD
- `MaterialModal`: material detail — raw/matted comparison slider (pointer drag clip ratio), matting/restore, crop (CropModal, operates on currently displayed image slot), grid split (GridSplitModal: multi-cell sprite sheet split by rows × columns into individual materials, grid line preview, reuses imageops cropImage + `/api/materials/upload` single-image commit, original preserved), multi-action generation (ActionGenModal: uses current material as reference image, per shared `ACTION_PRESETS` action presets calls `/api/materials/generate` per action, optional `name` as "material_action" naming, one generation job per action), import to project (select project + copy count), delete (confirmation)
- `MaterialImportModal` / `ProjectPickerModal`: material upload & generation entry / project selection modal; upload tab after file selection asks "crop needed?" (`useCropQueue` per-image queue or single re-crop, static images only); generation tab uses `ProviderModelPicker` to select provider + model, submit closes window (same as ImportModal, progress via JobPanel)
- `ProviderModelPicker`: shared provider + model selection for generation dialogs (`GET /api/config`'s `gen.providers` driven; api=model dropdown/input, cli=`{model}` placeholder value), `resolveProviderSelection` resolves defaults at submission time
- `CropModal` + `imageops/` + `hooks/useCropQueue`: pixel-art crop tool — integer-pixel selection (drag / 8-way resize / numeric input), scroll-wheel zoom, pixel grid (zoom≥8), auto-select non-transparent area; heavy lifting in Web Worker, falls back to main thread; shared by both import modals, material detail, and project frame replace — all output PNG
- `Editor`: state hub (frames/activeId/selectedIds/image version counter v), WS subscription refresh; frame multi-select and batch operations (BatchBar)
- `FrameList`: vertical frame list, left border color = shared `SOURCE_COLORS[source]` (light theme color-mix darkened); frame item right-click triggers context menu (onContextMenu bubbles up to Editor)
- `FrameEditor`: PixiJS `Application` (async init + cancelled race handling); viewport centered zoom; main sprite drag to change offset; onion skin (prev red 0.3 / next blue 0.2); grid Graphics; canvas background and grid color follow theme (CSS variables); toolbar adjusts scale (10% step) / rotation (15° step) / opacity (10% step), plus crop replace / duration ± / keyframe
- `Timeline` + `timelineInsertion.ts`: native HTML5 DnD for same-track cell insertion and whole-column movement, original-grid hit testing, an insertion line, CSS displacement preview and edge autoscroll; frame item right-click triggers context menu (same as FrameList).
- `ContextMenu`: generic context menu — fixed positioned at cursor, auto-collapses at viewport right/bottom edges, closes on Esc / outside click / scroll / blur; click item closes menu then executes; in editor right-clicking an unselected frame = sets it as current frame and shows single-frame menu (keyframe / duration ±1 / crop / duplicate / delete); right-clicking within multi-selection = preserves selection and shows batch menu (duplicate / trim transparent edges / delete, reuses BatchBar handlers)
- `PlaybackBar` + `FrameEditor` playback mode: 1–24 fps tick, each frame stays for `duration` ticks; directly reuses Pixi transform rendering
- `ImportModal`: Material Library / Upload Files / CLI Generate three tabs — Material Library tab grid-selects materials then `batch-import` into current project (primary workflow), top search box filters locally by material name/prompt (doesn't affect already selected); Upload tab distributes multiple files one by one, after file selection asks "crop needed?" (shares useCropQueue + CropModal with material import), after submit polls `/api/jobs/:id` in-modal for summary; Generate tab submit closes window (non-blocking wait), progress via JobPanel; Generate tab supports "Image / Video" toggle (video mode: fps extraction slider, `ProviderModelPicker` only lists video-capable providers, hides count/reference/size)
- `JobPanel` (mounted at App root): right-side persistent job queue panel — initial `GET /api/jobs` takes over in-progress jobs, then WS `job_*` events drive + active jobs 3s polling fallback; queued/running can be cancelled; completed/cancelled stay 6s then auto-remove; failed ones persist and can be manually dismissed; renders nothing when no jobs
- `SplitDivider` + `layout.ts`: editor layout split dividers (frame list width 180–480 default 240, timeline height 80–320 default 140), pointer capture drag, double-click to reset, sizes stored in localStorage `framebaker-layout`; canvas area relies on Pixi `resizeTo` (ResizeObserver) to auto-follow and redraw
- `theme.ts`: theme management (localStorage `framebaker-theme`; when no stored preference follows system prefers-color-scheme and responds to system changes in real-time)
- `i18n.ts` + `i18n/zh.ts` / `i18n/en.ts`: interface language (zh default / en); copy uses stable keys (e.g., `common.close`), `t(key)` / `useT()` looks up table; localStorage `framebaker-lang` + settings `lang`
- `notice.ts` + `AppModals` (mounted at App root): global notification bar and confirmation modal, replacing browser default `alert`/`confirm` — any component calls `notify(text)` / `await askConfirm(text)`, browser default dialogs are forbidden
- `api.ts`: typed fetch wrapper and compatibility facade; `api/mediaUrls.ts` owns frame/material URL construction and `api/ws.ts` owns the WebSocket client (3s reconnect on disconnect)
# Soldier Frame Studio P1 additions

Retain upstream React/Pixi → Bun/Elysia → SQLite. `apps/cli` calls the shared HTTP service; the Electron development host opens the existing GUI with a local cookie. `runtimeBootstrap.ts` obtains the workspace lock before dynamically loading SQLite. `runtime.ts` owns lock ownership; `localSessions.ts` owns request authentication. Both clients discover the same `.sfs/service.json` rather than opening separate business writers.

Early P1 selected runtime storage through SFS_WORKSPACE and used upstream storage as a compatibility fallback. Current source shares the persisted workspace selection described below, with workspaces/default as its unselected fallback; historical storage remains available explicitly. VACUUM INTO makes a WAL-consistent backup before migrations. Schema3 adds sources, exact source-frame timing, clips mapped to existing axes/main tracks, project revisions and persisted job payload/results. Dependencies flow queue → pipeline/service → probe/extractAll.

Immutable source video/PNG/timing and editable project copies are separate. Unique staging is validated for count, integer indices, dimensions and complete PNG decode before publication; a final revision check and transaction project frames into the main track. Cache reuse validates timing and PNGs again. Cancellation, errors and stale results cannot commit apparently complete frames. Integer PTS are strings; rational arithmetic uses BigInt and safe JSON integers.

P1 stores complete raw frames/timing only. Matting, ground references, game canvas and Cocos delivery remain later phases. VFR preview ticks may be quantized with warnings; timing.json stays authoritative. Restart leftovers become interrupted with preserved payload/intermediates. Electron retains strict CSP by serving the installed Pixi compatibility polyfill that avoids dynamic code generation.
# SFS collaboration foundation (Task 1)

The human–AI workflow foundation adds shared contracts in `packages/shared/src/pipeline/collaboration.ts` and offline JSON schemas in `collaborationSchemas.ts`. Schema 5 preserves WAL-backed migration snapshots and legacy approvals without promoting them to candidate approval. `pipeline/collaboration/store.ts` stores immutable versioned briefs and persistent axis workflow mode; `operations.ts` claims canonical payload identities and durable checkpoints in SQLite transactions. Candidate content tables are separate from mutable checks and reviewer appendices. Production fields advance `projects.content_revision`; reviews, names, tags and lock state do not. This foundation does not yet expose collaboration HTTP, CLI, MCP or GUI operations; capability handshake remains 1.1 until the session/authentication task.

# SFS P2 additions

The worker selects connected background-color removal when borders are opaque and 98% of border samples are within 12 RGB channel values of their median. Background candidates within distance 20 are removed only when connected to the outer border; distances 5–20 keep soft edges. Other scenes use CPU Rembg. Background-only regions and almost invisible results fail the entire batch before publishing heads. Reports record the method and visible foreground fraction. Windows workers emit UTF-8 diagnostics.

`pipeline/masks.ts` owns immutable mask revisions, atomic head publication, source fingerprint checks and review state; `masksApi.ts` is the shared GUI/CLI facade. Queue dependency remains one-way: queue → mask service → Python worker. `workers/image/worker.py` builds one CPU Rembg session per action, composes original RGBA with grayscale masks, and never implicitly downloads. Database schema 4 adds `mask_versions` and `mask_heads`, with consistent pre-migration backup; existing schema 3 revision triggers remain intact. `MaskWorkshop.tsx` renders the current frame, draws in source coordinates and saves via the same API. `candy.css` supplies unified saturated sticker styling, with an original CSS-variable SVG `CandyDoodle`. Upstream copyright and resources remain preserved. See [P2 guide](p2-guide.md).
## SFS P3–P5 additions

`workers/image/compose.py` is the single Pillow compositor for alignment previews, bounds checks, PNG sequences and grid pages: q=s*(p-r)+c+d, source top-left pixel-edge coordinates, fixed/interpolated ground roots, shared character scale/canvas/anchor, frame offsets. Cartoon scaling uses premultiplied-alpha filtering followed by straight-alpha output. No automatic per-frame shrink, trim, rotation or deduplication.

`pipeline/alignment.ts` stores character presets and per-axis roots in settings, advances project revisions and records explicit approval fingerprints. `pipeline/export.ts` snapshots primary-track inputs, writes new staging outputs, generates manifest/checksums/contact/video/ZIP, rechecks revision and file hashes then publishes an immutable directory. `pipeline/images.ts` retains full original PNGs and imported alpha with editable, unreviewed mask versions. `recipe.ts` validates offline schemas and submits only the next incomplete stage; matting stops for human review. Matting caches are scoped per project and verify all output hashes; preview requests share bounded in-flight work.

`AlignmentWorkshop` renders source and backend composition together; `FrameEditor` retains active textures plus an eight-entry recent cache, while the timeline uses lazy 128px thumbnails. GUI production exports and CLI/MCP use the same persistent queue. `production.ts`, `mcpBridge.ts` and `mcp/sfs.ts` provide complete structured stdout, bounded leased stdio transport and the maker-only whitelist.

Before evicting a frame texture, `FrameEditor` detaches every referencing sprite, including hidden onion skins. Loading waits for a pending unload of the same URL; stale load failures cannot change the current scene. Onion skins become visible only with the matching frame identity and a live texture/source. `scripts/verify_editor_undo_canvas.ts` checks repeated native Undo, delayed loads, real texture eviction and continued image/grid rendering.

`apps/desktop/main.cjs` is the standalone Electron host: single instance, authenticated cookie, contextIsolation/sandbox, denied external navigation/permissions, local CSP/assets, explicit optional model download/import, writable per-user workspace, close/cancel/background choice. `distribution.ts` resolves sibling runtime paths without developer locations. `build_portable.ts` packages compiled CLI/service, pinned Electron, isolated Python, FFmpeg, workers/assets/notices/dependency inventory/SHA256. `verify_portable.ts` exercises a relocated package with only Windows system PATH; it does not claim a clean VM acceptance.

Version 1.0.1 applies frame-center editing before alignment: F(p)=C+kR(p-C)+o, then q=s(F(p)-r)+c+d. Editor offsets o are source pixels; alignment offsets d are output pixels. The same affine matrix drives Pillow preview, bounds and export; opacity multiplies the rendered Alpha. Transform values are part of the immutable snapshot, preview cache key and approval fingerprint. Zero scale/opacity or foreground disappearing during resampling yields an empty frame; negative uniform scale follows the editor. Atlas packing never rotates cells automatically.

Imported/manual PNG inspection uses actual nonzero RGBA alpha without requiring an opaque core; automatic matting retains its strict low-confidence guard. Imported 1.0.0 metadata is normalized in read responses without rewriting files or approval state. GUI foreground checks multiply original Alpha by the mask. Runtime API 1.1 rejects reuse of the old backend so corrected clients cannot silently execute old rendering logic.

The saturated candy home PNG lives in apps/web/public/art. CandyDoodle uses a fixed same-origin URL; packaging copies it into runtime/assets/art for offline delivery without changing personal materials or workspace selection.

### Local desktop capability bootstrap

`localSessions.ts` has no DB dependency and binds authenticated ActorContext values to Request objects through a server-owned WeakMap. `desktopReviewBroker.ts` owns bounded newline-delimited pipe frames (4096 bytes,3-second connection timeout), PID-bound nonces and current-instance cleanup. The workspace lock precedes both broker and DB import. On Windows the empty bootstrap descriptor receives a protected DACL allowing only its current owner SID and SYSTEM; actual owner/ACEs are checked before a secret is written. The service descriptor remains maker-only; no reviewer cookie is persisted there. Pipe access has no separately configured DACL, so this design does not claim cross-user pipe isolation or protection against malicious processes of the same OS user.

Both desktop hosts share `apps/desktop/review-bootstrap.cjs`. The production host and the probe's shared-service branch use the same persisted workspace-hash Electron session for cookies, BrowserWindow, webRequest and permission handlers; every launch refreshes review authority through the live-instance handshake. Persisting the workspace partition preserves its local UI state while avoiding cookie collisions between workspaces. The old owned P0 snapshot probe retains its preexisting purpose and receives no reviewer capability. Renderer sandbox, context isolation and disabled Node integration remain required.

Collaboration draft preparation lives in `pipeline/collaboration/drafts.ts`; the independent source selection and frame-bound rational output timing are stored by `timing.ts` in axis-scoped settings. Typed PNG source manifests reside in the existing sources.probe_json, with canonical source frames and separate editable copies; video source_frames retain their exact NOT NULL PTS constraints. `collaborationApi.ts` is the server-authenticated transport adapter. Shared timeline duration edits materialize explicit timing; queue completion uses verified per-job task/axis context. Draft identity hashes current source/raw/mask/RGBA bytes, order, timing, transforms and the effective shared alignment preset, excluding review appendices and legacy revision counters.

### Immutable candidate production

Task 4 adds collaboration/candidates.ts, candidateIdentity.ts and checks.ts, plus workers/image/candidate_checks.py. Composition remains compose.py through runImageWorker and the existing queue. Each attempt copies raw/mask/RGBA into isolated staging, renders the full PNG sequence and fixed atlas once, then freezes its complete canonical manifest. Forward and inverse matrices share Canvas [a,b,c,d,tx,ty], x'=a*x+c*y+tx and y'=b*x+d*y+ty; singular mappings are null with a reason. Roots retain index interpolation. manifest_json is authoritative; candidate_frames remains its existing immutable projection without a table rebuild.

Versioned canonical projections separate whole-candidate identity from frame identity (actual four byte hashes, stable IDs, dimensions, effective spatial/render context) and playback identity (ordered IDs/PNG/rational timing/canvas/loop). Packing, paths, candidate IDs, opaque mask version IDs and timing/order metadata do not enter frame identity. Full provenance stays in the whole manifest, and every new candidate needs fresh technical checks.

The queue writes job plus operation-attempt association in one immediate transaction before pumping. Operation input is read from its original canonical payload and checked by kind/hash. CandidateCheckpoint v1 records freezing/prepared/committed phase, operation/candidate/attempt/job IDs, original base, staging/final paths, manifest/content hashes and complete frozen file inventory. prepared is persisted before rename; candidate, frames, committed checkpoint and operation result share one short synchronous transaction after file/base verification. Precommit abort blocks registration; postcommit abort retains the private candidate. Failed staging/renamed uncommitted directories are evidence, never publication; Task 9 owns process-crash reconciliation. Service serialization is not a power-loss/fsync or arbitrary-external-writer guarantee.

Task 4 concurrency refinement: task recovery_json.candidate_operation stores version 1, operation_id, selected_candidate_id and acceptance_epoch for the latest newly-associated build request. Existing queued attempts do not reclaim ownership when they start. Each final commit merges the transaction's current operation history; only the owner with unchanged selected candidate/acceptance epoch and state producing may update the task stage. Older attempts still retain their own candidate/result/error. Submission clears that ownership entry, preserving other recovery metadata. This is a narrow lifecycle CAS, not a new queue or coordinator.


### Deterministic sampling and persisted selfcheck

Task 5's collaboration/sampling.ts is a pure selector, using BigInt rational playback intervals and canonical risk ranks. It has no DB or image-worker dependency. collaboration/samplingStore.ts owns the existing candidates.sampling_plan_json and self_check_json appendices. It derives hints from full technical checks, repair links and Task 6 full candidate impact (including temporal and spatial neighbors). Shared SamplingPlan/SampleObservation/CandidateSelfCheck types bind immutable candidate and frame bytes plus strategy/limits/provenance. No parallel table, model, image queue or human approval is introduced.

The saved plan is established once per candidate under an immediate SQLite transaction. The same selfcheck writer/reader validates observation identity, atomic batches, immutable replay, ancestry and authentic stored viewed evidence; submitCandidate calls that authority. Completion records all selected facts and the full technical report with observed/unobserved/reused/issue/uncovered distinctions. Same-identity technical rechecks can refresh technical facts without replacing samples or observations; stale selfchecks cannot submit. Candidate task ownership CAS, recovery metadata, operation histories and all source/staging files remain owned by the existing lifecycle. collaborationApi exposes authenticated sampling/observations/selfcheck transports; the current production1.3 CLI/MCP facade uses these services.


### Candidate dependency impact

Task 6 separates pure `collaboration/impact.ts` from read-only DB enumeration in `collaboration/presetImpact.ts`. The comparator validates the strict frozen manifest contract and stable source/coverage/root context, then compares effective frame inputs and geometry, exact rational duration, relative order and old/new directed edges. Content changes expand neighbors once; changed edge endpoints do not recursively expand. Relative order also detects cyclic rotations whose edge sets match. Public preset changes cover the complete compared action; the separate service enumerates every action of that project, including unknown bindings. No multi-preset subscription model is introduced.

The existing ImpactReport contract distinguishes structural eligibility from actual approval. Preset, unknown requirement/provenance/geometry and compositor changes fail conservatively; removed IDs remain explained. The comparator has no DB, queue or file IO dependency and never transfers candidate acceptance. samplingStore uses the report only when deriving a new candidate's initial bounded risk plan; existing plans, observations, technical checks and review facts retain their existing authority. TS/Pillow interpolation and composition remain unchanged.

### Review and acceptance boundary

`collaboration/reviews.ts` owns current reviewer authorization, independent candidate review CAS and Task selection CAS, durable operation receipts, explicit frame inheritance, repair derivation, shared typed read state and acceptance eligibility. `reviewBoundary.ts` owns the synchronous immediate transaction seam and invalidation of the Task's current operation reference. `candidates.submitCandidate` and `drafts.startRework` use that invalidation seam without importing the review engine or the queue. No tables, event platform or auth provider were added.

The immutable `deliver_candidate` operation input is `DeliveryOperationInput`, including `AcceptanceSnapshot`. Its scheduling envelope adds `operation_id`; the original payload has no circular operation-ID hash. `AcceptanceCheckpoint` preserves the snapshot and permanent `revocation`. `recovery_json.acceptance` is only the current `DeliveryRequest` reference. Other recovery metadata and all operation history survive. Task 8 may extend checkpoints/results but must retain these acceptance fields and use `withAcceptedDelivery` for synchronous publication; it must not await packaging inside SQLite. A succeeded publication result retains its content and gains `approval_status='withdrawn'` on later revocation. Task 9 resumes original operations, never reconstructs authorization from current drafts or directory existence. `setDeliveryScheduler` is a narrow post-commit injected callback, not a second queue.

Read state validates stored operation receipts as well as mutable review rows. Repair association checkpoints record the child revision barrier; only later explicit frame and playback facts resolve issues. Inheritance stores parent/original receipts and content/impact identities, and current ancestor changes can invalidate dependent selection. There is no artificial AI-to-human approval conversion. Tests use isolated synthetic images and server-issued test reviewer sessions solely to exercise contracts; no actual artistic acceptance is claimed.

Review stage is part of new-acceptance authorization: reconciliation preserves an existing valid operation first, then permits a new epoch only in awaiting_review. Explicit reviewer selection reopens a closed review stage even for the same candidate, retaining Task CAS and candidate-operation owner metadata. Read/advisory/replay cannot end rework.

### Task 8 delivery boundary

`collaboration/delivery.ts` reads kind/hash/base-verified `DeliveryOperationInput` from the original operation. Stable delivery ID equals operation ID. `AcceptanceCheckpoint` retains the immutable snapshot/permanent revocation and adds a typed `delivery` checkpoint (packaging/prepared/committed, attempt/job, staging/final paths, original hashes, complete inventory). The original operation's succeeded `DeliveryResult` is the only new publication authority; settings, job status and directory presence do not replace it.

Slow copying/archive/optional FFmpeg work occurs outside SQLite. Prepared inventory is persisted before moving. Final candidate and staging hashes, latest approval/selection/epoch/issues/checks, move and synchronous publication use Task 7 `withAcceptedDelivery`; permanent invalidation is committed before its error is thrown. A moved-but-uncommitted directory remains evidence for Task 9. Commit wins over late cancellation or job-result failure. Actual startup/OS-exit recovery belongs to Task 9.

The queue injects Task 7's aftercommit scheduler and atomically associates each job before pump. Workers never import queue. Browser `exportAnimation` resolves durable `timeline.axis` context before image access; exact candidate files bypass decode/Canvas/crop/repack. `Editor` already owns loading/error/finally handling and needs no duplicate guard. The narrow read/download HTTP adapter shares delivery core; the maker facade shares this delivery authority.

Task 8 fix01 stores hashes of intended generated UTF-8 document bytes as they are written, including canonical checksums.json and ffconcat text. `packaging` checkpoints persist that expected inventory before asynchronous auxiliary/archive work; it is not a new hash scan after archive creation and may be partial before auxiliary completion. The existing image worker adds `verify_archive` with `{directory, files: Record<relativePath,sha256>}`. It checks exact ZIP entry names without duplicates/extras, every inner digest and an unchanged archive digest across verification, returning `{archive_sha256,files}`. Delivery compares the returned inventory with its trusted expected inventory, then keeps final staged-file checks and the shared review transaction. Task9 must verify ZIP contents against the retained expected inventory before promotion; merely restored loose files or ZIP-internal checksums are insufficient.

Task 9 recovery keeps `queue → collaboration workers` one-way through an injected operation scheduler. `collaboration/extraction.ts` binds explicit stable requests to source hashes, original probe/base, retained raw/timing inventory, predetermined GUI frame/step IDs and an atomic original result. Candidate and delivery recovery consume existing typed prepared checkpoints and original operation identities. Existing source extraction remains legacy unless explicitly operation-backed. `runtimeBootstrap.ts` reconciles with the queue paused before importing `index.ts`, so no listening/write window exists during reconciliation. Per-operation conflicts require input without preventing unrelated valid work; global DB/lock failures stop startup. Cancellation and domain publication share synchronous transaction boundaries, and historical successful commits remain authoritative after later edits or withdrawals. Actual process-exit fixtures retain evidence and allow at most two normal recovery executions per case.


Task10 facade: mcp/makerTools owns the narrow schema/dispatch registry shared with CLI HTTP; it calls existing typed services directly. mcp/request binds the original authenticated Request and bounded parsed body to SDK2.0.0, including legacy transport. CLI byteLines bounds/discards raw UTF8 lines; complete typed values bypass legacy summaries. collaboration/{brief,creation,pages,cancellation} verify immutable literal intent/source bytes, supply deterministic defaults, bind content/review pagination and distinguish operation/Task cancellation. Stable original-operation recovery remains Task9; collaborative matting is explicitly unsupported for resume. Reviewer-only nested routes use existing review/selection CAS. Current maker surface and production API are1.3; prior foundation-only/nine-tool descriptions above are historical. Source-run integration remains awaiting_review; it provides no human/artistic acceptance.

Task11 adds an independent `CandidateReviewWorkspace` and Canvas2D `CandidateReviewCanvas`. Frozen final PNG pixels never pass through FrameEditor or live transforms. Each canvas owns one decoded ImageBitmap and an abortable pending request; generation guards handle stale successes/errors and release only owned resources. Native pixel canvas plus CSS viewport pan/zoom/letterbox preserves final pixel-edge mapping across DPR. `candidatePlayback` uses exact BigInt rational half-open intervals, and `candidateReviewGeometry` maps all four issue corners using validated frozen inverse matrices; unavailable/clipped/mismatched source mapping retains the final issue. `candidateReviewApi` carries typed shared records and Cookie-authenticated CAS writes. The workspace requires explicit final-frame and playback review, shows provenance/parent impact/issues, and refetches durable operations on mutations, WS activity, focus/online and bounded polling. Task12 owns integration into existing editor entry points.

Editor integration: `collaboration/editor.ts` provides the narrow read-only action context query over the existing task and draft timing stores. Shared `ActionCollaborationState` and `DraftEditContext` connect `CollaborationPanel` and the local `CandidateReviewWorkspace` modal to the existing Editor. The workspace alone starts rework before returning lineage; FrameEditor, MaskWorkshop and AlignmentWorkshop keep their existing manual behavior. `CollaborationPanel` owns persistent service reads, independent of JobPanel notification expiry, and subscribes to WS connection invalidation plus a five-second polling fallback. Formal animation export still uses the Task8 resolver and fixed files.

## Unified workspace and service lifecycle

The source desktop installs its visible workspace menu through `probes/desktop/workspace-menu.cjs`. `workspace-cli.cjs` clears inherited service identity, project routes and profile/evidence environment before opening an explicit target through the existing CLI and persisting the selection. A new window uses its own reviewer session and opens the project list; the original window retains its actual workspace, edits and background jobs without stopping the shared service. `apps/cli/src/workspaces.ts` remains the sole workspace resolver.

`packages/shared/src/pipeline/productionVersion.json` is the single production-handshake version source for shared TypeScript and the desktop helper. Portable builds copy it unchanged to resources/app. Existing directory aliases and Windows case variants are compared as one physical workspace. Registry load/modify/save is protected by an exclusive write lock; contention returns `WORKSPACE_REGISTRY_LOCKED`, and unknown locks are retained. Informational list entries have `registered:false` and never reuse a registered name.

`apps/cli/src/workspaces.ts` is the shared resolver for CLI and `runtimeBootstrap.ts`; the desktop asks the CLI for its current workspace and persists selections through `workspace use`. Precedence is explicit `--workspace`, `SFS_WORKSPACE`, registry current selection, then the canonical default. Source runs store the registry at `<repo>/.sfs/workspaces.json` and use `<repo>/workspaces/default`; the 1.0.8 portable distribution stores it at `%LOCALAPPDATA%/SpriteMotionStudio/workspaces.json` and use the adjacent `workspaces/default`. Registry writes replace a temporary file atomically, deduplicate canonical paths and names, and require existing directories when registering/selecting. Selection changes discovery, not database locations or immutable file lineage.

`workspace list/current/add/use` and `service status/stop/clean` are local management commands; listing/status never launch a backend or expose its token. The source `start` and `dev` scripts enter the same lock-before-DB bootstrap. The default `PORT=0` allocates one loopback listener per active workspace, shared by GUI, API, `/ws` and `/mcp`; stdio MCP forwards to it rather than listening on another port. `localSessions.ts` remains the sole request identity authority. The desktop review pipe remains separate because it grants human reviewer sessions, whereas the public service descriptor grants maker authority only.

`POST /api/v1/runtime/stop` authenticates the caller, checks queued/running jobs, concurrent HTTP requests and WebSocket clients synchronously, and returns `409 WORKSPACE_BUSY` when busy. On `202`, the shutdown guard blocks new requests with `503 SERVICE_STOPPING`, then closes cooperatively after 25 ms; instance cleanup runs through the existing exit handler. CLI stop verifies health, instance ownership and jobs, requests this endpoint and waits up to five seconds; it never kills an external PID. `service clean` holds the recovery exclusion lock and removes only known dead, matching service owners and matching `before-human-desktop` discovery backups. Active, corrupt or ambiguous ownership remains blocked. Logs, SQLite, sources, candidates, review history and failed staging are retained.

Production API **1.3** removes the seven unscoped review write aliases and duplicate candidate review read route in favor of scoped candidate/issue/Task routes. GUI and maker adapters retain their existing authority and CAS contracts; incompatible running services are rejected rather than force-stopped. Portable 1.0.8 includes these changes; the older 1.0.7/API1.1 download remains available. See [workspace/service commands and API migration](api.md#workspace-and-service-management-api13).

## Unified editing commands

`apps/web/src/editingCommandStore.ts` serializes Save/Undo for the active editing context. `editingCommands.ts` binds React workbenches and keyboard shortcuts; `EditCommandBar` is reused by navigation, frame and skeletal headers and active modal controls. A scope ref, actual DOM visibility and modal stacking isolate nested workbenches from their parent. Native text undo stays in inputs. Unsupported contexts disable commands rather than forwarding them to a project snapshot.

Each workbench owns its real save and history. Material, crop, color-key, skeleton and binding drafts retain local history and dirty state; persisted clip, skeletal-document, alignment and settings undo uses its existing API. `settingsEditHistory.ts` tracks five independent settings groups, preserves original raw values only in memory and records successful groups during partial failures. `useReversibleEdits` handles bounded metadata inverses, checking current values before restoring them. Reviews, acceptance, immutable delivery, jobs and permanent library/project deletion do not become database rollback operations.

`persistence.ts` tracks HTTP writes, scoped failures and versions. Save waits for relevant writes, retries retained autosave changes and reports unresolved failures. Manual image replacement is never blindly retried by a different page. Explicit cancellation, successful UI rollback and entity deletion discard the corresponding failed intention and invalidate late failures. A manually saved draft undone locally stays dirty until explicitly saved again.

D uses the opt-in `clearFramePlacement(frameId, true)` transaction: unbind a placed asset or remove its instance record, prune its shared step only when every track has no image or independent effect, then synchronize indices. `pruneEmptySteps(axisId)` explicitly cleans old empty columns in one undoable request. Normal reads never remove intentional pauses; canonical source files, exact surviving frame durations and independent expected-source selection remain intact. See the timeline API section for REST/MCP options.
