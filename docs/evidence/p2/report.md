# P2 与荧光糖果手绘 UI 验证（2026-10-10）

后续真实素材修复：用户反馈误框背景导致角色消失。已新增有效遮罩拦截与近纯色背景处理，在默认项目31帧上复验并保留原图/旧修订。见[ROI问题修复](roi-fix.md)。下文是初次实现的历史证据，Python用例现增至8项，“尚未提供真实素材”已由本次真实项目验证补充。

P2功能已实现；真实小兵视频质量人工验收仍待素材。复用原React/Pixi/Bun/Elysia/SQLite，保留之前指定帧范围预览等工作区改动，未提交、推送或改动游戏。

## 结果与证据

| 验证 | 实际结果 | 证据 |
|---|---|---|
| 原仓库基线 | 246通过，0失败 | 本轮改动前实际执行 `bun test tests` |
| 全仓库最终回归 | exit0，255通过，0失败，36文件 | [完整输出](tests-final.txt) |
| Python遮罩/模型回归 | exit0，5通过 | [输出](python-tests.txt) |
| server/web/CLI类型检查 | exit0 | [输出](typecheck-final.txt) |
| Windows CLI编译 | exit0，生成`dist/sfs.exe` | [输出](cli-build.txt) |
| 编译CLI doctor | exit0，本地模型/CPU环境可见 | [实际JSON](compiled-doctor.json) |
| 真实CPU与CLI复验 | batch单session、3帧、修正、冲突、重启、撤销、审核、CLI等待退出4→确认→退出0通过 | [服务测试输出](service-final.txt)、[源图变化复验](source-change-test.txt) |
| Electron桌面 | exit0；实际鼠标框选/擦除、保存、页面重开、持久撤销、确认，关闭重开接回运行中任务 | [桌面完整报告](desktop/2026-10-10T11-03-39.895Z/desktop-report.json) |
| 安全与资源 | 严格CSP、本地鉴权、WS、自托管资源通过；控制台无error，外部请求0；附着GUI不停止共享服务 | 同上 |
| 视觉检查 | 已打开亮色首页、亮/暗工作台和放大后修边截图；面板在1360×900窗口内，系统圆润字体，无像素扫描线 | [亮色首页](desktop/2026-10-10T11-03-39.895Z/p2-home-light.png)、[修边工作台](desktop/2026-10-10T11-03-39.895Z/p2-cutout-brush-light.png)、[暗色工作台](desktop/2026-10-10T11-03-39.895Z/p2-cutout-dark.png) |

命令工作目录均为仓库根目录`D:\AIJOB\tools\Sprite Motion Studio\framebaker`。使用父目录`.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe`，Bun1.4.2；Python3.11独立环境、Rembg2.0.76、ONNX Runtime1.31.0、Pillow12.3.0。[依赖锁记录](python-lock.txt)、[命令元数据](verification-meta.json)供续作。

测试命令：`bun run test`、`.venv-image/Scripts/python.exe -m pytest workers/image/tests -q`、`bun run typecheck`、`bun run build:cli`、`dist/sfs.exe doctor --json`、`bun scripts/verify_p2.ts`。桌面测试为真实Electron渲染器与鼠标事件，非DOM mock。

## 覆盖范围

- T07：无引擎不再复制原图，状态不进入ready；缺失/损坏模型报错，损坏权重不被Worker联网修复。
- T08：恢复离开角色的1像素竖枪、保留原图128半透明像素，原色与局部擦除不变；没有最大连通域过滤。
- T12：自动/人工遮罩不可变且分别保存，页面刷新、服务重启保留，已保存修订可撤销；原始PNG摘要不变。
- 自动初稿任务保持waiting_user、requires_user_action，含模型SHA256、异常帧、遮罩/真实RGBA/预览路径；逐帧确认完成后任务变done。
- GUI与CLI同业务接口；旧项目修订、旧遮罩和改变后的原图不能覆盖现有内容。ROI使用完整原图坐标，最终画布尺寸不变。

UI统一采用荧光粉/薄荷绿/亮紫/柠檬黄、手绘圆角和厚轮廓、偏移贴纸阴影、原创矢量小兵。覆盖项目、素材库、编辑器、时间轴、弹窗、任务面板、设置和亮/暗主题；源素材画风不被改变。

## 限制与后续

合成输入为程序绘制的128×128场景与角色，不是用户真实素材。实测小模型初稿会漏掉身体和细枪，只留下粉色头部；人工恢复功能能找回原始像素。这是功能验证，不能宣称自动分割质量合格。真实动作的头发、盾牌、装备和连续帧质量需在用户授权视频上逐帧验收。

本机开发宿主可用，尚未完成P5干净机器发行包。P3全局比例/地面轨迹、P4正式审核导出/恢复/MCP、P6 Cocos接入仍在后续阶段。当前可下载单帧RGBA初稿检查；上游前端导出保留为兼容入口。没有启用云生成、付费API或素材上传。

