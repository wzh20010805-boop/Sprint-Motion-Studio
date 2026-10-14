# Sprite Motion Studio Human–AI Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户以素材加一句目标发起任务，由 Codex 制作、自检和返工，经人工逐帧及播放验收后自动交付同一固定候选，并提供可靠的配套 Skill。

**Architecture:** 保留 Bun / SQLite / 现有队列 / Python 合成器，增加协作任务、固定候选、独立审核和操作提交记录。MCP、CLI 与 GUI 调用同一业务服务；AI 视觉自检使用有限抽样，技术检查和人工验收覆盖全序列。候选先固定再检查，正式包复制已审核像素，服务在验收通过后自动启动打包。

**Tech Stack:** Bun、TypeScript、Elysia、bun:sqlite、React 19、Pixi 8、Electron、Python / Pillow、FFmpeg；使用已有 Zod / Ajv，不新增依赖。

**Spec:** [已确认设计](../specs/2026-10-13-human-ai-animation-workflow-design.md)。执行前同时读取该规格与仓库 `AGENTS.md`。用户已于2026-10-13选择逐任务实施＋独立评审；执行状态见专属progress ledger。

## Global Constraints

- 人工逐帧确认最终合成帧及整体播放验收必须保留；AI 自检不能写人工批准。
- 仅已有视频 / PNG 序列，不增加内部 Agent、云生成、补画或游戏工程修改。
- 默认保留所选动作全部帧、顺序和源有理数时长；PNG 没有视频 PTS，缺时长时集中确认。
- 每个候选视觉预算 `B=min(12,max(1,floor(N/2)))`；常规最多8帧、风险补充最多4帧，用户可降低，Codex 不自行提高至全帧。
- 固定候选先于技术 / 视觉检查；修改生成新候选；未变批准可显式继承，衔接影响帧需复审。
- 所有协作动作正式导出路径统一候选接受闸门，任务取消不清除协作模式；历史包可读，未进入协作模式的旧动作保留原流程。
- 生产能力版本从 `1.1` 升至 `1.2`；服务锁先于 DB；新审核凭据不进入 CLI / MCP 服务描述。
- 后端路径使用 `STORAGE_ROOT`；Worker 不反向 import `queue.ts`；通过现有队列执行，不另建队列或图像处理链。
- UI 局部增加验收工作台，保留素材、遮罩、对齐和编辑器；使用现有主题变量、双语 i18n、通知与确认组件。
- 原件、完整源帧、历史遮罩、成功交付与失败证据保留；不改真实用户项目，不自动下载模型或改全局 Codex 配置。
- **不执行任何 Git 操作。** 技能中的 commit / worktree 惯例由用户和仓库约束覆盖；逐任务保存证据，不创建 / 提交 / 推送分支。
- 实现完成不等于发布授权；打包写入新目录，不覆盖现有发行版，不上传 Release。

## Review Focus

1. PNG 没有时长、自然排序与显式清单冲突：保存可验证顺序和确认的时间来源，而非伪造 PTS（Task 3）。
2. 主轨空单元格被 SQL join 忽略：技术检查按期望选择表发现缺帧，不能依赖 `frames.length`（Task 4）。
3. 打包时撤销批准或在文件 / DB 提交窗口崩溃：无效接受代次不能发布，恢复不能仅看目录存在（Tasks 8–9）。
4. VFR、根插值、重排和循环首尾：复审影响包含真实时间 / 空间依赖，不能只看改变的关键帧（Tasks 3、6、11）。
5. 浏览器旧 Canvas 下载绕过服务：协作动作旧出口转向候选交付，旧动作仍可正常导出（Tasks 8、12）。

---

## 执行环境与验证约定

所有命令在 `D:\AIJOB\tools\Sprite Motion Studio\framebaker` 执行。本次只读定位已确认本机 Bun 不在 PATH，可用相邻隔离运行时；测试 Python 位于 `.venv-image`。

```powershell
$smsPlanBun = 'D:\AIJOB\tools\Sprite Motion Studio\.runtime\node_modules\@oven\bun-windows-x64\bin\bun.exe'
$smsPlanPython = 'D:\AIJOB\tools\Sprite Motion Studio\framebaker\.venv-image\Scripts\python.exe'
```

以下检查命令均以这两个变量运行。每个任务先运行其失败测试，确认因待实现行为失败，再实现并运行同一测试。首次执行记录已有测试 / 类型基线；若依赖或环境失败，先区分基线问题，不把失败归因于新实现。

DB / 服务测试使用独立子进程和 `fixtures/generated/human-ai/<唯一ID>` 工作区，在载入 DB 前设置 `SFS_WORKSPACE`。真实片段试验只读使用 `docs/media/sfs/source-run.mp4` 的副本，源文件不修改；模型未就绪时测试明确缺依赖路径，不隐式下载。验证脚本及 Electron fixture 默认隐藏，不打断用户桌面。

本计划中的测试代码是断言契约，不是已运行的测试结果。fixture setup 按现有 `tests/pipeline/service.test.ts` / `production.test.ts` 的子进程模式实现。每任务记录命令、退出码、必要产物与限制；不以文字匹配测试代替行为验证。

## 文件职责与公共契约

新服务代码集中于 `apps/server/src/pipeline/collaboration/`，相互导入单向，API adapter 不包含业务规则。已有大型文件只接入新模块，不做无关重构。

| 文件 / 目录 | 职责 / 主要修改点 |
| --- | --- |
| `packages/shared/src/pipeline/collaboration.ts`、`collaborationSchemas.ts` | 任务、候选、审核、操作、分页、采样的共同类型 / schema |
| `packages/shared/src/pipeline/index.ts`、`alignment.ts`、`packages/shared/src/types.ts` | 导出新契约、生产版本1.2、必要 job / WS 名称 |
| `apps/server/src/pipeline/migrations.ts` | 备份及增量 schema 5，旧数据保留 |
| `collaboration/store.ts`、`operations.ts` | 协作记录、幂等操作与检查点；不执行图像任务 |
| `collaboration/drafts.ts`、`candidates.ts`、`checks.ts` | 要求 / 内容身份、私有固定候选、全帧技术检查 |
| `collaboration/sampling.ts`、`impact.ts`、`reviews.ts` | 纯采样、影响计算、审核 / 问题 / 接受事务 |
| `collaboration/delivery.ts`、`collaborationApi.ts` | 固定产物交付、薄 HTTP adapter |
| `apps/server/src/localSessions.ts`、`desktopReviewBroker.ts` | 服务验证的制作 / 审核能力及桌面本机 bootstrap |
| `runtime.ts`、`runtimeBootstrap.ts`、`index.ts`、`queue.ts` | 原生命周期 / 鉴权 / 队列接入；两种候选 job |
| `pipeline/{service,images,masks,alignment,productionApi,export}.ts` | 制作元数据、完整输入、协作 guard；旧路径回归 |
| `apps/server/src/mcp/sfs.ts`、`apps/cli/src/{index,production,client,mcpBridge}.ts` | 共用契约、分页、传输限制、恢复命令 |
| `apps/desktop/main.cjs`、`probes/desktop/main.cjs` | 两个宿主的独立审核 Cookie 初始化 |
| `apps/web/src/candidateReviewApi.ts`、`candidatePlayback.ts` | Typed GUI adapter、候选时序播放 |
| `components/CandidateReviewWorkspace.tsx`、`CandidateReviewCanvas.tsx` | 统一验收及原像素画面 / 标注 |
| `components/{Editor,AlignmentWorkshop,JobPanel}.tsx`、`export.ts` | 协作入口、手工返工、旧出口转向、交付状态 |
| `skills/soldier-frame-studio/`、`scripts/build_portable.ts` | Skill 与发行随包交付 |

### 共同类型（Task 1 产出）

以下结构为最低契约；字段名在任务间保持一致，JSON schema 与 TS 类型同步：

```ts
type WorkContext = { project_id: string; axis_id: string };
type ContentToken = { revision: number; hash: string };
type RequestIdentity = { request_key: string };
type ActorContext = { session_id: string; role: 'maker' | 'reviewer' };
type FieldOrigin = 'user' | 'preset' | 'inferred';
type TaskField<T> = { value: T; origin: FieldOrigin };
type ReviewContext = { task_id: string; candidate_id: string;
  base_review_revision: number; request_key: string };
```

同时定义：

- `TaskBrief`：`context`、`source_id`、`ordered_source_frame_ids`、`subject_region`、`alignment`、`timing`、`loop`、`sampling_limit`、`output`。用户决定值带 `TaskField`；`timing` 分 `source_pts` / `confirmed_fps` / `explicit_durations`，输出时长使用已有 `Rational`。
- `CollaborationTask`：`id`、`context`、`brief_version`、`content_token`、`state`、`selected_candidate_id`、`acceptance_epoch`、`operation_ids`。
- `DraftFrame`：稳定帧 / 源ID、序列位置、有理数时长及来源、源尺寸、源 / mask / RGBA路径及哈希、mask版本、原编辑变换；尚无合成PNG时不要求最终PNG哈希。`DraftContent`：`context`、`token`、`frames:DraftFrame[]`、`expected_source_frame_ids`、`alignment:AlignmentConfig|null`。执行裁定：未配置 / 空动作允许null以取得导入base_content；TaskBrief / CandidateManifest仍要求有效对齐，候选构建须以ALIGNMENT_REQUIRED拒绝null。
- `CandidateFrame`：`frame_id`、`source_frame_id`、`source_index`、`sequence_index`、`duration`、`duration_origin`、`raw_sha256`、`mask_version_id`、`mask_sha256`、`png_sha256`、`content_hash`、`files`、`resolved_transform`、`resolved_root`、`source_to_canvas`。不可逆映射用 `null` 并附原因。
- `CandidateManifest`：`schema_version:'1.0'`、`candidate_id`、`parent_candidate_id`、`task_id`、`brief_version`、`content_token`、`content_hash`、`playback_hash`、`compositor_hash`、`alignment`、`output`、`frames`。`output`固定max_texture / gap / margin / 格式和loop要求。内容清单不含会改变的审核 / 自检字段。
- `CandidateRecord`：上述清单的引用与校验哈希、`visibility:'private'|'submitted'`、检查 / 自检记录引用、审核修订。`CandidateBuildRequest = WorkContext & RequestIdentity & {task_id; base_content:ContentToken; parent_candidate_id?:string}`。
- `FrameReviewPatch`：`frame_id`、`verdict:'pending'|'approved'|'needs_repair'`；`IssuePatch`：`frame_ids`、`rect`、`coordinate_system:'final_canvas_pixels'`、`text`、`severity:'blocking'|'advisory'`。`IssueRepairPatch`：`issue_id`、`repair_candidate_id`、`frame_ids`、`note`，只提交修复关联，不表示人工通过。
- `PlaybackReviewPatch`：`playback_hash`、`confirmed:boolean`；`ReviewResult`：`review_revision`、`acceptance_epoch`、`accepted`、`pending_delivery_operation_id`。
- `SamplingPlan`：`candidate_id`、`content_hash`、`plan_hash`、`budget`、`samples[{frame_id,reason,frame_content_hash}]`、`uncovered_risks`；`SampleObservation`：对应身份、`viewed:boolean`、`result:'ok'|'issue'|'uncertain'`、说明 / 证据来源。无法读取画面写viewed=false及原因，不伪称已观察。
- `ImpactReport`：`changed_frame_ids`、`recheck_frame_ids`、`inheritable_frame_ids`、`playback_changed`、每项原因及跨动作预设影响。
- `OperationRecord`：`id`、`request_key`、`payload_hash`、原内容身份、`kind`、`state`、`attempt_job_ids`、`result`、`checkpoint`；`DeliveryRequest`：`task_id`、`candidate_id`、`acceptance_epoch`、`operation_id`。
- `Page<T>`：`items`、`total`、`next_cursor`、`complete`、`content_token`，完整分页结果不经过通用数组摘要压缩。

## 依赖与里程碑

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14`

核心类型与状态耦合较紧，按该顺序实施；已完成接口后的独立测试 / 文档可以并行。该依赖链不要求未获授权的 Git worktree。

- 基础与制作验证：Tasks 1–5；先确认源时序、固定候选和抽样正确。
- 审核 / 交付机制：Tasks 6–9；所有入口接入前先验证闸门、撤销及恢复。
- 真实人机操作：Tasks 10–12；MCP / CLI 闭环和 GUI 局部接入。
- Skill / 完整验收：Tasks 13–14；行为测试与新目录便携包。

### Task 1：共同契约、增量迁移与操作记录

**Files:** 创建 shared 契约文件、`collaboration/store.ts`、`collaboration/operations.ts`、`tests/pipeline/collaborationFixtures.ts`；修改 shared 导出及 `pipeline/migrations.ts`；测试 `collaboration-schema.test.ts`、`collaboration-migrations.test.ts`、`collaboration-operations.test.ts`。

**Interfaces:**
- `createTaskRecord(brief:TaskBrief,request:RequestIdentity):CollaborationTask`、`readTaskRecord(id:string):CollaborationTask`、`setAxisWorkflowMode(context:WorkContext,mode:'collaboration'):void`、`axisWorkflowMode(context:WorkContext):'legacy'|'collaboration'`。
- `claimOperation(kind:string,request:RequestIdentity,payload:unknown):OperationRecord`、`readOperation(id:string):OperationRecord`、`writeOperationCheckpoint(id:string,checkpoint:unknown):void`；同 key / 同 payload 返回同记录，不同 payload 报 `REQUEST_CONFLICT`。
- 测试 helper `runCollaborationScript(script:string):Promise<{exit_code:number;stdout:string;stderr:string;workspace:string}>`：独立子进程，先设工作区，保留输出。

- [x] Step 1：写 schema / WAL 旧DB / 幂等记录失败测试，覆盖 schema 5 重复迁移、历史包保留、旧批准不升级。
  ```ts
  expect(second.id).toBe(first.id);
  expect(() => claimOperation('candidate', {request_key:'same'}, changedPayload))
    .toThrow('REQUEST_CONFLICT');
  expect(migratedCandidateApprovals).toHaveLength(0);
  expect(schemaVersion).toBe(5);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/collaboration-schema.test.ts tests/pipeline/collaboration-migrations.test.ts tests/pipeline/collaboration-operations.test.ts`，确认待实现行为导致失败。
- [x] Step 3：schema5一次定义完整DDL：增加 `collab_tasks`、`task_briefs`、`axis_workflow_modes`、`candidates`、`candidate_frames`、`frame_reviews`、`review_issues`、`playback_reviews`、`collab_operations`；增加 `projects.content_revision` 和 job操作 / 尝试字段。保存不可变的每版任务要求，候选附加记录与内容分开；内容触发器只观察实际制作字段，旧project触发器排除两个修订字段，避免递归。记录 / 状态写入使用现有 SQLite 事务，唯一键保护请求身份。
- [x] Step 4：同一命令通过；保存旧DB备份、迁移结果和失败基线，不编辑真实工作区。独立评审通过；全量测试曾误载入默认DB并升级结构，原有行逐字段比对未变，该轮不计隔离验收，详见专属ledger和Task1报告。

### Task 2：制作 / 审核会话、桌面 bootstrap 和1.2握手

**Files:** 新建 `localSessions.ts`、`desktopReviewBroker.ts`；修改 `runtime.ts`、`runtimeBootstrap.ts`、`index.ts`、CLI `client.ts`、两个 desktop `main.cjs`、shared `alignment.ts`；测试 `runtime-capabilities.test.ts`，扩展 `runtime.test.ts`、`service-version.test.ts`、`gui-launch.test.ts`。

**Interfaces:**
- `authenticateLocalRequest(request:Request,authority:string):ActorContext`、`requireRole(actor:ActorContext,role:'maker'|'reviewer'):void`。
- reviewer包含制作能力，故 `requireRole(actor,'maker')` 接受maker或reviewer；`requireRole(actor,'reviewer')` 仅接受reviewer。GUI仍可手工制作，maker不会反向获得审核能力。
- `startDesktopReviewBroker(instanceId:string):Promise<{pipe_name:string;close():void}>`、`issueDesktopLaunchNonce(bootstrapSecret:string,desktopPid:number):Promise<{nonce:string}>`、`consumeDesktopLaunchNonce(nonce:string,desktopPid:number):Promise<{reviewer_cookie:string}>`；使用 Windows 本机命名管道和一次性桌面启动 nonce，不提供 maker HTTP 升级端点。
- 服务写独立本机桌面bootstrap描述（instance / pipe / bootstrap secret），不放进maker `ServiceInfo`。两个可信桌面宿主从本机启动状态读取它，经管道取得并消费绑定PID的一次性nonce；验证当前服务instance和新鲜性。该描述不传给renderer、不进入CLI stdout / 日志 / 打包，测试核对实际本机文件权限；不把Windows上的POSIX mode字样当ACL验证。
- `.sfs/service.json.token` 仅为 maker；桌面启动内部握手取得 reviewer Cookie，Cookie 值不进入描述 / 日志 / MCP 结果。该能力边界不声称能隔离同一 OS 用户的恶意进程。

- [x] Step 1：写经过真实传输边界的失败测试，不仅调用 `app.handle()`；覆盖 maker / 旧共享 token / 伪造 `actor:human`、nonce复用和桌面 Cookie。
  ```ts
  expect(makerReviewResponse.status).toBe(403);
  expect(forgedActorResponse.status).toBe(403);
  expect(reviewerReviewResponse.status).not.toBe(403);
  expect(JSON.stringify(serviceDescriptor)).not.toContain(reviewerSecret);
  expect(secondNonceConsumption).toMatchObject({code:'BOOTSTRAP_REPLAY'});
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/runtime-capabilities.test.ts tests/pipeline/runtime.test.ts tests/pipeline/service-version.test.ts`，确认失败原因。
- [x] Step 3：服务在载入DB前取得锁；bootstrap管理能力仅在本机启动握手使用。两个宿主设置独立 HttpOnly审核 Cookie；制作请求仍带 maker。保持 Host / Origin / WS约束和renderer隔离。API版本升1.2；未适配客户端明确版本冲突，不强杀旧服务。
- [x] Step 4：同一命令通过；桌面fixture证明GUI可读 / 编辑及取得审核能力，生产描述只有maker，服务重启旧会话失效。两宿主隐藏实测通过；兼容性修复经独立复审通过，具体证据及受限环境失败保留于专属ledger。

### Task 3：最少输入任务、源选择 / PNG时序和制作内容身份

**Files:** 新建 `collaboration/drafts.ts`、薄 `pipeline/collaborationApi.ts`；修改 `service.ts`、`images.ts`、`masks.ts`、`alignment.ts`、`api/timeline.ts`；测试 `collaboration-drafts.test.ts`、`collaboration-inputs.test.ts`、`collaboration-content.test.ts`。

**Interfaces:**
- `createCollaborationTask(brief:TaskBrief,request:RequestIdentity,actor:ActorContext):CollaborationTask`。
- `readDraftContent(context:WorkContext):DraftContent`；审核状态不进入内容 hash。
- `importImageSequence(context:WorkContext,files:Array<{name:string;bytes:Uint8Array}>,options:{request_key:string;ordered_names?:string[];timing:TaskBrief['timing'];base_content:ContentToken}):Promise<{source_id:string;frame_ids:string[];content_token:ContentToken}>`。
- `setOutputTiming(context:WorkContext,timing:TaskBrief['timing'],base:ContentToken,request:RequestIdentity):ContentToken`；保存权威输出有理数时长及来源，保留原源时序。
- `startRework(taskId:string,parentCandidateId:string,base:ContentToken,request:RequestIdentity,actor:ActorContext):{task:CollaborationTask;content_token:ContentToken}`；固定父候选只作基准，继续在制作副本修改。

- [x] Step 1：写PNG显式顺序、重复名称、源范围、输出时序和审核不改内容身份的失败测试。
  ```ts
  expect(sequenceNames).toEqual(['frame2.png','frame10.png']);
  expect(pngTiming.duration_origin).toBe('confirmed_fps');
  expect(sourceTimingAfterExplicitChange).toEqual(sourceTimingBefore);
  expect(outputDurations).toEqual([{num:1,den:12},{num:1,den:24}]);
  expect(tokenAfterReviewNote).toEqual(tokenBeforeReviewNote);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/collaboration-drafts.test.ts tests/pipeline/collaboration-inputs.test.ts tests/pipeline/collaboration-content.test.ts`，确认失败。
- [x] Step 3：启用Task1内容修订与hash，内容写入推进，审核附加记录不推进；alignment settings更新也覆盖。PNG导入登记真实源 / 帧清单，目标动作明确、不隐式追加旧动作，旧函数无协作参数时保持原行为。主体 / 预设 / 推导值带来源，必要确认最多一轮；源选择表验证“全所选片段”基数。协作抠图job计算完成返回成功但保留未审核标识，Codex可以继续制作；旧模式仍保留原waiting_user语义。协作动作的手工step时长更新同时记录明确的输出有理数时长（ticks / 当前FPS），不会被源metadata重新覆盖；FPS变更在confirmed_fps模式更新全序列，在source_pts模式保留源时长并向GUI声明尚未切换输出计时策略，切换需明确用户操作。
- [x] Step 4：同一命令及既有 `service.test.ts`、`production.test.ts` 通过；在隔离副本用现有 CLI 跑真实片段到抠图、对齐、预览 / 草稿，记录问题，不调用人工确认或正式导出。缺模型时记录明确依赖，不下载。

### Task 4：先固定候选，再检查完整序列

**Files:** 新建 `collaboration/candidates.ts`、`checks.ts`；修改 `queue.ts`、shared job类型、`pipeline/export.ts`、`workers/image/{worker,compose}.py`；新增 `candidate-immutability.test.ts`、`candidate-checks.test.ts`，扩展 `workers/image/tests/test_compose.py`。

**Interfaces:**
- `createPrivateCandidate(request:CandidateBuildRequest,actor:ActorContext):{operation_id:string;job_id:string}`。
- `buildPrivateCandidate(request:CandidateBuildRequest,signal?:AbortSignal,progress?:(text:string)=>void):Promise<CandidateRecord>`；queued Worker不得import queue。
- `checkCandidate(candidateId:string):Promise<{candidate_id:string;content_hash:string;checked_frame_count:number;blocking_errors:unknown[];warnings:unknown[]}>`。
- `submitCandidate(candidateId:string,expectedHash:string,actor:ActorContext):CandidateRecord`：只有该固定画面检查合格 / 自检记录齐全才能公开，不重新渲染。

- [x] Step 1：用合成RGBA写失败测试：300帧、主轨step缺cell、源映射错误、合法Alpha1/128、空帧、损坏PNG、越界、检查后编辑。
  ```ts
  expect(report.checked_frame_count).toBe(300);
  expect(missingCellReport.blocking_errors).toContainEqual(
    expect.objectContaining({code:'MISSING_PRIMARY_FRAME'}));
  expect(semitransparentReport.blocking_errors).toHaveLength(0);
  expect(candidateHashAfterDraftEdit).toBe(candidateHashBeforeDraftEdit);
  expect(submittedManifestHash).toBe(checkedManifestHash);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/candidate-immutability.test.ts tests/pipeline/candidate-checks.test.ts` 及 `& $smsPlanPython -m pytest workers/image/tests/test_compose.py`，确认新断言失败。
- [x] Step 3：复用Pillow合成 / 固定图集布局，生成完整私有目录及不可变清单。输入版本必要时复制，生成compositor源摘要，实际affine / 逆映射写元数据；完整解码 / Alpha / 尺寸检查与几何越界检查并行保留。对照期望选择表与主轨steps，而非SQL join结果数量。检查与提交都使用同一候选内容身份。
- [x] Step 4：同一命令及 `editor-export.test.ts` 通过；修复导致新候选，新旧文件哈希分别保留，候选画面不得再应用编辑器变换。

### Task 5：确定性采样与有来源的AI观察记录

**Files:** 新建 `collaboration/sampling.ts`；修改候选store / adapter；测试 `candidate-sampling.test.ts`、`candidate-observations.test.ts`。

**Interfaces:**
- `selectCandidateSamples(manifest:CandidateManifest,risks:Array<{frame_id:string;priority:number;reason:string}>,limit=12):SamplingPlan`。
- `recordSampleObservations(candidateId:string,planHash:string,observations:SampleObservation[],actor:ActorContext):void`；观察只属于对应身份，不能批准帧。

- [x] Step 1：按已确认算法写预算、VFR时刻、风险溢出、同分 / 重复和观察复用失败测试。
  ```ts
  expect([1,2,4,24,300].map(n=>sampleFixture(n).budget)).toEqual([1,1,2,12,12]);
  expect(plan.samples.length).toBeLessThanOrEqual(plan.budget);
  expect(noRiskPlan.samples.length).toBeLessThanOrEqual(8);
  expect(secondPlan).toEqual(firstPlan);
  expect(reusedObservation.evidence_candidate_id).toBe(parent.id);
  expect(humanApprovalsAfterObservations).toHaveLength(0);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/candidate-sampling.test.ts tests/pipeline/candidate-observations.test.ts`，确认失败。
- [x] Step 3：实现预算内首尾、最多4风险补充、累积有理数时长均匀常规样本、稳定去重 / tie；返回每项原因与未覆盖风险。复用仅相同帧内容身份，保留来源，背景 / Alpha切换不增加名额。先用已有检查信息作轻量线索，不新建视觉模型。
- [x] Step 4：同一命令通过；测试N=2只能一帧、长序列风险过多不扩为全量、返工新候选优先变更帧但未变化证据不重复读取。

### Task 6：候选比较、空间 / 时间影响与复审范围

**Files:** 新建 `collaboration/impact.ts`；新测试 `candidate-impact.test.ts`、扩展 `root-interpolation.test.ts`。

**Interfaces:** `compareCandidates(parent:CandidateManifest,next:CandidateManifest):ImpactReport`；`affectedActionsForPreset(projectId:string,changedPresetHash:string):WorkContext[]`。

- [x] Step 1：写局部帧、根插值 / clamp、跨动作preset、重排、VFR时长、循环首尾失败测试。
  ```ts
  expect(local.recheck_frame_ids).toEqual(['f1','f2','f3']);
  expect(loopEdge.recheck_frame_ids).toContain('last');
  expect(rootEdit.recheck_frame_ids).toContain('between-keyframes');
  expect(reordered.playback_changed).toBe(true);
  expect(unknownImpact.inheritable_frame_ids).toHaveLength(0);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/candidate-impact.test.ts tests/pipeline/root-interpolation.test.ts`，确认失败。
- [x] Step 3：以稳定frame ID比较输入 / 输出身份、实际root / affine、时长、序列连接和loop；索引重排重新核对root / offsets映射。邻帧衔接复审即使像素相同也不列为可继承；公共preset列出全部受影响动作；不确定保守全序列。
- [x] Step 4：同一命令通过，输出可直接供GUI显示的影响原因；播放hash任一画面 / 顺序 / 时长变化则失效。

### Task 7：逐帧审核、问题、批准继承与接受事务

**Files:** 新建 `collaboration/reviews.ts`；修改store / adapter；测试 `candidate-reviews.test.ts`、`candidate-review-races.test.ts`。

**Interfaces:**
- `applyFrameReview(context:ReviewContext,patch:FrameReviewPatch,actor:ActorContext):ReviewResult`。
- `applyPlaybackReview(context:ReviewContext,patch:PlaybackReviewPatch,actor:ActorContext):ReviewResult`。
- `applyIssue(context:ReviewContext,patch:IssuePatch,actor:ActorContext):ReviewResult`。
- `recordIssueRepair(context:ReviewContext,patch:IssueRepairPatch,actor:ActorContext):ReviewResult`：context绑定原问题候选及预期审核修订；maker只关联修复候选，不关闭阻断问题。
- `inheritFrameReviews(parentId:string,nextId:string,impact:ImpactReport):void`：受控内部helper，不公开接受maker提供的impact。`applyFrameInheritance(context:ReviewContext,parentCandidateId:string,actor:ActorContext):ReviewResult`：reviewer明确请求，服务核验影响及原批准来源。
- `readReviewState(candidateId:string):{review_revision:number;frame_reviews:unknown[];issues:unknown[];playback_confirmed:boolean;acceptance_epoch:number|null}`：返回当前有效接受；任务计数器仍为单调number。`acceptSourceDefect(context:ReviewContext,patch:{issue_id:string;frame_ids:string[];reason:string},actor:ActorContext):ReviewResult`：仅reviewer，不能绕过技术阻断。

- [x] Step 1：写权限、重复确认、并发审核修订、阻断问题、继承、旧候选不抢交付和撤销失败测试。
  ```ts
  expect(after.review_revision).toBe(before.review_revision+1);
  expect(candidateContentHashAfterReview).toBe(candidateContentHashBeforeReview);
  expect(oldRevisionMutation.code).toBe('REVIEW_REVISION_CONFLICT');
  expect(accepted.pending_delivery_operation_id).toBeTruthy();
  expect(oldCandidateReviewStartsDelivery).toBe(false);
  expect(afterRevoke.acceptance_epoch).toBeNull();
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/candidate-reviews.test.ts tests/pipeline/candidate-review-races.test.ts`，确认失败。
- [x] Step 3：审核记录独立事务更新，maker只能读反馈 / 记录修复，用户批准必须reviewer；非阻断备注不撤销帧批准。问题状态为open→repair_linked→resolved：只有关联修复候选的全部问题帧由用户确认、必要播放验收完成后才派生resolved，保存这些用户确认作为依据；源缺陷接受使用独立reviewer明确操作，不能由maker关闭。满足当前选定候选条件时，在同一事务创建接受代次和唯一pending交付operation；提交后窄回调唤醒既有队列，不在SQLite事务内启动异步打包。局部批准显式继承；源缺陷接受不绕过技术阻断。
- [x] Step 4：同一命令通过；最后一帧确认不等于播放确认；接受→排队崩溃窗口留下可协调operation，GUI完成验收不依赖Codex在线。

### Task 8：精确候选交付与所有旧出口闸门

**Files:** 新建 `collaboration/delivery.ts`；修改 `queue.ts`、`productionApi.ts`、`recipe.ts`、旧 `export.ts`、web `export.ts`、`components/Editor.tsx`；测试 `candidate-delivery.test.ts`、`collaboration-export-guards.test.ts`，扩展 `editor-export.test.ts`。

**Interfaces:**
- `queueAcceptedDelivery(operationId:string):{operation_id:string;job_id:string}`；同operation返回同有效提交 / 执行尝试。
- `packageAcceptedCandidate(request:DeliveryRequest,signal?:AbortSignal,progress?:(text:string)=>void):Promise<{delivery_id:string;directory:string;checksums:Record<string,string>}>`。
- `assertFormalExportAllowed(context:WorkContext,candidateId?:string):void`：协作模式统一接受闸门。
- `resolveActionExport(context:WorkContext,format:string):Promise<{mode:'legacy'|'candidate';candidate_id?:string;delivery_id?:string}>`：前端旧出口调用服务裁定，不只禁用一个按钮。

- [x] Step 1：写精确字节 / duration / 图集、maker绕旧HTTP/recipe/MCP、浏览器出口、撤销与发布竞争失败测试。
  ```ts
  expect(deliveredPngSha256).toEqual(candidatePngSha256);
  expect(deliveredDurations).toEqual(candidateDurations);
  expect(legacyFormalCollaborationExport.status).toBe(409);
  expect(browserExporterUsedLiveCanvasForCollaboration).toBe(false);
  expect(publicationAfterRevocation).toBe(false);
  expect(withdrawnDelivery.files_retained).toBe(true);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/candidate-delivery.test.ts tests/pipeline/collaboration-export-guards.test.ts tests/pipeline/editor-export.test.ts`，确认失败。
- [x] Step 3：复制已验收PNG / 固定sheet；生成正式manifest / QA / ZIP，保留抽样事实。发布与撤销在同一服务临界区内串行，重新验证选定候选、接受代次、最新审核状态和哈希。发布记录是正式提交依据，目录存在不是批准。旧生产HTTP / recipe / MCP / CLI与浏览器Canvas出口都按持久mode裁定；未协作旧动作沿用旧导出，取消任务不清mode。
- [x] Step 4：同一命令及旧 `production.test.ts` 通过；队列在接受后自动打包，最终GUI读持久状态，发布后撤销只标withdrawn保留文件。

### Task 9：稳定操作恢复与文件 / DB崩溃协调

**Files:** 扩展 `collaboration/operations.ts`、`candidates.ts`、`delivery.ts`、`queue.ts`、`service.ts`、`extractAll.ts`、`runtimeBootstrap.ts`；测试 `operation-recovery.test.ts`、`collaboration-crash-recovery.test.ts`。

**Interfaces:** `resumeCollaborationOperation(id:string,actor:ActorContext):Promise<OperationRecord>`、`reconcileCollaborationOperations():Promise<void>`；检查点回调 `onCheckpoint?:(phase:string)=>void` 用于确定性测试，不启用生产环境任意脚本。

- [x] Step 1：写子进程failpoint失败测试，覆盖raw / timing各rename、主轨提交、候选发布、接受后未排队、交付目录已发布但DB未登记、job结果未存。
  ```ts
  expect(resumed.id).toBe(original.id);
  expect(resumed.payload_hash).toBe(original.payload_hash);
  expect(replayedFrameCount).toBe(expectedFrameCount);
  expect(changedInputResume.code).toBe('INPUT_IDENTITY_CONFLICT');
  expect(invalidEpochDirectoryPromoted).toBe(false);
  expect(committedDeliveryCount).toBe(1);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/operation-recovery.test.ts tests/pipeline/collaboration-crash-recovery.test.ts`，确认失败。
- [x] Step 3：operation身份与job尝试分开；原输入不变才能恢复，改变输入是新operation。启动协调先验证文件哈希 / 提交身份 / DB状态，补登记已成功结果；恢复不得丢base revision。旧无协作operation的 `resumeJob()` 保留现有明确兼容行为；新协作job转入严格恢复，避免静默修改旧测试含义。
- [x] Step 4：同一命令以及旧 `cache.test.ts`、`service.test.ts`、`production.test.ts` 通过；失效接受代次的目录只留为未发布证据，不能因文件存在交付。

### Task 10：完整MCP / CLI门面、实际分页与制作试验

**Files:** 扩展 `collaborationApi.ts`、`app.ts`、`mcp/sfs.ts`；新建CLI `collaboration.ts`并修改 `index.ts`、`production.ts`、`client.ts`、`mcpBridge.ts`；测试 `mcp-collaboration.test.ts`、`cli-collaboration.test.ts`，更新旧九工具数量断言和双语API文档。

**Interfaces / public names:**
- MCP保留查询 / job名；新增 `create_project`、`create_action`、`import_images`、`list_frames`、`get_frame_artifacts`、`edit_mask`、`undo_mask`、`save_alignment`、`set_output_timing`、`create_task`、`inspect_task`、`create_candidate`、`inspect_candidate`、`get_candidate_samples`、`record_sample_observations`、`submit_candidate`、`list_review_issues`、`record_issue_repair`、`compare_candidates`、`start_rework`、`resume_operation`。`export_assets` 对协作动作读取 / 提交已接受交付，不重渲染；maker不提供人工批准工具。
- HTTP薄路由位于 `/api/v1/collaboration/`：`tasks`、`tasks/:id`、`tasks/:id/candidates`、`candidates/:id`、`candidates/:id/frames`、`candidates/:id/samples`、`candidates/:id/observations`、`candidates/:id/submit`、`candidates/:id/reviews/frame`、`candidates/:id/reviews/playback`、`candidates/:id/issues`、`issues/:id/repair`、`issues/:id/accept-source-defect`、`tasks/:id/rework`、`operations/:id/resume`、`deliveries/:id`。审核 / 源缺陷接受写入必须实际解析reviewer能力，修复和观察不表示人工批准。
- CLI新增 `task create|inspect`、`candidate create|inspect|samples|observe|submit|compare`、`issue list|repair`、`rework start`、`operation resume`、`frames list`；JSON文件为结构化输入，`--request-key` / `--base-content` / `--base-mask-version` 明确。
- `listFrames(context:WorkContext,cursor?:string,limit=32):Page<DraftFrame>`、`listCandidateFrames(candidateId:string,cursor?:string,limit=32):Page<CandidateFrame>`；cursor绑定相应内容身份。

- [x] Step 1：写真实MCP stdio / HTTP、CLI JSON和完整300帧分页失败测试。
  ```ts
  expect(allPages.flatMap(p=>p.items)).toHaveLength(300);
  expect(lastPage.complete).toBe(true);
  expect(capabilities.production_api_version).toBe('1.2');
  expect(makerToolNames).not.toContain('apply_review_patch');
  expect(waitTimeout.cancelled_job).toBe(false);
  expect(JSON.parse(cliStdout).ok).toBe(true);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/mcp-collaboration.test.ts tests/pipeline/cli-collaboration.test.ts tests/pipeline/mcp-production.test.ts`，确认失败。
- [x] Step 3：绑定已有核心函数，无HTTP自调用。明确声明stdio上限1,048,576 UTF-8字节，bridge用有界原始字节读取器检查并跳过超限行；inline base64总字符上限786,432，项目 / ID等有限长度，超限提示CLI multipart；HTTP输入限制与stdio清楚分开。分页保持完整items，不被 `compactResult()` 再截8项；同cursor跨内容变化返回冲突。能力和schema只声明已实现操作；旧审核命令保留明确模式 / 权限错误，不转换为候选批准。
- [x] Step 4：同一命令及旧CLI/握手测试通过；用真实片段隔离副本从一句任务到候选、自检报告和 `awaiting_review`，不伪造人工通过。模型问题、源缺损和抽样遗漏如实记录。

### Task 11：最终像素验收画布、导航 / 播放与问题标注

**Files:** 创建 `candidateReviewApi.ts`、`candidatePlayback.ts`、`components/CandidateReviewCanvas.tsx`、`CandidateReviewWorkspace.tsx`、`scripts/verify_candidate_review.ts`、`probes/desktop/candidate-review-fixture.tsx`、`candidate-review-check.cjs`；测试 `candidate-playback.test.ts`、`candidate-review-navigation.test.ts`；修改i18n和 `candy.css`。

**Interfaces:**
- `candidateReviewApi` 方法对应 Task10 路由，全部使用shared返回类型。
- `candidateAtElapsed(manifest:CandidateManifest,elapsed:Rational):{frame_id:string;finished:boolean}`，按loop与有理数时长播放，不借用timeline tick代替。
- `CandidateReviewWorkspace({taskId,onClose,onEditDraft}:{taskId:string;onClose:()=>void;onEditDraft:(context:WorkContext)=>void})`。
- `CandidateReviewCanvas` 只呈现已合成PNG；不传入 `FrameEditor` 再做变换。区域坐标为最终画布像素，源映射读取服务元数据。

- [x] Step 1：写真实组件fixture与播放纯函数失败测试，含快速切帧延迟响应、输入框 / IME / 弹窗、300帧访问、区域标注、批准撤销。
  ```ts
  expect(displayedFrameAfterOutOfOrderLoads).toBe('f3');
  expect(lastAccessibleFrame.sequence_index).toBe(299);
  expect(annotation.coordinate_system).toBe('final_canvas_pixels');
  expect(frameAtVfrBoundary).toBe(expectedFrameId);
  expect(candidatePixelsReceivedExtraTransform).toBe(false);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/candidate-playback.test.ts tests/candidate-review-navigation.test.ts` 和 `& $smsPlanBun scripts/verify_candidate_review.ts`，确认失败。
- [x] Step 3：复用现有加载防过期、纹理预算、键盘保护、通知 / 确认；增加原图 / Alpha / 背景、逐帧确认、待确认跳转、问题和parent对照。首尾 / 循环行为按候选要求；切换前保留旧显示直到新图就绪；仅浏览 / 播放不自动批准。
- [x] Step 4：同一命令通过，保存隐藏Electron截图及机器断言；zh/en、两主题均可用，资源清理和现有导航回归通过。

### Task 12：编辑器局部接入、手工返工与持久交付显示

**Files:** 修改 `components/Editor.tsx`、`AlignmentWorkshop.tsx`、`JobPanel.tsx`、web `export.ts`及必要shared WS事件；扩展Task11 fixture、`scripts/verify_editor_navigation.ts`；测试 `collaboration-ui-flow.test.ts` / 真实desktop scenario。

**Interfaces:** `openCandidateReview(taskId:string)` 为Editor内modal入口，不新增顶层路由；`onEditDraft(context)` 明确进入制作副本，`start_rework` 返回新制作内容 / 父候选身份。

- [x] Step 1：写旧编辑 / 导出保留、协作旧出口转向、手工修改生成新候选、Codex离线GUI接受后自动打包失败测试。
  ```ts
  expect(legacyEditorExportStillWorks).toBe(true);
  expect(collaborationExportTarget).toBe('accepted-candidate');
  expect(oldCandidateHashAfterManualEdit).toBe(originalHash);
  expect(packagingStartedWithoutMakerClient).toBe(true);
  expect(deliveryVisibleAfterJobPanelExpiry).toBe(true);
  ```
- [x] Step 2：运行 `& $smsPlanBun test tests/pipeline/collaboration-ui-flow.test.ts`、`& $smsPlanBun scripts/verify_editor_navigation.ts`、Task11脚本，确认失败。
- [x] Step 3：Editor增加任务 / 候选入口，协作导出向服务查询；制作副本仍用原FrameEditor / MaskWorkshop / AlignmentWorkshop。协作模式明确展示当前源时序 / 已确认FPS / 显式时长策略，手工FPS修改不会静默覆盖源时序；用户切换策略调用同一setOutputTiming。显示未保存或新候选提示，不替换审核画面；工作台独立保存交付状态，不依赖6秒后隐藏的JobPanel条目。保留旧动作所有手工流程。
- [x] Step 4：同一命令及原遮罩 / 编辑器键盘脚本通过；实际GUI隔离审核身份能确认、标问题、返工、复审、自动交付，结果与Task8字节一致。

### Task 13：升级配套Skill并验证真实决策行为

**Files:** 修改 `skills/soldier-frame-studio/SKILL.md`；创建 `agents/openai.yaml`、三份设计指定references；创建 `tests/fixtures/collaboration-skill-scenarios.json`、`scripts/verify_collaboration_skill.ts`（只准备隔离场景 / 校验产物，不代替Agent评估）；更新随包使用说明。

**Interfaces:** `prepareSkillScenario(name:string):{request:string;workspace:string;artifacts:string[]}`、`verifySkillScenarioOutcome(name:string,workspace:string):{passed:boolean;observations:unknown[]}`。独立Agent收到请求、Skill及最小资料，不收到预设答案。测试中的必要澄清通过隔离场景的模拟用户通道记录 / 回答，不向真实用户弹问题，不调用真实审核；模型看到的场景资料不包含评分答案。

场景固定为 `minimal-video`、`png-timing`、`missing-model`、`large-input`、`wait-resume`、`review-change`、`source-changed`、`local-rework`、`unapproved-export`、`sampling-budget`、`accepted-delivery`。baseline保存改动前Skill副本，新版验证使用修改后的仓库Skill。

- [ ] Step 1：在写Skill前记录旧指导 / 无新增指导的基线：最少输入、缺模型、长数组 / 大输入、中断、局部返工、只说导出而未批准、采样预算、隔离审核后交付。保留真实调用 / 产物，不凭文案评分。
  ```ts
  expect(result.recipeQuestionnaireShown).toBe(false);
  expect(result.initialClarificationRounds).toBeLessThanOrEqual(1);
  expect(result.visualSampleCount).toBeLessThanOrEqual(result.sampleBudget);
  expect(result.fabricatedHumanApprovals).toBe(0);
  expect(result.duplicateCommittedOperations).toBe(0);
  ```
- [ ] Step 2：从 `& $smsPlanBun scripts/verify_collaboration_skill.ts prepare minimal-video` 开始，依次准备上述场景，独立Agent完成基线请求；记录观察到的遗漏 / 错误。`prepare`输出request / workspace / artifacts，`verify <场景名> <该工作区>`校验实际产物。不可假定所有基线都失败，针对有证据的失败改指导。
- [ ] Step 3：使用skill-creator / writing-for-agents / writing-skills指导升级入口与references：实际 `schema` 命令、当前caps、初稿继续制作、抽样自检、逐帧人工验收、固定候选、版本冲突和稳定恢复。不复刻业务算法，不增加产品API未实现的命令，正常自动发现与显式调用均可。
- [ ] Step 4：同场景新Agent用新Skill重跑并校验产物；执行 `& $smsPlanPython 'C:\Users\Administrator\.codex\skills\.system\skill-creator\scripts\quick_validate.py' 'skills/soldier-frame-studio'` 验证格式。针对未经批准导出和重复恢复两项关键行为塑形指导，做有旧指导控制的独立小样测试，每种至少5次，人工核对实际结果；其他完整场景各做有意义的前后验证，避免将所有格式项扩成昂贵重复测试。不把格式通过当可靠性证明。

### Task 14：完整验收、便携包与双语文档

**Files:** 扩展 `scripts/build_portable.ts`、`verify_portable.ts`、`verify_packaged_access.ts`；新建 `apps/desktop/collaboration-scenario.cjs` 和 `scripts/verify_collaboration_portable.ts`；更新双语API / architecture / README / CHANGELOG、`docs/p3-p5-guide.md`、`AGENTS.md`；证据写 `docs/evidence/human-ai-workflow/`。

**Interfaces:** 便携包保留完整Skill目录；新增scenario真实操作新审核语义，使用测试身份；验证脚本接受 `<新发行目录> <独立证据目录>`，拒绝覆盖。

- [ ] Step 1：写发行契约及真实集成scenario失败检查：makerCLI / MCP、GUI审核、关闭maker继续打包、300帧、恢复、旧项目、离线缺模型、搬目录后权限握手。
  ```ts
  expect(portable.production_api_version).toBe('1.2');
  expect(portable.skill_reference_files).toHaveLength(3);
  expect(guiCandidatePngHashes).toEqual(cliDeliveredPngHashes);
  expect(allFrameTechnicalCount).toBe(300);
  expect(formalDeliveryWithoutHumanReview).toBe(false);
  ```
- [ ] Step 2：针对新集成scenario运行，确认因尚未接入发行包的部分失败；不改现有发行目录。
- [ ] Step 3：完成打包接入和双语说明，修正AGENTS旧“无测试框架”和固定九工具叙述。双语增加Unreleased记录，以 `& $smsPlanBun run version:plan -- week` 预览并用 `& $smsPlanBun run version:bump -- week` 统一版本，不手改生成段，不进行Git或上传。GUI和CLI服务包均包含新模块、1.2能力、两种凭据bootstrap及全部Skill文件。
- [ ] Step 4：运行完整检查：
  ```powershell
  & $smsPlanBun test tests
  & $smsPlanBun run typecheck
  & $smsPlanPython -m pytest workers/image/tests
  & $smsPlanBun run version:check
  $smsBuildDestination = Join-Path 'D:\AIJOB\tools\Sprite Motion Studio\framebaker\dist' ('SpriteMotionStudio-human-ai-'+[guid]::NewGuid().ToString())
  $smsBuildEvidence = Join-Path 'D:\AIJOB\tools\Sprite Motion Studio\framebaker\fixtures\generated\human-ai' ('portable-'+[guid]::NewGuid().ToString())
  & $smsPlanBun scripts/build_portable.ts $smsBuildDestination
  & $smsPlanBun scripts/verify_collaboration_portable.ts $smsBuildDestination $smsBuildEvidence
  ```
  所有命令退出0、scenario断言通过且像素 / 时序 / 权限 / 恢复证据齐全才报告机器验证通过。真实素材仍请用户逐帧和播放验收；本机搬目录 / 受限PATH验证不称为干净Windows VM验收。

## 计划自审与执行交接

本次计划自审已完成，修正了制作帧 / 最终候选帧类型混用、缺失观察记录入口、问题修复缺少人工关闭依据、GUI审核角色仍需制作权限、UTF-8消息长度和手工时序变更等契约问题。尚未执行任何产品测试。

| 规格章节 | 实施任务 |
| --- | --- |
| 1–2：目标与产品决定 | Global Constraints、Tasks 3–14 |
| 3–4：现状、分层与职责 | 文件图、Tasks 1–4、8–10 |
| 5–6：任务入口、状态与记录 | Tasks 1、3、7、9、10、13 |
| 7：固定候选、审核与权限 | Tasks 2、4、7、8 |
| 8：返工与影响 | Tasks 3、6、7、12 |
| 9：完整技术检查与抽样 | Tasks 4–5、13 |
| 10：验收工作台 | Tasks 11–12 |
| 11：MCP / CLI / 服务 | Tasks 2–3、9–10 |
| 12：正式交付 | Tasks 7–9、12、14 |
| 13：Skill | Tasks 13–14 |
| 14：兼容与分期 | Tasks 1–3、8–10、12、14 |
| 15–16：验证与风险 | 每任务失败 / 通过检查、Tasks 13–14、Review Focus |

执行前再次核对公共类型 / 函数名在消费者中一致，Review Focus五项都有具体测试；不把模板占位、行为镜像测试或未运行预期结果当完成证据。本文所有checkbox保持未完成。

建议按任务逐项实施并独立评审，重点在权限、批准继承、固定内容和发布 / 撤销竞争；这些错误会直接破坏用户验收的可信度。另一方式是本会话直接实施全部任务，再做一次独立整体评审，成本较低，但独立问题发现更晚。

本计划书面评审通过且执行方式确定后，才进入实现。无论选哪种方式，保留无Git操作、旧界面能力、抽样视觉自检和人工全帧验收的已确认约束。







## 2026-10-14 用户调整执行优先级

以 character.rar 实际素材制作结果、实际耗时和调用数验证协作工具与 Skill；卡点按实际问题补功能，仅运行相关检查，避免过多重复测试。此前规划的38轮对照未执行，不作为开始素材制作的前置条件；保留历史记录，不声称已有对照或提速证据。配套 Skill 文件与格式检查已完成，实际行为验证、完整发行验收和最终独立评审未完成。人工逐帧及播放验收保持。
