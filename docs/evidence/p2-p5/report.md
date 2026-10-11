# P2–P5 实施与验证报告（2026-10-11）

本轮落实用户“实现p2，p3，p4，p5”的请求，使用所给v1.0方案作为范围参考；方案中的P6/修改游戏/公开发布/全局配置不视作授权。继续现有未提交工作区，保留前序素材库、播放范围和糖果UI成果。没有提交/推送Git，没有修改默认用户项目、源素材、遮罩审核或游戏。

P2既有实现通过回归，增加指纹缓存复用、坏JSON/像素摘要恢复及按项目隔离。P3实现固定/插值地面基准、角色公共画布/锚点/比例、逐帧微调、源/合成对比、洋葱皮和实际时长播放，Pillow预乘Alpha缩放。P4统一服务端透明序列/规则多页图集/manifest/检查报告/联系表/背景MP4/完整ZIP、审核闸门、旧结果拒绝、持久恢复、CLI schemas/recipe/有界stdout和九工具MCP。P5实现独立Electron桌面、单实例、本地鉴权资源、可写用户目录、工作区切换、后台关闭策略、明确可选模型、固定运行时、依赖/许可登记与SHA256。

## 实际证据

环境：Windows11专业版，10.0.26200，64位；开发Bun1.4.2，Electron44.7.0，Python3.11.9，Pillow12.3.0、Rembg2.0.76、ONNX Runtime1.31.0。FFmpeg实际完整buildconf随包保存（n8.1.1-118-g1034b144ff-20260615，GPL/version3）。所有项目与用户profile均为隔离合成夹具，非用户美术验收。

| 检验 | 结果 | 证据 |
| --- | --- | --- |
| 全仓Bun回归 | exit0，264通过、0失败，43文件；初始基线258通过 | [完整输出](bun-tests.txt) |
| 追加跨动作预设/PNG Alpha/recipe检查 | exit0，共同比例与画布更新，旧动作根独立；原Alpha128保持，ZIP有效 | [HTTP生产检验](production-tests.txt) |
| Python图像回归 | exit0，15通过：精确根插值、身体起伏、跳跃/下蹲/死亡、细武器、越界、预乘Alpha、多页RGBA矩形、时长、遮罩/坏缓存 | [输出](python-tests.txt) |
| server/web/CLI类型检查 | exit0 | [输出](typecheck.txt) |
| 真便携版换目录 | 从初始构建目录移动到中文/空格发行目录；cwd=C:/Windows/Temp，只保留Windows系统PATH | [摘要](summary.json) |
| 无模型离线启动与依赖 | doctor成功、matting=false；独立Python import PIL/numpy/onnxruntime/rembg成功；本地Pixi/Worker/字体HTTP200 | [doctor](doctor.json)、[Python](python.json)、[桌面](desktop.json) |
| 可见GUI实际流程 | 3张透明PNG导入；逐帧确认、插值字段65.0、保存、越界检查、显式对齐确认、正式ZIP导出；窗口实际可见 | [桌面结果](desktop.json)、[亮色](alignment-light.png)、[暗色](alignment-dark.png)、[输出](reviewed-export.png) |
| GUI与关闭GUI后的CLI正式输出 | 同一输入修订，PNG摘要、图集和manifest除export_id全部一致；pipeline --wait --output成功复制新包 | [摘要](summary.json)、[GUI清单](gui-export.json) |
| 300帧实际时间轴 | 300次实际选帧，最终与峰值纹理别名8项；128px惰性缩略图 | [桌面结果](desktop.json)、[截图](300-frame-timeline.png) |
| 真实编译版MCP | 初始化、九工具白名单、inspect_project读取同服务3帧；源测试另覆盖跨空闲期限调用 | [调用输出](packaged-mcp.json)、[摘要](packaged-access-summary.json) |
| 包内CPU模型/Worker | 明确复制已有登记权重到测试用户目录；单session生成3帧复杂背景初稿，退出4/waiting_user，未伪造审核 | [任务输出](model-matte.json)、[摘要](packaged-access-summary.json) |
| 鉴权/路径/竞态/恢复 | 未授权HTTP401，错误Origin/WS/越界路径拒绝；当前审核之外不能正式导出，GUI改修订/外部改RGBA字节后拒绝；旧导出不覆盖，取消/恢复通过 | [回归](bun-tests.txt)、[生产检验](production-tests.txt) |
| 旧服务版本 | 对仍健康的P2服务返回BACKEND_VERSION_CONFLICT，不杀旧服务/任务；新版协商production_api_version=1.0 | [回归](bun-tests.txt) |

独立最终审查发现的六处问题已修复：共享缓存临时文件竞争（按项目隔离+每进程临时名）、坏JSON结构恢复、MCP空闲失联（客户心跳）、根插值显示、保存时原图点击竞争、CLI启动后的切换工作区env优先级。额外修复recipe输出阶段、未审核PNG的显式抠图阶段（保留已确认帧）、包内PATH查找、CSP对Pixi data/blob资源误拦截，以及对齐面板外观。首次失败验证保留在fixtures/generated，不把失败输出改为成功。

## 交付与复现

发行目录：`dist/发行便携版/小兵素材工坊 1.0.0`，双击SpriteMotionStudio.exe；CLI sfs.exe。包内含START.cmd、中文说明、CLI与Codex接入、项目内Skill、sfs-package.json、licenses、SHA256SUMS.json。最终ZIP及SHA256位于同级，归档脚本验证全ZIP CRC和整包SHA256。约1.34GiB解压大小，模型不附包。

最终ZIP：`SpriteMotionStudio-win-x64-1.0.0.zip`，548109699字节（约523MiB），9328个内容文件，完整CRC校验通过；SHA256 `8fbf1713c66679d99b92150f03ec28f4426ab68d9c6f5c4524e44a835e97165e`。[归档数据](archive.json)、[校验和](archive.sha256)、[依赖快照](dependencies.json)。早期候选归档保留为candidate，不作为最终包。

```powershell
& '../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe' test tests
& '.venv-image/Scripts/python.exe' -m pytest workers/image/tests -q
& '../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe' run typecheck
& '../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe' scripts/build_portable.ts '<不存在的新发行目录>'
& '../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe' scripts/verify_portable.ts '<发行目录>' '<新证据目录>'
& '../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe' scripts/verify_packaged_access.ts '<发行目录>' '<上述证据目录>' '<已登记本地u2netp权重>'
& '.venv-image/Scripts/python.exe' scripts/archive_portable.py '<发行目录>' '<新ZIP路径>'
```

已有项目仍在开发工作区workspaces/default；便携版默认用户LocalAppData，可通过菜单选择旧目录。旧服务须先保存/完成任务/关闭窗口再空闲退出，新版不会强行接管。原图、失败staging、历史导出和审核记录保留；GUI或Agent的合成test operator确认不适用于真实素材。

## 尚未完成的外部验收

- 本机换目录、限制PATH、阻止外连、无模型运行已测；没有执行干净Windows虚拟机首次断网验收，不能把它标为T19全部通过。
- 真实角色连续动作的边缘、阴影、装备与根标注仍需用户逐帧美术确认。现有default项目未被本轮自动审核或改写；Rembg小模型初稿不能宣传普适质量合格。
- 没有进行P6 Cocos Creator3.8.8实际工程播放、签名安装包或公开发布。对外发布前还需落实FFmpeg/Bun静态依赖对应源码/重链接等实际分发义务；源码与许可登记见[FFmpeg](https://www.ffmpeg.org/legal.html)、[Bun1.4.2](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md)、[U2Net](https://github.com/NathanUA/U-2-Net/blob/master/LICENSE)。未宣称外部分发许可审查完成。
