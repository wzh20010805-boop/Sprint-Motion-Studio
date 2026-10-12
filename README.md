# Sprint Motion Studio · 素材创意工坊

基于 [FrameBaker](https://github.com/taotao7/FrameBaker) 二次开发的 Windows 动画素材工具。现在的界面采用糖果配色与手绘边框，支持视频完整抽帧、抠图修正、地面基准对齐、审核导出，以及共享工作区的 CLI / MCP。

**[下载 Windows 便携安装包](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/releases/latest)** · [使用说明](docs/p3-p5-guide.md) · [开发与验证记录](docs/evidence/p2-p5/report.md) · [二次开发说明](README_SFS.md)

## 界面与工作流程示例

以下实拍截图展示此前导入的「5s奔跑视频制作.mp4」及其逐帧角色素材。最新版本的界面调整与功能更新见下方变更日志。

| 动画编辑器 · 抠图后的奔跑角色 | 素材库 · 保留视频与完整原帧 |
| --- | --- |
| ![当前小兵动画编辑器](docs/media/sfs/editor.png) | ![当前素材库](docs/media/sfs/library.png) |

## 奔跑案例

使用此前导入的原视频展示实际来源，用项目现有帧生成动作预览。原视频保留背景，抠图修正后的角色以棋盘格显示；示例不代表所有帧已经通过人工质量审核。

| 导入的原视频 | 当前项目的抠图帧预览 |
| --- | --- |
| ![小兵原视频](docs/media/sfs/source-run.gif) | ![小兵抠图动作预览](docs/media/sfs/run-loop.gif) |

| 遮罩修正 | 地面基准与统一画布 |
| --- | --- |
| ![遮罩擦除和恢复](docs/media/sfs/mask-workshop.png) | ![地面基准与逐帧偏移](docs/media/sfs/alignment-workshop.png) |

[下载此案例的原视频](docs/media/sfs/source-run.mp4)。展示媒体用于说明本项目工作流程；沿用用户此前提供的素材，不属于项目 MIT 源码许可授权的素材库。

## 可以做什么

- 导入 MP4 / GIF 或 PNG 序列，保留原文件、完整显示帧与源时序。
- 本地 CPU 自动抠图、框选角色，擦除 / 恢复遮罩，撤销并逐帧检查透明边缘。
- 主编辑器和场景抠图窗口支持键盘 ← / → 快速逐帧预览。
- 素材库按“项目 → 视频 / 照片”浏览，支持跨项目复用与原件保留；照片分区包含视频抽帧图片。
- 调整公共画布、比例、地面根点及逐帧偏移，通过预览核对动作。
- 经审核导出透明 PNG 序列、规则多页图集、manifest、联系表、背景 MP4 与完整 ZIP；未审核内容可以显式导出草稿。
- GUI、CLI 与九工具 MCP 共用同一工作区、修订号与导出逻辑。

## Windows 安装与启动

1. 从 [最新 Release](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/releases/latest) 下载 Windows 便携 ZIP（文件名为 `SpriteMotionStudio-win-x64-版本号.zip`）。
2. 解压到可写目录，双击 `SpriteMotionStudio.exe` 或 `START.cmd`。这是便携安装包，无需另装 Node.js、Bun 或 Python。
3. **当前便携包未内置 u2netp 模型。** 没有安装模型的电脑，首次自动抠图需在「素材工坊」菜单选择“离线导入模型”或“下载 CPU 模型（需联网）”。已安装过的模型会继续复用，无需每次导入；模型准备好后，自动抠图也可断网运行。
4. 工作区默认存入当前用户 LocalAppData 下的 `SpriteMotionStudio/workspaces/default`，可通过菜单切换到已有工作区。

模型安装在当前用户的 `%LOCALAPPDATA%\SpriteMotionStudio\models`。你本机已有模型，并不表示下载的 ZIP 内也包含模型；将便携包发到另一台电脑时，需要在那里准备模型。导入素材、修正已有遮罩、预览和导出可离线使用。

包内附 SHA256 校验清单、许可、CLI / Codex 接入说明与示例媒体。本版已完成本机 Windows 启动、换目录、受限 PATH、300 帧纹理预算及 GUI / CLI 输出一致性验证；干净 Windows 虚拟机与真实美术质量验收尚未完成。二进制未签名。

## CLI 与 Codex

```powershell
.\sfs.exe doctor --json
.\sfs.exe project list --json
.\sfs.exe --help
.\sfs.exe schema --name recipe --json
.\sfs.exe mcp --stdio --workspace "D:\素材工作区"
```

完整参数、审核规则和 recipe 示例见 [P3–P5 使用说明](docs/p3-p5-guide.md)。项目提供 [本地 Skill](skills/soldier-frame-studio/SKILL.md)，不会自动修改全局 Codex 配置。

## 从源码开发

```powershell
git clone https://github.com/wzh20010805-boop/Sprint-Motion-Studio.git
cd Sprint-Motion-Studio
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup_sfs.ps1 -IncludeDesktop -IncludeValidationPython
.\sfs.cmd doctor --json
.\Start-SFS.cmd
```

源码启动需要 FFmpeg / ffprobe；安装说明见 [README_SFS.md](README_SFS.md)。开发检查：`bun test tests`、`bun run typecheck`、`python -m pytest workers/image/tests`。用户工作区、模型、虚拟环境及构建输出不提交到 Git。

## 来源与许可

保留 [FrameBaker](https://github.com/taotao7/FrameBaker) 的上游历史与 [MIT 许可](LICENSE)。Windows 包中的运行时、FFmpeg、字体和 Python 依赖各自遵循其许可证，详见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [依赖源码与重建说明](docs/licenses/distribution-sources.md)。上游界面和演示案例已由本项目实拍界面与用户此前提供的奔跑案例替换。

## 最近版本

<!-- latest-changelog:start -->
## Latest Changes

### [1.0.7](docs/CHANGELOG.md#107---2026-10-12) · 2026-10-12

- Add left/right keyboard navigation to the main frame editor so the current animation axis can be inspected step by step without clicking each timeline cell. Preserve input, dialog and canvas interaction shortcuts.

### [1.0.6](docs/CHANGELOG.md#106---2026-10-12) · 2026-10-12

- Correct cyan button glow: glow only on hover, restore the sticker shadow on pointer leave, and retain keyboard focus outlines.
- Add left/right keyboard frame navigation to the cutout workshop, with stale image response protection, unsaved stroke confirmation, and input/drawing guards.
- Group the material library by project, then videos/photos. Uploads can select a project; proven legacy associations, shared materials, custom folders and original files are preserved.

[View the complete changelog →](docs/CHANGELOG.md)
<!-- latest-changelog:end -->
