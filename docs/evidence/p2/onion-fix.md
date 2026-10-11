# 预览残影检查（2026-10-10）

编辑器默认叠加红色前帧(alpha0.3)、蓝色后帧(alpha0.2)，眼睛开关控制洋葱皮；导出使用每一步的帧与特效，不读这些辅助Sprite。源PNG若自身已有运动拖影，则属于素材内容，不能据此承诺无拖影。

发现预览Bug：播放effect先隐藏邻帧，但异步纹理完成后loadInto只检查onionRef，重新显示邻帧。修复改为`onionRef.current && !playingRef.current`，不影响主帧。

真实Electron回归使用相同源图、相邻帧偏移32px，固定预览第1帧以消除动作变化。编辑时洋葱皮开/关像素应不同；播放时开/关像素必须一致。先看到正确失败：[失败报告](desktop/2026-10-10T15-57-33.121Z/desktop-report.json)；修复后exit0，像素对照通过，consoleErrors为空：[通过报告](desktop/2026-10-10T15-58-07.865Z/desktop-report.json)。初次试验三帧全重叠、洋葱皮被不透明主图盖住的失败也保留在15-56-22.082Z，不当作产品Bug证据。

命令（仓库根）：设置`SFS_PROBE_SCENARIO=onion-preview`后以固定Bun运行`scripts/verify_p2.ts`，沿用原隔离桌面工作区，只结束本次测试自己的服务。另跑完整`bun run test`及`bun run typecheck`；测试输出见[onion-tests.txt](onion-tests.txt)。没有修改用户的32帧/12FPS素材，也未强行重启当前桌面服务。当前用户窗口可通过眼睛按钮关闭洋葱皮；新程序代码在服务下次重启后载入。
