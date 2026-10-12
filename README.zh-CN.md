# Sprint Motion Studio · 小兵动画素材工坊

基于 [FrameBaker](https://github.com/taotao7/FrameBaker) 二次开发的 Windows 动画素材工具。现在的界面采用糖果配色与手绘边框，支持视频完整抽帧、抠图修正、地面基准对齐、审核导出，以及共享工作区的 CLI / MCP。

**[下载 Windows 便携安装包](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/releases/latest)** · [使用说明](docs/p3-p5-guide.md) · [开发与验证记录](docs/evidence/p2-p5/report.md) · [二次开发说明](README_SFS.md)

## 当前界面

以下截图由当前 Windows 便携版实际运行拍摄，展示此前导入的「5s奔跑视频制作.mp4」及其逐帧角色素材。

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
- 调整公共画布、比例、地面根点及逐帧偏移，通过预览核对动作。
- 经审核导出透明 PNG 序列、规则多页图集、manifest、联系表、背景 MP4 与完整 ZIP；未审核内容可以显式导出草稿。
- GUI、CLI 与九工具 MCP 共用同一工作区、修订号与导出逻辑。

## Windows 安装与启动

1. 从 [Releases](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/releases/latest) 下载 `SpriteMotionStudio-win-x64-1.0.0.zip`。
2. 解压到可写目录，双击 `SpriteMotionStudio.exe` 或 `START.cmd`。这是便携安装包，无需另装 Node.js、Bun 或 Python。
3. 自动抠图需在「素材工坊」菜单离线导入或明确下载 u2netp 模型。模型没有随包附带，其余本地操作可断网运行。
4. 工作区默认存入当前用户 LocalAppData 下的 `SpriteMotionStudio/workspaces/default`，可通过菜单切换到已有工作区。

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
## 最近更新

### [1.0.7](docs/CHANGELOG.zh-CN.md#107---2026-10-12) · 2026-10-12

- 主帧编辑器新增键盘左右方向键，按当前动画轴逐帧预览，无需逐个点击时间轴单元格；保留输入框、弹窗和画布交互的按键行为。

### [1.0.6](docs/CHANGELOG.zh-CN.md#106---2026-10-12) · 2026-10-12

- 修正青色按钮的光晕状态：仅悬停时发光，移开后恢复贴纸阴影，保留键盘焦点提示。
- 场景抠图工作台支持键盘左右方向键快速逐帧预览；连续切帧丢弃过期图片响应，未保存笔画仍需确认，输入和绘画期间不抢占方向键。
- 素材库新增“项目 → 视频 / 照片”分区，上传可选择归属项目；依据现有来源 ID 补登记旧素材，保留共享素材、自定义文件夹和原文件。

[查看完整变更日志 →](docs/CHANGELOG.zh-CN.md)
<!-- latest-changelog:end -->
