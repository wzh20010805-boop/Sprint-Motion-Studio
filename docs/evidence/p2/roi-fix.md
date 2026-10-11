# 角色消失问题修复（2026-10-10）

用户截图显示粉色区域在角色左侧纯背景。真实任务记录确认两次ROI为`[154,140,224,268]`，源图1280×720；框外按既有语义被排除。旧Rembg结果虽然有59914个非零alpha像素，alpha>128仅2个，仍被旧检查当作正常。原图一直保留。后来框住角色的ROI为`[404,125,527,537]`，角色能出现，但盾牌内部两个抽样点alpha为121和0，说明小模型在这类插画上会抠穿装备。

修复：框选自动显示原图并解释保留区域；近纯色空区域及没有可见前景的自动结果拒绝提交整批，上一版保持；空/弱遮罩无法确认。98%边缘颜色接近中位数时采用外边连通背景色法，其余场景继续模型；不使用最大连通块筛选，不改原色，保留原始alpha与分离细装备。报告记录method和visible_fraction。Windows Python输出显式UTF-8，避免中文错误乱码。

先复现失败，再实现修复：原检查漏掉弱噪声、纯色空ROI未拒绝、分离细枪alpha仅18，以及中文错误乱码，均有实际失败；修复后对应回归通过。测试代码为`workers/image/tests/test_masks.py`、`tests/pipeline/masks-service.test.ts`和真实Electron的`probes/desktop/p2-scenario.cjs`。

| 验证 | 结果 | 证据 |
|---|---|---|
| 仓库完整测试 | 255 pass / 0 fail | [输出](roi-tests.txt) |
| Python完整测试 | 8 pass / 0 fail | [输出](roi-python-tests.txt) |
| server/web/CLI类型检查 | exit0 | `bun run typecheck`，工作目录仓库根 |
| Electron桌面 | exit0，误框拒绝/旧版保留/原图显示/保存撤销等通过，无console error | [报告](desktop/2026-10-10T11-23-45.453Z/desktop-report.json)、[可读中文提示](desktop/2026-10-10T11-23-45.453Z/p2-background-region-rejected.png) |
| 真实第9帧 | 错ROI拒绝不写RGBA；正确ROI头发/脸/鞋/盾牌/剑抽样保留，源SHA256不变 | [报告](roi-real-frame-fixed/report.json)、[预览](roi-real-frame-fixed/character/preview.png) |
| 默认test项目修复 | 31帧共享API生成edge_color初稿，原始SHA256全部不变、旧修订可查；盾牌两个样点alpha恢复255，任务waiting_user | [实际任务/路径报告](roi-project-repair/report.json)、[请求](roi-project-repair/request.json) |

使用父目录固定Bun1.4.2、`.venv-image` Python3.11/Rembg2.0.76/ONNX Runtime1.31.0/Pillow12.3.0；无新依赖、模型下载或媒体上传。早期真实帧检查失败的输出仍保留在`roi-real-frame/character`，不将它当通过证据。

边界：验证31帧生成与源图/历史完整性，以及第9帧明确部位，不等于逐像素全动作美术验收。地面阴影可保留，需要时用画笔擦除。复杂背景仍受小模型能力限制，同色/低对比边缘要人工修正。用户现有桌面和共享服务未强行重启，关闭并重开抠图弹窗能读取新图像；新界面和UTF-8服务代码需在共享服务下次重启后载入。
