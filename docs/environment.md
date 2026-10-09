# 本机开发环境（2026-10-10，P0）

工作区：`D:\AIJOB\tools\Sprite Motion Studio`；完整克隆：其 `framebaker` 子目录。
方案原件在用户 Downloads，已原样复制到工作区根目录。未访问或修改游戏/知识库工程。

| 项目 | 实测 |
|---|---|
| 系统 | Windows 11 专业版 x64，10.0.26200 |
| 内存 | 34,268,237,824 bytes（约 31.9 GiB） |
| GPU | AMD Radeon RX 6750 GRE 10GB；名称不是可用显存测量 |
| D盘可用 | 首次探测约 83 GiB（运行过程会变化） |
| Git | 2.55.0.windows.3 |
| Python | 3.11.9 (`E:\python3.11.9\python.exe`)，另有 3.13；不修改其依赖 |
| Node/npm | 24.16.0 / 11.13.0 |
| Bun | 原 PATH 无 Bun；工作区 `.runtime` 安装固定 1.4.2，不改全局 PATH |
| FFmpeg/ffprobe | n8.1.1-118-g1034b144ff-20260615；版本/构建选项已存 evidence/p0 |
| FFmpeg 许可 | 当前构建含 enable-gpl + enable-version3；不能当 MIT 分发 |
| Python隔离 | 工具内 `.venv-image`，仅验证/Contact Sheet 的 Pillow 与 pytest；Rembg 未安装 |

详细可复查记录：`evidence/p0/environment.json`。AMD GPU 不走 CUDA；P0/P1 不安装 torch、SAM2、MatAnyone、CUDA，不下载模型。

## 安装与基线

使用官方 npm 注册表 `@oven/bun-windows-x64@1.4.2`，保留父目录 `.runtime/package-lock.json`。工具依赖使用上游 `bun.lock` 的 frozen install（54 packages）。运行 Bun 时仅对命令进程临时扩展 PATH。

基线 typecheck：exit 0。原始 test：196 pass / 3 fail，失败为 `/usr/bin/true` 和 `/bin/sh` 的平台硬编码。改为真实 Bun 子进程测试夹具后：199 pass / 0 fail。原始及修正日志均保留，不跳过或删除测试。

上游真实服务已在 43187 端口启动、HTTP创建/导入/编辑可用。48帧/24FPS/2秒 testsrc2 合成视频经旧默认8FPS导入得到16帧，复现重采样问题；不作为完整抽帧验收。抠图 engine=none/modelCached=false，不声称透明处理完成。

桌面探针结果及后续 P1 结论以 `desktop-probe.md`、`progress.md` 为准；本文件不替代干净 Windows 便携包验证。
