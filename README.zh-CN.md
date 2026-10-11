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
.\sfs.exe schemas
.\sfs.exe mcp stdio --workspace "D:\素材工作区"
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

### [0.5.0](docs/CHANGELOG.zh-CN.md#050---2026-09-02) · 2026-09-02

#### 新增

- 图片素材新增基于 imageops worker 的色键抠图：支持画布吸管取色、主色色盘、0–255 切比雪夫容差、可选边缘过渡、实时预览，以及保留源图的单张或批量应用。
- 所有生成弹窗新增可选纯色垫底图：支持高对比预设色、自定义颜色与基于素材主色的自动推荐；服务端通过 ImageMagick 临时合成引用图，绝不修改源素材或项目帧。

#### 移除

- 移除了参考图拆分中的目标骨架选择器：它只影响生成提示词与网格行列，下游切分、命名与绑定均不消费，且 `targetSkeletonId` 从未被服务端接收；拆分网格恢复为手动行列 + 人形默认值。

### [0.4.0](docs/CHANGELOG.zh-CN.md#040---2026-08-20) · 2026-08-20

#### 新增

- 角色绑定编辑器新增项目级关节角度修正：逐骨骼基础旋转随角色持久化，并统一应用于静止姿势、所有动作及 `.fbanim` 导出，不会修改共享骨架资产。
- 新增确定性的柔性附件变形：披风等软性部件支持画布弯曲拖拽，以及静态弯曲、播放摆幅、方向、频率和相位控制。
- 新增完整人物骨骼分件表工作流：支持逐格取图、直接拖动分隔线、矩形合并、右键横向/纵向细分、质量门禁预览，以及入库前逐部件擦除编辑。
- 骨骼切分弹窗新增连通域自动检测：按不透明块逐个识别为部件单元（阅读顺序排列），避免均匀网格切穿部件；检测出的每格仍可微调、切分、合并与命名。
- 新增人形骨架语义诊断与自动组装的共享层能力及测试（尚未接入界面）。
- 骨骼绑定的素材图片选择器新增文件夹筛选，支持多级目录路径以及“全部”和“未分组”视图。
- 素材库右键菜单、REST API 与 MCP 工具新增素材重命名，并立即同步当前打开的素材视图。
- 补齐图片素材右键菜单，可直接进入剪裁、逐帧/骨骼切分、人物拆分、多动作/八方向生成、还原抠图、导入、场景分层、自动裁边、导出与删除。
- 动作事件支持输入、校验并查看可选 JSON payload，数据随 MotionClip 持久化。
- 新增 MotionClip schema v2：逐片段 cubic-bezier 时间曲线、显式无损 v1 迁移、四元数缓动 slerp、曲线编辑及 `.fbanim`/光栅烘焙兼容。
- 部件新增自由变形：绑定编辑器中可为部件启用可拖拽的控制点网格（2×2/3×3/4×4）做静态变形，动作时间轴上的 `att:` warp 轨道以同样的网格增量打关键帧；变形位图按确定性光栅化（最近邻取样）生成，合成顺序在弯曲滤镜之前，并完整支持 `.fbanim` 导出再导入。

#### 调整

- 内置人形骨架及关节名称现会在骨架选择、动作编辑、画布提示、时间线和角色绑定中随界面语言切换，自定义名称仍保持用户原文。
- 优化人物分件提示词：用户指定的网格仅代表容量，允许多余透明格和超大部件占用连续矩形多格，并禁止为填满网格虚构部件或武器。
- 拖动分隔线时仅调整当前格及该边界正对的关联格，左右其他格不再随整条分隔线一起变化。
- 骨骼项目统一只输出 `.fbanim` 运行时包，移除逐帧项目兼容烘焙线路、RenderProfile 与 RasterSequence API。

#### 修复

- 选中附件的变换框现会直接接管画布拖动，重叠部件不再把弯曲或变换操作错误转移到其他图层。
- 橡皮擦拖出编辑画布时现会一直擦到图片实际边界，同时质量检查不再把几乎透明的抗锯齿残留误报为分件贴边。
- 修复骨骼项目编辑器不感知动作资产保存的问题：动作页签的实时预览画板与角色页签的骨骼/绑定视图现订阅 `animation_assets_changed`，动作编辑弹窗（或其他页面）一旦保存即重新拉取当前动作、骨架与资产列表。

[查看完整变更日志 →](docs/CHANGELOG.zh-CN.md)
<!-- latest-changelog:end -->
