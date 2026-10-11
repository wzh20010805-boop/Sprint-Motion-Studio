# CI 失败核验与平台修复

## 原始运行

- 运行：[38017850528](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/actions/runs/38017850528)，push，任务 `Typecheck and test`，job 114112019957。
- 提交：`6290605bdcb5ba9aa88adb1148972e8441722511`。
- 工作流：该提交的 `.github/workflows/ci.yml`，只有 Ubuntu，Bun 1.3.14；锁定安装、类型检查成功，没有准备媒体工具，测试失败。
- 原始结果：210 pass / 12 fail / 2 skip。完整抽帧测试的 beforeAll 失败，后续用例没有执行，不能用这次计数代表全部测试覆盖。
- 原始日志保留在本工作目录 `docs/evidence/ci/original-job.log`（遵循现有日志忽略规则，未发布）；运行元数据为 `docs/evidence/ci/original-run.json`。

## 12 项失败逐项分类

下表记录原始日志的首个失败证据。依赖失败不等于证明其后续代码没有错误；修复后仍须在两个平台执行完整测试。

| # | 文件 / 用例 | 原始证据 | 分类与处理 |
|---|---|---|---|
| 1 | cli.test / doctor 输出一个 JSON 且模型未准备不会冒充可用 | 预期退出 0，实际 3 | 媒体依赖未准备；工作流显式安装并运行 doctor。原日志没有该命令捕获的完整 JSON，不能仅凭日志断言是哪一个工具缺失。 |
| 2 | cli.test / 不开 GUI 完成真实 48 帧流程 | 生成视频时 `ffmpeg ENOENT` | 缺依赖；准备完整 FFmpeg 构建。 |
| 3 | cli.test / 缺少 ffprobe 返回依赖错误 3 | 创建项目就退出 3，预期 0，尚未到导入断言 | 真实运行时及平台适配错误：隔离 PATH 后 CLI 无法找到 Bun；Linux 的 SystemRoot 也不成立。源码 CLI 复用 process.execPath；测试清空 PATH 并排除旁置 Bun，在两平台实际走到媒体依赖错误。 |
| 4 | extract-all.test / unnamed beforeAll | fixtures/make.ts 调用 `ffmpeg ENOENT` | 缺依赖；整组真实媒体测试初始化失败，必须重新完整执行。 |
| 5 | gui-launch.test / Start-SFS.cmd 从其他目录实际显示窗口 | `cmd.exe ENOENT` | 平台不适用；Win32 批处理及可见性放在 Windows 实测，Linux 仅跳过此原生用例。 |
| 6 | cache.test / 损坏 PNG 和截断时序阻止入库 | 子进程 fixture `ffmpeg ENOENT` | 缺依赖；原缓存校验断言保留。 |
| 7 | cache.test / IHDR 有效仍必须完整解码 | 子进程 fixture `ffmpeg ENOENT` | 缺依赖；完整解码断言保留。 |
| 8 | cache.test / 时序路径和显示时长篡改 | 子进程 fixture `ffmpeg ENOENT` | 缺依赖；时序校验断言保留。 |
| 9 | service.test / HTTP imports validated immutable source | fixture `ffmpeg ENOENT` | 缺依赖；不可变原始素材和安全编辑副本断言保留。 |
| 10 | service.test / cancelled extraction publishes no completed DB source | fixture `ffmpeg ENOENT` | 缺依赖；取消保留原始数据的断言保留。 |
| 11 | service.test / GUI edit during extraction rejects stale commit | fixture `ffmpeg ENOENT` | 缺依赖；过期提交及重试断言保留。 |
| 12 | service.test / legacy GUI default and direct all mode worker | fixture `ffmpeg ENOENT` | 缺依赖；共享源语义断言保留。 |

合计：10 项首先由依赖导致失败，1 项平台错误，1 项真实 CLI 运行时/测试平台错误。没有删除用例或降低原断言；缺 ffprobe 测试额外检查视频生成成功。

## 原来的两个跳过

`background-window.test.ts` 的两个测试分别验证完整抽帧和兼容任务在 Windows 显式隐藏后台控制台。它们调用 Windows PowerShell 与 GetStartupInfoW/GetConsoleWindow/IsWindowVisible，原有平台守卫在 Ubuntu 上跳过合理，但原 CI 没有 Windows 任务，导致一直未覆盖。

现在 Windows 任务必须实际执行这两个测试及可见 GUI 启动测试；Linux 的三个跳过全部对应 Win32 原生行为，其他测试继续完整运行。Windows 不应出现这些跳过。

## 修改及路径核验

- CI 使用 Ubuntu 24.04 / Windows 2025 矩阵、Bun 1.4.2（与隔离 Windows 运行时一致）。两个任务都安装媒体依赖、核对实际命令来源及版本，再运行 doctor、类型检查和完整测试；失败仍上传证据，不忽略失败退出码。
- `scripts/ci/prepare-ffmpeg.ps1` 下载 BtbN 的两个平台 FFmpeg 8.1 构建，校验发布的 SHA256；确认 ffmpeg 和 ffprobe 都来自本轮准备目录且实际执行成功。路径、版本、摘要记录在 artifact 的 `ffmpeg.json`。
- Windows 安装桌面锁定依赖，Node 24 执行 Electron 的正式安装器，并检查 electron.exe；锁文件安装本身不保证桌面二进制存在。
- CLI 的旁置 bun.exe 路径限制为 Windows；源码入口优先复用当前 Bun，编译出的 sfs.exe 不递归启动自身。doctor 的隔离 Python 路径按 Windows Scripts / POSIX bin 区分。
- 缺媒体依赖测试不再把 Windows System32 填入 Linux PATH。Windows 原生测试中的 System32/powershell.exe 与 GUI 启动中的 cmd.exe 保留于 Windows 平台守卫内。
- CI 没有开发者盘符、Downloads 路径或固定机器绝对路径；本地 doctor 记录的 Downloads 路径只是实际安装位置，不用于云端配置。
- 独立工作树 `ci-platform-fix` 从失败提交建立；原开发工作区未提交的业务/UI/素材修改及 Cocos 工程保持原状。

## 验证记录

- Windows 本机：`bun run typecheck` 退出 0；`bun test tests` 在原本安装的 FFmpeg 与 CI 同来源的新 BtbN 8.1.3 构建下均为 246 pass / 0 fail，4555 次断言，三个 Win32 测试全部实际执行。
- PATH 隔离回归：修复前同一测试在项目创建时退出 3（失败）；修复后创建成功且实际导入时返回 DEPENDENCY_MISSING / 3（1 pass / 0 fail，4 次断言）。见 runtime-red.txt / runtime-green.txt。
- Electron 44.7.0 通过正式安装器成功下载；本机网络需进程级代理，代理没有写进 CI 或全局配置。
- 本机没有可用 Linux 子系统，不模拟云端 Linux 成功。云端矩阵运行结果及链接在提交后的核验记录补充；没有云端结果之前，不以本机通过宣称 CI 完成。
