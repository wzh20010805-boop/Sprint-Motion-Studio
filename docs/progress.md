# 开发进度与交接（2026-10-10）

本批范围：用户要求完整阅读方案并按第20节先执行 P0，无实质阻塞再执行 P1。方案1124行已全部阅读，原件与工作区副本 SHA256 一致。P0 / P1 已完成；P2–P6 未作为本批完成结果。没有操作现有游戏或个人知识库。

## 仓库与实施

- 工作区 `D:\AIJOB\tools\Sprite Motion Studio`，完整克隆位于 `framebaker` 子目录。
- `upstream=https://github.com/taotao7/FrameBaker.git`，基准 `f9846c985156f83f750bcc654b56cae2a1960229`；开发分支 `feature/soldier-frame-studio-v1`，无 origin，未推送。上游历史与 MIT 署名保留。
- P0 本地提交 `e09592c`：环境、上游许可/能力审计、原始回归和桌面可行性证据。P1 实现与测试提交 `b3451bf`；后续交接文档提交见本分支日志。
- 固定 Bun 位于父目录 `.runtime`；独立 Python `.venv-image` 仅安装 Pillow/pytest。Rembg、SAM2、MatAnyone、torch、CUDA 均未安装。

## P0 结论

上游原始196通过/3失败，失败为 POSIX 路径夹具；Windows 修复后199通过。基线 typecheck 通过。真实 HTTP 导入/编辑与界面 PNG 序列导出已验证；旧8FPS采样把48帧源片变为16帧。无抠图引擎时上游复制原图却标为 matted，SHA256 相同，已实证并记录。

最小 Bun 编译 EXE 的 HTTP/SQLite/资源/生命周期通过；完整上游单 EXE 因虚拟 import.meta.dir 数据路径失败。固定 Bun + 源码快照 + Electron 的替代路径实际启动成功，详见 [desktop-probe.md](desktop-probe.md)。因此有可行路径，无阻止 P1 的实质问题；探针含开发依赖 junction，不能作为干净机器发行包。

环境、审计、许可与模型兼容性研究见 [environment.md](environment.md)、[upstream-audit.md](upstream-audit.md)、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)、[packaging-research.md](packaging-research.md)。当前 FFmpeg 为 GPLv3 构建，正式再分发需满足其责任，本批未将它作为 MIT 软件发行。

## P1 完成内容

1. 完整显示帧、整数 PTS、time_base、有理数时长和重复画面保留。48/61/120/300 不截断，真实 VFR 不改为平均 FPS。暂存通过数量/顺序/尺寸/全 PNG 解码后发布。
2. schema3 增量迁移；迁移前 VACUUM INTO 保留已提交 WAL 的一致快照。来源/源帧/Clip 补充现有项目、动画轴和主轨；GUI 副本与完整源素材分开。
3. 队列持久 payload/result/log/error_code；重启 queued/running 为 interrupted。取消/失败不提交伪完整帧；GUI 改动推进修订，旧结果拒绝覆盖。
4. CLI doctor/project create/import video/clip create/extract all/job 查询等待取消/gui 使用共享 HTTP 服务。先取得工作区锁再加载 SQLite；API/WS 检查 token/Host/Origin，只监听127.0.0.1。
5. 真实 GUI 默认全部原始帧，显式旧 FPS 采样。未准备的抠图/云操作明确禁用，原始帧不宣称透明。Pixi 编辑器保留且严格 CSP 下可用。

运行说明见 [README_SFS.md](../README_SFS.md)。双击 `Start-SFS.cmd` 启动开发宿主，或 `sfs.cmd doctor --json`；默认数据为仓库 `workspaces/default`，可通过 `--workspace` 指定独立目录。

## 最终验证

| 验证 | 真实结果 | 证据 |
|---|---|---|
| 全仓库测试 | exit0，243通过/0失败，31文件 | `evidence/p1/tests-final.txt` 和 meta JSON |
| server/web/CLI 类型检查 | exit0 | `evidence/p1/typecheck-final.txt` 和 meta JSON |
| setup/frozen依赖/doctor | exit0 | `evidence/p1/setup-verification.txt`；PS5编码失败保留并修为UTF8 BOM |
| Windows CLI 编译 | exit0 | `evidence/p1/cli-build.txt`，本地 `dist/sfs.exe` |
| 编译 CLI 从 C:\Windows\Temp 运行 | exit0，48帧/2秒 | `evidence/p1/compiled-cli.json` |
| 48/61/120/300完整原始PNG | 全数保留且逐个解码 | `evidence/p1/extraction-report.md`、timing、contact sheet |
| 真实 Electron/GUI/CLI | exit0，上传48步/48帧，首步时长1→2重开保留，CLI同项目修订99→200 | [p1-desktop.md](p1-desktop.md)，`desktop-live/` |
| GUI/CLI同视频等价性 | 48个时序记录与全部PNG哈希一致，源索引0–47、总时长2/1秒 | `desktop-live/desktop-gui-cli-equality.json` |
| API/WS/实例生命周期 | 未鉴权401，Host/Origin检查，同源cookieAPI200/WS打开，关GUI后共享实例仍可用 | CLI回归和桌面报告 |

合成 PNG 为 RGB、全不透明；协调代理已打开48/300帧 contact sheet 和真实 GUI 截图。详见 [质量报告](evidence/p1/quality-report.md)。没有带场景小兵的授权视频，武器/头发/装备/变形等美术问题未验收。

T01–T04/T06 已有真实媒体测试；T05 中文/空格/括号/元字符的抽帧保存路径已验证，P0 实际执行过序列导出。T07 缺失 ffprobe 返回依赖码3。正式导出、恢复、离线发行、Cocos 等验收仍属于后续对应阶段。

## 独立审查与修复

- 失效锁恢复两个进程竞争：排他恢复锁覆盖核验/清理/新锁创建；两进程 RED→GREEN。
- 缓存接受损坏 PNG/截断 timing：与已存 probe 重算的完整时序严格比较并全 PNG 解码；3项 RED→GREEN，失败不创建 GUI 帧。
- interrupted 导入轮询不结束：纳入终态并显示中断原因；RED→GREEN。
- all-mode 兼容 worker 的结果未持久化：队列接收返回结果；RED→GREEN。
- 缺失 ffprobe 误报素材错误：依赖错误贯通服务/CLI，真实裁剪 PATH 测试 RED→GREEN。
- 严格 CSP 下 Pixi 无法建画布：使用同版本安装包兼容模块，禁止字符串代码生成测试与真实 GUI 都通过。

独立只读复审确认上述锁/缓存/interrupted及依赖错误修复，在审查的 P1 范围内没有剩余阻塞，见 [复审记录](evidence/p1/review-final.md)。代码/说明的 whitespace 检查通过；原始失败日志的行尾空白按证据原样保留。

限制：尚无每张源 PNG 的摘要，同尺寸且可解码的人工整图替换不会由结构检查检出；原视频有 SHA256。VFR 整数 tick 预览可量化，原始 timing 精确。P1 没有检查点恢复，重启后需重新提交；孤立 recovery 锁保守拒绝，需要核查 PID/日志。编译 CLI 仍需邻接源码与固定 Bun，P5 未完成。

## 续作入口

下一阶段为 P2：先确定一段获授权的小兵视频与代表帧，准备明确授权的 CPU Rembg 模型，实测细武器/半透明边缘并提供人工遮罩修正；不沿用原图复制假成功。之后才做全局比例/地面参考与根轨迹、统一导出、薄 MCP/Skill、独立离线包及 Cocos Creator3.8.8 实测。

继续前读本文件、README_SFS、用户原方案和 git log/status。所有原视频/raw/失败目录/报告保留；使用新的隔离工作区。首次只验证一个动作，不直接处理所有角色。
