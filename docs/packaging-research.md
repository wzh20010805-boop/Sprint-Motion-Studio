# P0 Windows 打包研究

核验日期：2026-10-10。范围：FrameBaker → Soldier Frame Studio 的 Windows x64 桌面宿主、Bun 服务、CPU 图像 Worker 与 FFmpeg 分发。本笔记仅完成官方资料、包元数据和本机只读检查；未安装依赖、未执行产品打包、未在干净 Windows 机器验收。实现及探针结果应由 `docs/upstream-audit.md` 和实际日志补充。

## 结论与继续条件

现有 Bun + Elysia + React 架构具有 Windows 独立编译依据，`bun:sqlite`、HTML 前端和资源嵌入均有官方支持，因此目前没有证据要求替换技术栈。原项目不能直接编译后即视为便携产品：可写目录、运行时 Worker 构建、静态文件和依赖程序定位仍需适配并实测。[Bun 独立程序文档](https://bun.com/docs/bundler/executables)、[上游 db.ts](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/db.ts)、[上游 app.ts](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/app.ts)

P1 本地抽帧可以使用当前已安装的 FFmpeg；发布便携包前必须解决其准确源码及第三方依赖许可归档。抠图必须显式选择模型，不能因 rembg 程序是 MIT 就把所有权重标为 MIT。`bria-rmbg` 默认权重存在非商业限制，采用 U-2-Net 路线可避免隐式引入付费模型这一问题。[FFmpeg 许可](https://ffmpeg.org/legal.html)、[rembg 2.0.85 默认 session](https://github.com/danielgatis/rembg/blob/v2.0.85/rembg/session_factory.py)、[BRIA 2.0 模型卡](https://huggingface.co/briaai/RMBG-2.0)、[U-2-Net 许可](https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE)

## 建议锁定的探针版本

以下是候选，不是已验证兼容矩阵。实际采用版本及所有传递依赖应写入锁文件和探针日志，不能只写 `latest`。

| 组件 | 建议候选 | 当前证据与限制 |
| --- | --- | --- |
| Bun | `1.4.2`，`bun-windows-x64` | 当前官方文档展示 1.4.2，支持 Windows x64 `--compile`；应使用同版本构建与运行，先验证 Elysia/HTML/SQLite。[官方文档](https://bun.com/docs/bundler/executables) |
| Electron | `44.7.0` | npm 官方包元数据可取得该精确版本，包安装要求 Node `>=22.12.0`；这是宿主候选，需要实际窗口及生命周期探针。[精确包元数据](https://registry.npmjs.org/electron/44.7.0)、[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) |
| Python 构建解释器 | `3.12.15`，Astral standalone `20261009` x64 MSVC 构建 | CPython 3.12.15 为 2026-09-30 安全版且无 python.org Windows 安装器；Astral 已提供 `cpython-3.12.15+20261009-x86_64-pc-windows-msvc-install_only.tar.gz`。可隔离使用该构建，需保存来源、许可和 SHA256。[CPython 发布说明](https://www.python.org/downloads/release/python-31215/)、[Astral 精确发布](https://github.com/astral-sh/python-build-standalone/releases/tag/20261009)、[uv 版本管理](https://docs.astral.sh/uv/concepts/python-versions/) |
| CPU 抠图库 | `rembg[cpu]==2.0.85` | PyPI wheel 于 2026-09-20 发布，MIT；自己的 Worker 调用库接口可先不安装包含 Gradio/FastAPI 等依赖的 `cli` extra。沿用上游 CLI 才需 `rembg[cpu,cli]==2.0.85`。[精确元数据](https://pypi.org/pypi/rembg/2.0.85/json)、[库与 CLI 安装说明](https://github.com/danielgatis/rembg/tree/v2.0.85) |
| ONNX CPU Runtime | `onnxruntime==1.31.0` | PyPI 当前版存在 `cp312-cp312-win_amd64.whl`，2026-10-09 发布；满足 rembg 声明的 `>=1.23.2,<2.0.0`。仅证明可解析/有 wheel，不证明本机推理通过；如果最新版本产生真实回归，可单独验证有 CP312 Windows wheel 的 `1.23.2`，不能把回退预先记为成功。[1.31.0 元数据](https://pypi.org/pypi/onnxruntime/1.31.0/json)、[1.23.2 元数据](https://pypi.org/pypi/onnxruntime/1.23.2/json)、[rembg 依赖声明](https://github.com/danielgatis/rembg/blob/v2.0.85/pyproject.toml) |
| Python Worker 打包 | `pyinstaller==6.22.3`，先 `--onedir` | 官方推荐先验证目录包，Windows 应在 Windows 构建；许可含允许商业应用打包的例外，应用依赖仍各自遵守许可。[使用说明](https://pyinstaller.org/en/stable/usage.html)、[许可](https://pyinstaller.org/en/stable/license.html) |
| 默认模型 | 显式 `u2net`；轻量探针可用 `u2netp` | 来源 U-2-Net，项目 Apache-2.0，rembg 发布 ONNX。完整项目应使用质量样本选择，不把轻量模型质量视为既定结论。[U-2-Net 项目与权重](https://github.com/xuebinqin/U-2-Net)、[许可](https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE)、[rembg 模型列表](https://github.com/danielgatis/rembg/tree/v2.0.85#models) |
| FFmpeg/ffprobe | P0/P1 用已安装 `n8.1.1-118-g1034b144ff-20260615`；发布包另选精确可审计构建 | 当前本机可执行；不能凭文件名宣称已具有完整分发材料。FFmpeg 官方仅提供源码，并链接 Gyan/BtbN Windows 构建。当前官方 9.0 分支版本为 `9.0.2`，Gyan 已提供该版本包及 checksum，仍需核验实际构建许可。[官方下载](https://ffmpeg.org/download.html)、[Gyan 构建与校验](https://www.gyan.dev/ffmpeg/builds/)、[BtbN 构建方](https://github.com/BtbN/FFmpeg-Builds) |

rembg 2.0.85 的 README 写 Python `>=3.11,<3.14`，PyPI `Requires-Python` 却写 `>=3.11,<4.0`。选 3.12.15 同时处于两者范围内；不因元数据较宽就宣称 3.14 支持已验证。[版本 README](https://github.com/danielgatis/rembg/blob/v2.0.85/README.md)、[PyPI 元数据](https://pypi.org/pypi/rembg/2.0.85/json)

## Bun 服务与资源的真实适配点

- 官方确认 `bun build --compile --target=bun-windows-x64` 可以连 Bun 运行时一起打包，内建 `bun:sqlite` 可直接使用；不能在 Electron 的 Node 中运行原后端并假定拥有 Bun API。架构建议是 Electron 主进程启动独立 Bun 后端进程，renderer 通过受保护的 loopback API 使用它。[Bun 独立编译与 SQLite](https://bun.com/docs/bundler/executables#sqlite)
- 原 `db.ts` 使用 `import.meta.dir` 上溯得到源码仓库根并创建 `storage`。编译后的资源路径可能在 `$bunfs` 虚拟文件系统中，不能把用户 SQLite/素材写在那里。建议显式传入可写 `DATA_ROOT`，桌面默认来自 Electron `app.getPath('userData')`，源码模式保留旧位置以迁移；只读资源与可写数据分别解析。嵌入 SQLite 数据库的改动是内存中的、退出即丢失，不能拿它存项目。[上游数据库路径](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/db.ts)、[Bun 嵌入数据库说明](https://bun.com/docs/bundler/executables#embed-sqlite-databases)、[Electron userData](https://www.electronjs.org/docs/latest/api/app#appgetpathname)
- HTML import 会嵌入可解析的 JS/CSS 前端资源；手工 `Bun.file()`/`readFileSync()` 查找的文件需要显式嵌入或随包复制。当前源码 `app.ts` 从 `apps/web/node_modules/pixi.js/dist/pixi.min.js` 读取 Pixi，从 `apps/web/public/fonts` 读取字体，并在 `/imageops/imageOps.worker.js` 请求时调用 `Bun.build()` 构建源码 Worker。建议发布前预构建 Worker，显式资源化 Pixi/字体，断网验证每个路由。[Bun 全栈嵌入](https://bun.com/docs/bundler/executables#full-stack-executables)、[上游动态资源处理](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/app.ts)
- Bun 支持直接嵌入 `.node`，但动态 native loader 可能需要直接 require 文件；外部 Python DLL、FFmpeg 可执行文件和其依赖不因 TS 编译自动成为可启动的磁盘程序。P0 要记录实际调用程序的绝对路径及工作目录。[Bun N-API 嵌入](https://bun.com/docs/bundler/executables#embed-n-api-addons)、[上游 runCmd](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/jobs/run.ts)

## Electron 本地宿主

官方要求 renderer 使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，保持 `webSecurity`，限制导航/新窗口、验证 IPC sender、设置 CSP。用户已要求可信本地连接；建议仅加载包内前端，由主进程提供窄文件选择/生命周期接口。现有 inline 主题/语言脚本必须在启用严格 CSP 时使用 nonce/hash 或移入脚本文件；不能为让页面工作而关闭这些隔离配置。[安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[现有 HTML](https://github.com/taotao7/FrameBaker/blob/main/apps/web/index.html)

架构建议：Bun 明确绑定 `127.0.0.1`，使用系统分配端口；启动时生成随机连接凭据并验证 API、WebSocket、MCP，启动就绪后再展示窗口；退出要结束自己启动的子进程。loopback 自身不是鉴权机制。这些是本项目设计建议及待测项目，不是 Electron 官方已替本项目提供了安全认证。[Bun server hostname 与 port](https://bun.com/docs/api/http)、[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)

## CPU Worker、离线模型与许可

CPU 路线无需 CUDA，但 ONNX Runtime 官方注明 Windows 需要 Visual C++ 2019 runtime，推荐最新版本；目录包的 ONNX/Numpy/Scipy/Pillow 等原生模块及 DLL 必须在无开发环境的 Windows 测试。Python 官方明确 venv 通常不可移动/复制，不能直接复制 `.venv-matting` 宣称便携。PyInstaller 目录包是合理候选，尚需本机冻结及迁移探针。[ONNX 安装要求](https://onnxruntime.ai/docs/install/)、[venv 说明](https://docs.python.org/3.12/library/venv.html)、[PyInstaller 使用](https://pyinstaller.org/en/stable/usage.html)

rembg 2.0.85 `new_session()` 默认 `bria-rmbg`，对应 BRIA RMBG 2.0；其模型卡为非商业许可，商业使用需另行协议。自己的 Worker 应显式 `new_session('u2net', providers=['CPUExecutionProvider'])` 或明确批准的模型，界面不能把所有可选模型统称为免费商用。[默认模型源码](https://github.com/danielgatis/rembg/blob/v2.0.85/rembg/session_factory.py)、[对应 ONNX 来源](https://github.com/danielgatis/rembg/blob/v2.0.85/rembg/sessions/bria_rmbg.py)、[权利人模型卡](https://huggingface.co/briaai/RMBG-2.0)

U-2-Net 权利人仓库以 Apache-2.0 发布项目并列出 u2net/u2netp 权重；rembg ONNX 的来源可回溯该项目。许可判断应保留原 Apache 文本、来源、转换版本、文件 hash，避免把权重与 rembg 的 MIT 混写；本次未看到 U-2-Net 权利人另外设置与项目许可冲突的模型限制，这是基于上述材料的判断。[权重说明](https://github.com/xuebinqin/U-2-Net)、[Apache 许可](https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE)、[u2netp ONNX 下载和校验源码](https://github.com/danielgatis/rembg/blob/v2.0.85/rembg/sessions/u2netp.py)

rembg 2.0.85 保留 `U2NET_HOME` 优先级，但新模型写入 `<home>/models/<模型名>/`，同时读旧平面路径。上游 `doctor.ts` 只对 `storage/models` 做一层文件名探测，可能误报新版模型未缓存。建议由 Worker 返回准确模型路径/校验状态；调用推理前检查文件，未准备返回 `MODEL_NOT_READY`，避免 rembg 隐式联网下载。批量复用一个 session 可减少反复加载。[新版缓存源码](https://github.com/danielgatis/rembg/blob/v2.0.85/rembg/sessions/base.py)、[上游 doctor](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/doctor.ts)、[官方 session 复用例子](https://github.com/danielgatis/rembg/tree/v2.0.85#usage-as-a-library)

## 本机 FFmpeg 只读证据与分发界限

命令：PowerShell `Get-Command ffmpeg`、`ffmpeg -version`、`Get-FileHash -Algorithm SHA256`；均完成，版本命令退出码 0。文件为 `C:\Users\Administrator\Downloads\ffmpeg-n8.1-latest-win64-gpl-8.1\bin\ffmpeg.exe`；SHA256 为 `11FF625EDBD74AACE9F7B689F9F742C36BBD47B5B9B286FE2993A28026137526`。版本为 `n8.1.1-118-g1034b144ff-20260615`，配置含 `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265`，未见 `--enable-nonfree`；包根 `LICENSE.txt` 开头是 GPLv3。以上是本机观测，不是网页替该文件提供的完整认证。[构建许可含义](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)、[GPL/外部库说明](https://ffmpeg.org/legal.html)

此构建应按 GPLv3 路线审计，不能标为 LGPL 或 MIT。FFmpeg 许可条件取决于启用组件；启用 nonfree 的结果可能不可再分发。真正分发前需保存准确版本/构建选项、对应源码及必要构建脚本/补丁、所含依赖及许可、二进制校验值，并提供用户取得对应源码的有效方式；不能只链接最新 FFmpeg 源码。[FFmpeg LICENSE](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)、[FFmpeg 官方合规说明](https://ffmpeg.org/legal.html)、[GPLv3 第 6 节](https://www.gnu.org/licenses/gpl-3.0.en.html)

Bun 以 argv 启动独立 FFmpeg、用常规媒体文件/管道通信，与把 GPL 库链接进同一程序不同。FSF FAQ 允许符合条件的 aggregate，同时强调划分需看通信机制及语义；本项目可保留各组件原许可，不能笼统宣称所有程序被强制改成 GPL，也不能以“子进程”四字免除 FFmpeg 的分发义务。[FSF aggregate FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)、[上游独立 spawn](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/jobs/run.ts)

本机包未发现源码归档；其准确上游 binary release 与全部第三方 source provenance 尚未核验，故目前仅建议用于本机开发/抽帧验证。未来可另选官方链接的 Gyan/BtbN 精确构建，或自行构建满足需求的 LGPL 配置；切换需重新核验抽帧结果与完整许可材料。[FFmpeg 官方下载渠道](https://ffmpeg.org/download.html)、[Gyan 版本及 source commit](https://www.gyan.dev/ffmpeg/builds/)、[BtbN 构建代码](https://github.com/BtbN/FFmpeg-Builds)

## P0 最小实测门槛

以下为待执行，不应写成已经通过：

1. 编译并启动真实 Bun HTML/Elysia/SQLite 后端，源码目录移开后仍可访问；SQLite 写入后重启可恢复，数据不落入程序/虚拟资源目录。[支持依据](https://bun.com/docs/bundler/executables)
2. 访问首页、Pixi、字体、imageOps Worker，断网下 renderer 的编辑器可启动；扫描包外源码与 CDN 依赖。[源码资源入口](https://github.com/taotao7/FrameBaker/blob/main/apps/server/src/app.ts)
3. Electron 窗口通过安全配置加载本地服务；启动失败有诊断，关闭后不残留自身子进程，端口冲突可处理；API/WS/MCP 未授权请求失败。[宿主安全依据](https://www.electronjs.org/docs/latest/tutorial/security)
4. Python one-directory Worker 在移到另一中文/空格路径后完成一次 CPU 抠图；模型缺失明确报错，准备后断网可工作；验证 DLL、模型路径和 session 复用。[打包依据](https://pyinstaller.org/en/stable/usage.html)、[模型实现](https://github.com/danielgatis/rembg/blob/v2.0.85/rembg/sessions/base.py)
5. 发布用 FFmpeg/ffprobe 对应源码、许可、构建清单已归档；当前 GPL 包的源码未核验属于发布门槛，不足以单独阻止 P1 使用本机安装版本开发。[分发条件](https://ffmpeg.org/legal.html)

若 Bun 某资源嵌入无法通过探针，同一架构下的固定 Bun runtime + 已构建资源目录仍是合理备用部署方式；不能把这个局部问题扩大成从零重写。是否采用应由实际错误日志决定。[Bun 编译资源与 runtime 文档](https://bun.com/docs/bundler/executables)、[Bun HTML 构建](https://bun.com/docs/bundler/html-static)
