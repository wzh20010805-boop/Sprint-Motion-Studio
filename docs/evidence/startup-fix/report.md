# Windows 桌面启动修复

2026-10-10：用户反馈双击 `Start-SFS.cmd` 后没有窗口。已在本机复现并修复。

根因是 CLI 创建 Electron 时设置了 `windowsHide: true`，正常启动也隐藏了 Windows 原生窗口。后端可用、页面已经加载，却没有可见窗口。此前的隐藏模式桌面测试没有覆盖正常启动的窗口可见性。

修复为 `windowsHide: !!flags.smoke`，只有显式 smoke 测试隐藏窗口。新增回归通过实际 `cmd.exe` 调用 `Start-SFS.cmd`，工作目录使用 Windows 系统目录，检查真实 Electron 窗口的 `isVisible()`，测试完成后退出自己的 GUI 和服务，保留测试数据。

验证证据：

- `visible-red.txt`：修复前窗口可见性测试失败，实际值为 false。
- `visible-green.txt`：修复后直接 CLI 启动测试通过。
- `launcher-green.txt`：实际批处理入口测试通过，1通过/0失败，3次断言。
- `launcher-harness-quoting-error.txt`：测试夹具早期 cmd 引号错误，已修正调用方式，保留原始失败日志。
- `regression.txt`：CLI 与运行时回归9通过/0失败，52次断言。
- `typecheck.txt`：server/web/CLI 类型检查退出码0。
- `build-cli.txt`：重新编译本地 CLI，退出码0。
- `actual-launch.json`：从 `C:\Windows\Temp` 调用实际启动脚本后，窗口标题“FrameBaker · 像素动画编辑器”，原生窗口句柄非零。

仅终止了本仓库同一工作区此前留下的两个隐藏 Electron 主进程，随后重新启动正常窗口。共享后端、素材和中间数据保持保留。此次仅修复启动问题，没有推进后续抠图或 Cocos 接入阶段。
