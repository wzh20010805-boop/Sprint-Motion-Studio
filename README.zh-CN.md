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

### [1.0.0](docs/CHANGELOG.zh-CN.md#100---2026-10-11) · 2026-10-11

- CI 在 Linux 和 Windows 执行完整测试，校验并准备 FFmpeg/ffprobe，显式安装 Electron。源码 CLI 在 PATH 隔离时复用当前 Bun；Windows 实测原生窗口测试，并保留版本、路径与测试证据。

- SFS P3–P5：角色公共画布/比例/地面根关键帧、Pillow共享预览导出、修订+字节审核、不覆盖旧成功版本的PNG/图集/清单/ZIP、任务恢复与缓存校验、离线CLI schemas/recipe与九工具MCP、独立Windows Electron/Bun/Python/FFmpeg便携包。本机换目录/包内运行时/300帧/GUI-CLI一致验证通过；干净虚拟机与真实素材人工质量确认仍待验收。

- 统一桌面项目导入与素材库上传：独立保留原图片、视频/GIF原件、全部源帧和完整时序，跨项目复制复用；重复抽帧不重复登记，首次升级补登记旧项目资料。上传界面关闭不可用的自动抠图/旧采样/生成，视频右键改为完整抽帧。

- 修复洋葱皮纹理异步加载完成后在播放预览重新出现的问题；编辑时仍可用眼睛开关对照前后帧，导出PNG只合成当前步骤。

- 修复误框背景导致角色消失：框选自动切回原图，纯背景/弱透明结果整批失败并保留旧版本，Windows中文错误使用UTF-8；近纯色场景按连通背景色去除背景，避免盾牌抠穿、细武器消失。

- P2：CPU Rembg 单 session 批量抠图、完整源图坐标 ROI、独立自动/人工遮罩、擦除/恢复笔刷、持久撤销、Alpha/黑白底对照、待人工任务和共享 CLI 接口；缺引擎不再复制原图冒充成功。
- 全界面改为高饱和糖果色、荧光点缀、手绘贴纸轮廓和原创矢量小兵，覆盖亮/暗主题。

- 逐帧预览新增“全部帧 / 指定范围”切换与起始、结束帧输入：包含两端循环，支持单帧，沿用各帧时长；删帧自动收缩、切换动作重置。仅影响预览，不改变素材或导出。

- Windows 媒体探测、抽帧、兼容任务命令和 CLI 环境检查显式隐藏后台控制台；新增真实 Win32 启动参数与可见性回归，正常编辑器窗口仍可见。

- 修复 Windows 双击 Start-SFS.cmd 后只有隐藏进程、没有窗口的问题；正常 GUI 启动不再使用 windowsHide，新增真实批处理启动的窗口可见性回归。

- 小兵工坊 P0：固定上游历史，核验 Windows/Bun/FFmpeg/许可和 Electron 桌面路径，保留真实失败证据。
- P1：完整显示帧、精确 PTS/有理数时长、不可变源素材、迁移前一致备份、共享 GUI/CLI 服务和持久任务；默认全部原始帧，显式旧采样。
- 隔离服务只监听 loopback，检查 API/WS 令牌、Host、Origin；未准备的抠图明确失败。修复缓存复用校验、失效锁竞争和 interrupted GUI 收尾。
- 严格 CSP 下使用已安装 Pixi 无动态代码生成兼容模块；场景抠图和独立发行包尚未完成。

### [0.5.0](docs/CHANGELOG.zh-CN.md#050---2026-09-02) · 2026-09-02

#### 新增

- 图片素材新增基于 imageops worker 的色键抠图：支持画布吸管取色、主色色盘、0–255 切比雪夫容差、可选边缘过渡、实时预览，以及保留源图的单张或批量应用。
- 所有生成弹窗新增可选纯色垫底图：支持高对比预设色、自定义颜色与基于素材主色的自动推荐；服务端通过 ImageMagick 临时合成引用图，绝不修改源素材或项目帧。

#### 移除

- 移除了参考图拆分中的目标骨架选择器：它只影响生成提示词与网格行列，下游切分、命名与绑定均不消费，且 `targetSkeletonId` 从未被服务端接收；拆分网格恢复为手动行列 + 人形默认值。

[查看完整变更日志 →](docs/CHANGELOG.zh-CN.md)
<!-- latest-changelog:end -->
