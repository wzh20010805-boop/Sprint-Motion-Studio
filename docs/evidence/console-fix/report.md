# Windows 后台控制台设置修复

用户在视频导入后看到多个空白黑色窗口，导入面板显示成功1/失败0。排查时 FFmpeg 子进程已结束，未能将截图中的每个窗口与进程 PID 对应；不能据此声称逐一复现了截图。

确认的问题：`runPipelineCommand`、`runCmd` 和 CLI doctor 的 `Bun.spawn` 调用均未显式设置 `windowsHide`。FFprobe 探测、FFmpeg 抽帧和 PNG 完整解码会调用多个后台进程。三个入口现均设置 `windowsHide: true`，不改变抽帧参数、输出管道、退出码和取消逻辑。正常 Electron GUI 仍保持可见。

依据固定 Bun 1.4.2 的本地类型和 [Bun spawn 官方文档](https://bun.sh/reference/bun/spawn)，该参数用于隐藏 Windows 子进程窗口。

回归运行真实命令执行器，使用无控制台的编译测试宿主，子进程经 Win32 `GetStartupInfoW` 检查 STARTF_USESHOWWINDOW/SW_HIDE，并通过 `IsWindowVisible(GetConsoleWindow())` 检查控制台可见性。修复前两个执行器均未请求隐藏，修复后均请求隐藏且没有可见控制台。测试宿主、JSON 和失败日志均留在独立测试目录，不操作用户素材。

证据与边界：

- `red-startup-info-corrected.txt`：正确的原生启动信息检查，0通过/2失败，隐藏请求为 false。
- `green.txt`：修复后2通过/0失败，8次断言。
- `tests.txt` / `tests-meta.json`：全仓库246通过/0失败，33文件，退出码0；包含真实48/61/120/300帧抽取、VFR、损坏素材、取消及共享服务测试。
- `typecheck.txt` / `typecheck-meta.json`：server/web/CLI 类型检查退出码0。
- `build-cli.txt`：本地 CLI 已重新编译，退出码0。
- `restart.json`：确认当前工作区没有 queued/running 任务后，正常关闭本工具窗口并重启旧后台，新的 GUI 原生窗口可见，用户导入任务仍为 done。没有终止其他应用或删除素材。
- 早期直接/隐藏父进程测试仅检查窗口可见性，因控制台继承而没有检测到缺少显式隐藏设置，不能作为修复前已复现截图的证据。
- 早期测试夹具出现 PowerShell 进度输出和原生结构字符串字段封送错误，均已修正；相关失败日志保留，仅为夹具诊断。

本次没有安装抠图模型、CUDA 或推进后续功能阶段。
