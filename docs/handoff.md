# P2–P5 交接（2026-10-11）

最新入口：[P3–P5使用与Codex接入](p3-p5-guide.md)、[当前证据报告](evidence/p2-p5/report.md)、`docs/superpowers/plans/2026-10-11-p2-p5.md`。便携包在 `dist/发行便携版/小兵素材工坊 1.0.0`，双击SpriteMotionStudio.exe；CLI为同目录sfs.exe。P2–P5实现与本机打包验证已交付，264项Bun/15项Python/类型检查通过，实际可见GUI与CLI PNG/清单一致、300帧纹理8项、离线导入模型后CPU生成3帧待人工初稿、编译MCP九工具真实读取共享项目。模型不附包、不隐式下载。

旧工作区仍是 `workspaces/default`，默认便携数据位于当前用户LocalAppData，可通过菜单选择旧工作区。production_api_version 1.0不匹配的旧活动服务返回BACKEND_VERSION_CONFLICT，不能强行杀用户窗口/任务。审核绑定当前项目修订和raw/mask/rgba字节；mask review与alignment review均须真实明确人工检查，合成验收的test operator确认不得移植到真实素材。

当前修改包括大量前序未提交用户改动；没有Git写操作，保持原项目/源/遮罩及素材库保留成果。下一步仅真实角色质量确认、干净Windows验收与另行授权的P6；不要重做P2或把本机限制PATH叫干净VM。以下是前序交接历史。

2026-10-11素材库修复：项目导入原来只存项目帧、素材库UI默认自动抠图且允许视频却遭隔离入口403/503拒绝。现两入口都保留独立库副本，原视频/GIF及所有完整源帧登记为素材；`materialRetention.ts`统一谱系/副本/完整库抽帧和一次性旧数据补登记，重试复用ID。桌面仅完整抽帧，上传自动抠图明确转P2项目工作流；上传和详情/右键/批量抠图入口能力同步。原图保留不自动覆盖为后续P2结果。真实桌面验收脚本`scripts/verify_material_retention.ts`，API/隔离/跨项目/删项目/升级/防复活回归`tests/material-retention.test.ts`，CLI旧禁用断言已改为验证48帧库抽取。当前258项测试和server/web/CLI类型检查通过。用户工作区原素材库0；确认桌面窗口/服务已关闭且没有活动任务后，先备份再启动新版服务，已实际补登记1原视频及121张完整原帧（共122素材）。176个既有原图/处理图/源帧文件摘要及项目/帧/时间轴/遮罩表内容均未变化。备份`workspaces/default/backups/before-library-retention-20261011-115606.db`，验证`evidence/material-retention/current-workspace/20261011-115606/report.json`，真实UI通过`evidence/material-retention/desktop/2026-10-11T03-54-50.736Z`。启动的共享服务可供用户下一次桌面打开复用；没有强行关闭用户窗口或活动服务。

最新显示修复：用户询问每帧多重残影是否影响动画。红/蓝洋葱皮默认开启，仅编辑辅助，导出独立步骤从不包含洋葱皮。发现FrameEditor异步loadInto在播放隐藏effect之后又按onion=true显示邻帧，已改为读取playingRef确保播放期间不显示。真实Electron像素对照先失败后通过，编辑开关造成差异、固定同一预览帧开关前后像素一致：证据在`evidence/p2/desktop/2026-10-10T15-58-07.865Z`，旧失败保留在`15-57-33.121Z`。当前窗口可先点击画布眼睛关闭洋葱皮；新代码需共享服务重启载入。未改变用户素材或默认洋葱皮偏好。

最新素材设置：用户要求当前项目12 FPS，并明确“第1帧和第N+1帧为统一姿态”。默认test项目动作轴现为12 FPS；原31帧顺序保留，在末尾追加第32帧，与第1帧完整RGBA字节及位置/缩放/旋转/透明度/时长逐项相同。封口帧也经共享matte登记独立遮罩，原始源帧摘要不变；修改前SQLite备份位于默认工作区backups。实际验证见[evidence/loop-12fps/20261010-235056/report.json](evidence/loop-12fps/20261010-235056/report.json)。这是素材配置修改，没有改变应用默认帧率或进行补间；N帧到N+1的运动自然度仍取决于原动作。

当前仓库：`D:\AIJOB\tools\Sprite Motion Studio\framebaker`，分支`feature/soldier-frame-studio-v1`。本轮未提交、推送或创建远程。工作区已有指定范围预览等未提交改动，继续保留，不撤销。

P2功能和全局荧光糖果手绘UI已实现。入口为`Start-SFS.cmd` → 项目 → 场景抠图与修正；CLI增加`matte`、`mask show/edit/undo/review`。同批Rembg一个CPU session，缺依赖/模型明确失败，原图与自动/人工遮罩分开；持久撤销、待人工任务、异常标记和版本冲突已验证。数据库schema4升级前备份。源码位置与使用方式见[p2-guide.md](p2-guide.md)、[验证报告](evidence/p2/report.md)。

本机独立`.venv-image`安装Rembg2.0.76、ONNX Runtime1.31.0、Pillow12.3.0，模型`.models/u2netp.onnx`为本地CPU小模型；模型与环境均忽略Git。启动已有运行中的旧服务时可能仍展示旧界面/路由，需要正常关闭共享服务后重启；不要杀死正在处理用户任务的服务。

已验证：全仓库255项通过，Python8项通过，server/web/CLI类型检查通过；此前Windows CLI编译通过。真实Electron鼠标框选/误框失败与旧版保留/擦除/保存/刷新/撤销/确认通过；GUI隔离/CSP/本地鉴权无控制台错误。证据含完整命令/版本/退出码和截图；不把合成场景当真实小兵质量验收。

真实素材已获得：用户默认工作区的test项目31帧。截图问题来自ROI只框空白背景，小模型透明噪声也未被识别为异常。已新增纯背景/弱前景拦截、原图框选与明确文案；近纯色背景用外边连通色法，其他背景仍使用模型。用户当前31帧经共享API重做，第9帧盾牌内部从alpha121/0恢复255；原始SHA256全部不变、旧版本保留，任务仍waiting_user。详见[evidence/p2/roi-fix.md](evidence/p2/roi-fix.md)。地面阴影可能保留，复杂背景和全动作所有边缘还需用户逐帧美术检查；不能宣传自动质量普适合格。随后推进P3固定画布/统一比例/地面轨迹；P4正式导出与MCP、P5独立发行包、P6 Cocos尚未完成。

合成样例写入`fixtures/generated/p2-service`、`fixtures/generated/p2-desktop`隔离工作区。本次问题修复在用户默认工作区新增31帧自动遮罩版本，原视频、原始帧和旧遮罩不改动，没有操作游戏工程或上传媒体。模型首次安装脚本显式说明下载，也支持`-ModelFile`离线导入；Worker不隐式下载。用户原有桌面与共享服务未被强行关闭，重新打开抠图弹窗可读取修复后的图像；新界面/服务器代码须在合适时机重启共享服务载入。

