# Windows 1.0.8 使用与 Codex 接入 · API 1.3

1.0.8 便携版双击 `SpriteMotionStudio.exe` 或 `START.cmd`。包中自带 Bun 服务、独立 Python、FFmpeg、前端与字体，不要求安装开发环境；包含协作 Task、固定候选和独立人工验收。模型不随包附带；菜单提供明确下载或离线导入 u2netp，验证 SHA256 后才安装。首次离线仍可导入 PNG、修正已有遮罩、对齐和导出。本文沿用 P2–P5 阶段的文件名，当前操作以 API 1.3 为准。

已有开发版项目仍在原 `framebaker/workspaces/default`，可通过“切换工作区”选择该目录；不要复制/删除原件。1.0.8 要求 `production_api_version=1.3`，拒绝复用 API 1.1/1.2 旧服务并返回 `BACKEND_VERSION_CONFLICT`。升级前先保存旧窗口，等任务结束并关闭旧窗口，待服务空闲退出后再打开；不会自动杀死用户服务或修改项目审核。旧 1.0.7 / API 1.1 的历史发行包仍保留。

## 工作区与服务

升级前保存并关闭旧程序，保留一份完整工作区副本。程序下载与工作区数据分开：旧版发行包保留不代表新版数据库会自动降级；需要回退时使用升级前的工作区副本。数据库迁移前的自动快照在工作区 `backups/`，它不能替代素材及候选文件的完整备份。

GUI、CLI 和 MCP 使用相同选择顺序：显式 `--workspace` > `SFS_WORKSPACE` > 登记表当前选择 > 默认目录。便携版登记表为 `%LOCALAPPDATA%\SpriteMotionStudio\workspaces.json`，默认目录是同处 `workspaces/default`。源码版登记表位于仓库 `.sfs/workspaces.json`，默认目录为 `workspaces/default`；源码命令将下方 `sfs.exe` 换为 `sfs.cmd`。

```powershell
.\sfs.exe workspace list --json
.\sfs.exe workspace add --name character --directory 'D:\素材工作区'
.\sfs.exe workspace use --name character
.\sfs.exe workspace current --json
.\sfs.exe service status --json
# 保存并关闭 GUI/MCP，等待任务完成后：
.\sfs.exe service stop --json
.\sfs.exe service clean --json
```

`add` / `use` 选择已有目录，不移动或合并数据库。环境变量会覆盖登记选择，切换后仍打开旧目录时先核查 `SFS_WORKSPACE`。每个活动工作区只有一个动态分配的 `127.0.0.1` HTTP 端口，网页、API、WebSocket 和制作 MCP 共用，不需要手填端口。`list` / `status` 不启动服务、不显示令牌。`stop` 在服务忙时拒绝退出；`clean` 只删除已确认失效的发现记录，保留数据库、素材、候选、审核和日志。桌面人工审核管道保留独立权限边界。

## 协作动作：制作、候选与人工验收

1. 创建 Task，保留用户原话、已核验来源和制作要求；在可修改的制作副本上完成抽帧、遮罩、对齐与输出时序。
2. 构建不可变候选，固定最终 PNG、图集和有理数时长。完成全帧技术检查与有界抽样自检，如实记录未观察范围，再提交人工验收。
3. 打开协作与验收窗口，检查全部最终帧和整体播放，必要时对照源图、Alpha、父候选及黑/白底。可逐帧确认，或检查完后明确选择“确认整个动作并允许导出”；仅浏览、播放或自动检查不会批准。
4. 发现问题时关联帧与区域，返回制作副本返工。父候选和问题保留，新候选显示变化与复审范围；未解决问题和需修复帧会阻止接受。
5. 人工接受后从固定候选生成交付包。输入变化或批准撤回会阻止无效交付；原操作可查询/恢复，历史文件保留。

CLI / MCP maker 负责制作、检查、提交和读取交付，不能代替桌面人工批准。存在多个 Task 时须明确选择，导出不会猜测最新候选或重新渲染。详细命令、JSON 输入和权限见 [API 1.3 说明](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/blob/main/docs/api.zh-CN.md#生产13制作门面与固定候选http接口)。

## 导入、遮罩与对齐

GUI 导入动作后打开“场景抠图与修正”：在原图框住完整角色和装备、生成初稿、擦除/恢复、检查黑白底和 Alpha、逐帧确认。打开“导出动画”：配置公共画布/锚点/比例，固定根位置或标注地面轨迹关键帧，逐帧微调。源左侧、共享后端预览右侧；左右键选帧，空格按实际帧时长播放，播放时隐藏洋葱皮。

素材库左侧按“项目 → 视频 / 照片”浏览。照片包括上传图片和视频抽取的帧；同一素材被多个项目使用时，会显示在各自分区，“全部素材”仍只显示一份。库内上传可选择归属项目，只保存素材，不直接插入时间轴。旧素材按来源记录自动归类，无法确认归属的留在“未归属素材”；原有自定义文件夹继续保留。删除项目不删除库中原文件，仍可从其它关联项目或未归属分区找到。

保存参数，执行全动作越界预检。跳跃、下蹲和倒地时标注地面投影，不追随脚底；越界不会自动缩小该帧。协作动作随后进入固定候选验收；既有非协作动作沿用当前遮罩与对齐的人工确认闸门。草稿明确标识，正式导出要求输入仍与确认时一致。导出完成可下载完整 ZIP。

主编辑器支持键盘 ← / → 快速逐帧预览：选中时间轴单元格后沿当前轨道切换步骤，选中左侧帧资产后沿资产列表切换；首尾停止，不循环。播放预览中按方向键会暂停并单步移动。输入框、弹窗和拖拽/绘画期间不会抢占按键，也不会修改素材或帧参数。

如果预览只露出角色局部，并提示“存在越界或空帧”，先检查公共画布和统一比例。比例 1 不会自动把大尺寸角色缩进 128×128 画布；可减小统一比例，或按所需输出尺寸增大画布并调整锚点。预览首次按 512×320 区域适配，512×640 画布默认显示为 50%；25%/50%/100%/200% 显示倍率只影响屏幕预览，不改变导出尺寸。修改后保存参数、执行全动作越界预检，再按动作模式完成相应人工验收；只缩小比例不能修复真正的空遮罩。

生产预览和导出采用主编辑器的位移、缩放、旋转和透明度：先绕完整源图中心执行帧变换，再应用地面根、公共比例/锚点和画布微调。编辑器位移以源图像素计，画布微调以输出像素计。修改帧属性会使旧审核失效；透明度或缩放为0，以及重采样后前景消失，均按实际输出Alpha判断为空帧；正式导出拒绝，草稿可保留。此路径仍输出主轨角色；多轨合成和攻击特效不在本次范围。

导入PNG的合法半透明像素无需存在不透明核心；Alpha为1或128的非空图仍须人工确认，但不会因此被误判为空。已导入的旧版PNG记录无需重导入。真正空图、擦空的结果与自动抠图的低置信噪声仍不能确认；原始Alpha不会被强行改成不透明。

主编辑器播放 FPS 范围为 1–120，提高 FPS 不生成中间帧。候选验收始终按固定候选的原始有理数时长播放，独立于主编辑器 FPS；播放前会缓冲候选图像。

## CLI、recipe 与 Codex

CLI 在 PowerShell 使用 `& '发行目录/sfs.exe'`。以下省略该前缀；每条命令传相同的 `--workspace '工作区绝对路径' --json`。可先运行 `--help` 与 `schema --name task_brief --json`，按真实返回的 ID 和基础内容令牌继续操作。

```text
doctor --json
project list
project create --name 小兵
project inspect --project PROJECT
import video --project PROJECT --file input.mp4
import images --project PROJECT --directory png-sequence
clip create --project PROJECT --source SOURCE --name 攻击
extract --project PROJECT --clip CLIP --wait
matte --project PROJECT --clip CLIP --wait
mask show --frame FRAME
mask edit --frame FRAME --strokes strokes.json
mask undo --frame FRAME
align --project PROJECT --axis AXIS --config alignment.json
inspect --project PROJECT --axis AXIS
preview --project PROJECT --axis AXIS
export --project PROJECT --axis AXIS --wait --output NEW_DIRECTORY
pipeline run --project PROJECT --axis AXIS --clip CLIP --recipe recipe.json --wait
job status --job JOB
job wait --job JOB --timeout 300
job cancel --job JOB
job resume --job JOB --wait
schema --name alignment --json
schema --name recipe --json
schema --name manifest --json
schema --name task_brief --json
schema --name candidate_manifest --json
task inspect --task TASK
candidate inspect --candidate CANDIDATE
candidate check --candidate CANDIDATE
candidate samples --candidate CANDIDATE
issue list --candidate CANDIDATE
operation inspect --operation OPERATION
operation resume --operation OPERATION --wait
mcp --stdio
gui
```

协作创建、修改与提交命令包括 `task create`、`candidate create/observe/submit/compare`、`issue repair`、`rework start`；使用 `--file` 传入符合 API 契约的 JSON，包含明确的基础身份与请求键。协作遮罩/对齐修改也需要 `base_content` 和相应修订，不能照搬无协作动作的最小参数。

基础动作命令的 `--axis` 可由 `--clip` 推导，只有一个动作时可省略。`--format png-sequence|grid-sheet|manifest` 校验格式名；共享导出总附完整包。既有非协作动作可用 `--draft` 检查未批准输出，`--timing source_pts|constant` 选择源逐帧时长或时间轴FPS/倍数；协作动作使用已接受候选的固定格式和时序，并在多任务时显式传 `--task TASK`。`--output` 要求新目录，拒绝覆盖。CLI 返回完整传输对象；帧和问题列表按游标读取完整分页，不能把摘要当作全部帧。

`alignment.json` 示例（坐标为源图左上像素边界，索引从0开始）：

```json
{"canvas":{"width":128,"height":128},"anchor":[64,112],"scale":1,"resampling":"pixel","mode":"ground_keyframes","roots":[{"index":0,"x":64,"y":112},{"index":2,"x":66,"y":112}],"offsets":{}}
```

高清卡通用 `resampling: "cartoon"`，采用预乘 Alpha 插值后还原直 Alpha。固定基准用 `mode: "fixed"` 和一个root；地面关键帧线性插值、区间外保持端点。

`recipe.json` 示例：

```json
{"schema_version":"1.0","extract":{"mode":"all"},"matting":{"backend":"rembg","model":"u2netp"},"output":{"draft":true,"timing":"source_pts","max_texture":2048,"gap":2,"margin":1}}
```

`--wait` 推进抽帧等已成功的自动阶段；生成抠图初稿后遇 `waiting_user` 停止。既有非协作动作在桌面逐帧审核后可用相同 recipe 继续；协作动作则走候选提交与独立人工验收。明确包含matting时，仅处理无遮罩或未审核的导入PNG初稿，保留已确认/已有自动或手工处理的遮罩。recipe可包含 `alignment`，它会修改公共预设并使旧审核失效。历史 `mask review` / `review apply` 不构成 maker 人工批准入口，普通 CLI/MCP 不能用确认文本代替桌面审核会话。

Codex 可直接执行 CLI；MCP 客户端配置可选择 stdio，程序为发行目录 `sfs.exe`，参数 `mcp --stdio --workspace <绝对目录>`。本项目不改已有全局配置。`skills/soldier-frame-studio/SKILL.md` 仅教调用实现接口，可在需要时由用户选择安装。先调用 `inspect_capabilities` 获取当前 maker 工具和真实限制；工具覆盖项目/来源、制作、候选/自检、问题/返工、原操作及固定交付，已移除旧九工具中的 `apply_review_patch`。大视频推荐CLI multipart；MCP `import_source` 接受已提供的视频字节且有大小限制，不接受服务器任意路径。

所有入口使用同一鉴权回环服务、项目修订、队列和产物。GUI不打开也可读取已接受候选的交付，或导出已有有效审核的非协作动作；新增人工批准必须在桌面完成。MCP保持客户租约；窗口关闭有任务时可保留后台、取消或返回，无客户无任务时服务空闲退出。

输出 `manifest.json` 含源帧索引、SHA256、逐帧有理数时长、规则图集左上矩形、公共画布与 Cocos y向上归一化锚点；序列不去重、不旋转、不逐帧裁边。`quality-report.json` 含空帧与越界检查。联系表最多256缩略图，完整序列和清单保留全部帧。`previews/preview-on-background.mp4` 是检查视频。`checksums.json` 支持校验，`assets.zip` 便于整包下载，旧成功版本不会被覆盖。

退出码：0成功、2无效参数/输入、3依赖、4待人工、5取消、6锁/修订冲突、1其他失败。`job status` 成功查询历史失败仍返回0。超时不会取消后台任务，错误应查询job或工作区 `.sfs/service.log`。丢失源/处理文件须重新定位或重新导入；不能以原图充作透明输出。

卸载删除解压目录；个人工作区、模型和素材默认保留。当前包未签名；1.0.8 包的验证结果以本次 Release 说明为准，本机换目录、限制 PATH 测试不等于干净 Windows 虚拟机验收。真实素材美术确认与 Cocos 实际播放仍应单独完成。[P2–P5 报告](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/blob/main/docs/evidence/p2-p5/report.md)保留历史阶段证据，不是本版干净机器或美术验收证明。
