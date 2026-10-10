# 小兵动画素材工坊：P0 / P1 开发版

本批按照用户方案第20节完成 P0 后推进 P1。基于 FrameBaker 原有 React / Pixi、Bun / Elysia / SQLite 开发，保留完整上游 Git 历史。当前可以在独立工作区创建项目、导入视频、完整抽帧；GUI 与 CLI 共用一个后端和数据库。

**当前 PNG 是完整原始画面，仍有背景。P2 场景抠图、P3 对齐、P4 正式导出、P5 独立发行包、P6 Cocos 接入尚未完成。** 没有安装 Rembg 模型或 CUDA，也没有修改现有游戏或个人知识库。

## 本机运行

在 Windows 资源管理器打开 `D:\AIJOB\tools\Sprite Motion Studio\framebaker`，双击 `Start-SFS.cmd`。Windows 路径不需要前面的 `/`。窗口标题为“FrameBaker · 像素动画编辑器”。

在本仓库打开 PowerShell：

```powershell
.\sfs.cmd doctor --json
.\Start-SFS.cmd
```

`Start-SFS.cmd` 使用已经安装的 Electron 开发宿主，进入现有素材库。新建项目后，在项目编辑器的“导入 → 上传文件”选择 MP4；默认“全部原始帧”。旧 FPS 采样是显式选项，会主动跳帧。P1 界面明确提示抠图未准备。

首次准备 / 重建依赖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup_sfs.ps1 -IncludeDesktop -IncludeValidationPython
```

该脚本仅使用本工作区的 `.runtime`、仓库依赖和 `.venv-image`；固定 Bun 1.4.2，按锁文件安装 JS 依赖，Python 验证依赖仅 Pillow / pytest。FFmpeg 和 ffprobe 使用现有 PATH，不自动安装 GPU 栈或模型。Electron 是开发宿主，首次获取需要网络。

## 不开 GUI 的最小流程

```powershell
$ws = Join-Path $PWD 'workspaces\my-soldier'
$created = .\sfs.cmd project create --workspace $ws --name '小兵' --json | ConvertFrom-Json
$pidSfs = $created.project_id
$imported = .\sfs.cmd import video --workspace $ws --project $pidSfs --file 'D:\素材\attack.mp4' --json | ConvertFrom-Json
$clip = .\sfs.cmd clip create --workspace $ws --project $pidSfs --source $imported.data.source_id --name attack --json | ConvertFrom-Json
.\sfs.cmd extract --workspace $ws --project $pidSfs --clip $clip.data.clip_id --mode all --wait --json
.\sfs.cmd project inspect --workspace $ws --project $pidSfs --json
.\sfs.cmd gui --workspace $ws
```

示例视频路径需替换为自己的素材。JSON 的 ID 均来自真实响应。一次命令只向 stdout 输出一个 JSON，后台日志写工作区 `.sfs/service.log`。不加 `--wait` 会快速返回真实 `job_id`；随后可运行 `job status --job ID`、`job wait --job ID`、`job cancel --job ID`。每个命令都可附带 `--workspace`，默认仓库 `workspaces/default`。

退出码：0 请求接受 / 等待成功；1 未分类执行错误或等待超时；2 参数 / 输入错误；3 依赖 / 后端缺失；4 待人工处理；5 等待任务取消；6 修订 / 工作区 / 旧结果冲突。`job status` 查询历史失败任务仍返回0，`job wait` 则返回该任务对应失败码。超时不会取消后台任务。

## 数据和生命周期

```text
workspaces/<name>/
  framebaker.db                 # 唯一上游数据库，schema 3 增量迁移
  workspace.json               # 工作区标识
  backups/                     # 迁移前 SQLite 一致快照，包括 WAL
  sources/<source-id>/
    original.mp4               # 内容识别后复制一次，也可能 original.webm/bin
    source.json                # 原始名称、SHA256、探测结果
    raw/frame_000000.png        # 完整源帧，零起始整数索引
    timing.json                # 整数 PTS、time_base、有理数显示时长
    staging-*/                 # 失败/取消中间结果仍保留
  projects/<project-id>/raw/    # GUI 可编辑副本，独立于 sources/raw
  jobs/<job-id>/job.log
  .sfs/service.json            # 本地服务发现；含私密令牌，不提交/分享
```

抽帧不用采样 FPS、数量上限或去重。读取全部显示帧，按源整数索引排序；保留重复画面。数量、尺寸、所有 PNG 完整解码通过后才发布 raw 和 timing，错误不会提交完成的项目帧。复用缓存时也重新验证时间清单和 PNG。VFR 源时序精确保存；现有上游整数 tick 时间轴预览可能量化，输出 `PREVIEW_TIMING_QUANTIZED`，不能把预览当作精确源时长。

服务在加载数据库前取得工作区实例锁，只绑定 `127.0.0.1`。CLI 复用已存在的服务；Electron 通过 HttpOnly 本地 cookie 接入同一服务。API / WS 检查令牌、Host 和 Origin。无任务、无 WS 且闲置5分钟后服务退出；关 GUI 不会杀死共享服务或 CLI 任务。重启保留任务参数并标记 `interrupted`，P1 需重新提交抽帧，尚未实现分段恢复。

遇到 `service.recovery` 残留时先核查记录 PID 和 `.sfs/service.log`，确认没有该工作区服务后再人工处理；程序保守拒绝猜测性删除。原始文件、失败目录和日志均保留。GUI 删除/裁切只影响独立可编辑副本。首次仅使用短视频；磁盘预检查基于解码尺寸和实际探测帧数。

目前只接受可可靠处理的 SDR、逐行、方形像素、无旋转视频。HDR、交错、显示矩阵异常、缺失/非单调 PTS、损坏或无视频流明确失败。末帧没有可信时长时会估算并输出警告；唯一帧没有可信时长则失败。

## 验证与限制

- [环境与版本](docs/environment.md)、[上游审计](docs/upstream-audit.md)、[第三方许可](THIRD_PARTY_NOTICES.md)。
- [P0 桌面探针](docs/desktop-probe.md)：已验证固定 Bun + Electron 路径；完整 Bun 单 EXE 失败，失败证据保留。探针包有依赖开发目录的 junction，尚不能作为干净机器发行包。
- [P1 全帧报告](docs/evidence/p1/extraction-report.md)、[真实 PNG 检查](docs/evidence/p1/quality-report.md)、[开发进度与交接](docs/progress.md)。
- [P1 桌面验证](docs/p1-desktop.md)记录真实 GUI、同一项目 CLI 读回和截图。

测试样例是本机 FFmpeg 生成的合成视频。真实 PNG 已逐个解码并打开 contact sheet，但无法替代带场景小兵视频的武器、头发和装备抠图验收。P0 已实证上游无引擎时复制原图却标记 matted，P1 隔离入口明确阻止这类自动抠图请求。原始 `bun run start` 仍是上游兼容入口；本工具应使用 `sfs.cmd` / `Start-SFS.cmd`。

P1 保留素材库的静态图片编辑；素材库旧视频采样入口在隔离服务中禁用，完整视频从项目导入。云生成、提示词加强、外部 provider 测试和宽权限上游 MCP 在该入口禁用。设置页沿用上游页面，但不代表这些能力已开放。

开发验证（Bun 路径需按当前目录调整）：

```powershell
$env:PATH = (Resolve-Path '..\.runtime\node_modules\@oven\bun-windows-x64\bin').Path + ';' + $env:PATH
bun run typecheck
bun run test
bun run build:cli
.\dist\sfs.exe doctor --json
```

`dist/sfs.exe` 已编译验证，仍需要邻接仓库源码和固定 Bun（也可设置 `SFS_REPO_ROOT`）。它不是 P5 独立发行包。FFmpeg GPL 构建的再分发责任、模型权重许可和正式离线资源完整性，见包装研究；本批没有把 FFmpeg 或模型作为 MIT 软件发行。
