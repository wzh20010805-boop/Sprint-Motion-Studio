# P0 Windows Bun / Electron 可行性探针

实测日期：2026-10-10（Asia/Shanghai）。这里只验证沿用上游的 Windows 运行路线，不宣称交付完整桌面产品。

## 已运行结果

| 验证项 | 实际结果 | 证据 |
| --- | --- | --- |
| Bun Windows 独立 EXE | Bun 1.4.2，编译成功；运行健康检查 200 | `evidence/p0/bun-compile-attempt2.log`、`bun-report.json` |
| `bun:sqlite` | EXE 创建 WAL 数据库并读回 `compiled-bun-sqlite-ok` | `bun-report.json` |
| 内嵌 HTML / 资源定位 | `/`、`/resource.txt` 均 200；虚拟文件位于 `B:\\~BUN\\root\\assets` | `bun-report.json` |
| 原始上游完整编译 | 1049 模块编译成功；实际运行退出 1 | `bun-upstream-compile.log`、`bun-upstream-run.stderr.log` |
| 固定 Bun + 上游源码/资源回退 | 独立副本冻结安装成功；实际 FrameBaker API 和 UI 可启动 | `desktop-package-install.log`、`desktop-report.json` |
| Electron 44.7.0 Windows x64 | 本地 npm 包安装与显式二进制安装退出 0；实际包内启动退出 0 | `desktop-electron-install.log`、`desktop-package-run.log` |
| 真实页面与本地资源 | 素材库渲染；健康检查、PixiJS、中文字体、图像 Worker 均 200；WebSocket 成功 | `desktop-report.json` |
| 渲染隔离 | `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`；页面 `require` / `process` / `global` 均 undefined | `desktop-report.json` |
| 退出 / 重复启动 | 子进程收到停止请求并退出，端口关闭；重复烟测成功 | `desktop-report.json` 中 events、portClosedAfterStop |
| 启动目录变化 | 最终烟测 cwd 为 `C:\\Windows\\Temp`，资源仍正确定位 | `desktop-report.json` |
| 真实截图 | 已目视检查 1344 × 861 素材库截图；非占位页面 | `desktop-framebaker.png` |

最终 `smokePassed=true`、`exitCode=0`、`portClosedAfterStop=true`，`console=[]`、`blockedRequests=[]`。基线服务 `127.0.0.1:43187` 未被本探针停止或复用。

## 编译失败定位与允许的回退

完整上游 EXE 在启动阶段报：

```text
EPERM: operation not permitted, mkdir '\\'
at B:/~BUN/root/framebaker-upstream.exe:19623:10
Bun v1.4.2 (Windows x64)
```

上游 `db.ts` 使用 `join(import.meta.dir, "..", "..", "..")` 求源码仓库根目录。编译后 `import.meta.dir` 是 Bun 虚拟文件系统目录，该路径不能承载可写项目数据。最小 EXE 通过显式数据根目录，同时证明 SQLite 本身与内嵌静态文件没有平台阻塞。

回退包保持真实上游业务模块与数据库逻辑，在包内保留源目录关系，使用固定 `bun.exe` 执行 `service.ts`。该启动器仅组装上游 `app`、`wsHandlers` 和 HTML，显式绑定 `127.0.0.1`、请求系统分配端口；原始上游入口默认省略 hostname。源码未为探针重写，包内源文件 SHA256 已保存在 `desktop-package.json`。

第一次副本启动曾报 `Cannot find package 'memoirist'`：直接复制 Bun 的隔离依赖 junction 会改变模块解析目录。现用源码副本加 `bun install --frozen-lockfile` 生成正确布局；失败保存在 `desktop-attempt1-*`。另两次宿主调试发现 CSP 内联脚本哈希需要规范 CRLF、WebSocket 需要同源 ws 白名单，以及销毁窗口的默认退出可能抢先掩盖失败状态；这些均已修复并重新运行，初始记录保存在 `desktop-attempt2-*`、`desktop-attempt3-*`。

## 本机包与运行命令

当前目录：`probes/desktop/artifacts/framebaker-p0-win-x64/`，包含 `FrameBaker-P0.exe`、`runtime/bun.exe`、`runtime/backend/` 与 `resources/app/`。构建后约 624 MiB（不跟随依赖 junction 的计数）。Electron 官方 Windows zip 大小为 158293649 字节，缓存限定在 `probes/desktop/cache`。未执行全局安装。

以下 PowerShell 命令均使用明确的运行时；构建类命令工作目录为仓库根目录，最小 EXE 编译命令的工作目录单独注明。

```powershell
$bunProbeRuntime = 'D:\AIJOB\tools\Sprite Motion Studio\.runtime\node_modules\@oven\bun-windows-x64\bin\bun.exe'

# cwd: framebaker/probes/bun；实际退出码 0
& $bunProbeRuntime build --compile --target=bun-windows-x64 --asset=assets compiled-probe.ts --outfile artifacts/bun-probe.exe

# cwd: framebaker；编译退出码 0，上游原始 EXE 启动退出码 1
& $bunProbeRuntime build --compile --target=bun-windows-x64 apps/server/src/index.ts --outfile probes/bun/artifacts/framebaker-upstream.exe
& $bunProbeRuntime probes/bun/run-probe.ts

# cwd: framebaker；冻结的 Electron 版本在 probes/desktop/package.json 和 bun.lock
& $bunProbeRuntime install --cwd probes/desktop
$env:electron_config_cache = (Join-Path (Get-Location) 'probes/desktop/cache')
& 'C:\Program Files\nodejs\node.exe' probes/desktop/node_modules/electron/install.js

# 新副本的准备入口；现有 P0 快照保留，准备脚本会拒绝覆盖它
& 'C:\Program Files\nodejs\node.exe' probes/desktop/prepare-snapshot.mjs
& 'C:\Program Files\nodejs\node.exe' probes/desktop/build-package.mjs

# cwd: C:\Windows\Temp；最终实际退出码 0
$env:P0_EVIDENCE_DIR = 'D:\AIJOB\tools\Sprite Motion Studio\framebaker\docs\evidence\p0'
$env:P0_PROFILE_DIR = 'D:\AIJOB\tools\Sprite Motion Studio\framebaker\probes\desktop\artifacts\packaged-profile'
& 'D:\AIJOB\tools\Sprite Motion Studio\framebaker\probes\desktop\artifacts\framebaker-p0-win-x64\FrameBaker-P0.exe' --smoke
```

烟测模式使用隐藏窗口，自动捕获页面与退出；不带 `--smoke` 时显示实际编辑器。构建使用本机 Node v24.16.0 处理文件，后端实际由包内 Bun 1.4.2 运行。Electron 的 Node 24.21.0 仅位于主进程，不能替代 `bun:sqlite` 后端。

## P0 范围与后续事项

本次证明当前 Windows 主机上的启动、资源读取和关闭路线可行，尚未在干净机器或迁移后的目录运行。包内 Bun 隔离依赖的 Windows junction 含安装时路径；正式可复制分发包需要消除这些路径或改为已构建模块/合适的发行依赖布局。当前上游副本数据库仍位于包内 `runtime/backend/storage`，用户可写目录、升级保持数据、鉴权、实例锁、后台任务保留和正式日志策略属于后续阶段。

本探针没有打包 Python Worker、FFmpeg 或模型，没有真实角色素材去背景质量验收，也没有把截图当作完整功能测试。只运行本地界面及资源请求；宿主对白名单外请求直接拒绝，未触发云生成操作。

编译资产和运行路径依据 [Bun 单文件可执行文件文档](https://bun.sh/docs/bundler/executables)；宿主配置、CSP、导航限制和渲染隔离依据 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。目录包、源码快照、缓存和安装依赖应保持忽略，提交小型探针源码与本页证据即可。

## 供后续统一服务验证的可选附着模式

默认 P0 模式不变。显式设置 `SFS_SERVICE_URL=http://127.0.0.1:<port>/` 后，宿主只连接已有服务，不再创建或停止后端。若提供 `SFS_SERVICE_TOKEN`，加载页面前设置 `sfs_token` Cookie（HttpOnly、SameSite=strict），主进程健康/HTML请求使用 Bearer；令牌不写入报告。连接描述文件的路径不作任何默认假定，由调用方提供已解析的 URL 和令牌。

`SFS_PROBE_PATH` 可选 `/materials`、`/settings`、`/motions`、`/project/<id>` 或 `/`。`SFS_PROBE_REQUIRE_FULL_FRAMES=1` 要求当前可见页面含完整逐帧选项文字；调用方负责进入包含该选项的界面。后续测试必须设置新的 `P0_EVIDENCE_DIR`，保留 P0 默认运行证据。

`bun probes/desktop/run-attached-smoke.ts` 已在本脚本拥有的无鉴权 P0 fixture 上通过（退出 0）：真实 GUI 和资源加载、Cookie 属性、宿主退出后服务仍存活、报告不含令牌均通过。报告位于 `evidence/p0/desktop-attach/desktop-attach-test.json`。该 fixture 只证明附着和 Cookie 传递路线，P1 真实鉴权是否接受该 Cookie 由后续统一服务测试另行验证。
