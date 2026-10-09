# P0 命令索引

日期：2026-10-10（Asia/Shanghai）；工作目录除另写外均为 `D:\AIJOB\tools\Sprite Motion Studio\framebaker`。Bun 为父目录 `.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe` 1.4.2。完整输出以右侧文件为准。

| 命令 | Exit | 证据 |
|---|---:|---|
| git clone https://github.com/taotao7/FrameBaker.git framebaker（父目录） | 0 | Git完整历史、upstream remote、固定f9846c9 |
| npm install --prefix .runtime --no-audit --no-fund --ignore-scripts --save-exact @oven/bun-windows-x64@1.4.2（父目录） | 0 | .runtime/package-lock.json |
| bun install --frozen-lockfile | 0 | install.txt |
| bun run typecheck | 0 | typecheck.txt |
| bun run test（原始） | 1 | tests.txt；196 pass/3 fail，POSIX命令未找到 |
| bun run test（跨平台夹具修正后） | 0 | tests-windows.txt；199 pass/0 fail |
| PORT=43187 NODE_ENV=production bun apps/server/src/index.ts | 启动成功 | HTTP健康/API/CUA真实编辑器；进程后续由root停止 |
| ffmpeg -hide_banner -nostdin -n -f lavfi -i testsrc2=size=160x120:rate=24:duration=2 -an -c:v libx264 -pix_fmt yuv420p "fixtures/generated/P0 合成样例 (48帧).mp4" | 0 | fixture.txt |
| bun probes/upstream-smoke.ts | 0 | upstream-smoke.txt/json；真实HTTP创建/导入/编辑 |
| bun probes/upstream-place.ts | 0 | upstream-place.txt；16步骤/实例 |
| GUI实际点击导出动画→PNG序列帧 | 已下载 | 本地保留upstream-sequence.zip；Python逐张检查 |
| py -3.11 -m venv .venv-image | 0 | 隔离解释器，不改全局环境 |
| .venv-image/Scripts/python -m pip install Pillow==12.0.0 pytest==8.4.2 | 0 | python-install.txt；锁定传递依赖于probes/requirements-validation.lock.txt |
| .venv-image/Scripts/python probes/inspect-png.py fixtures/generated/p0-upstream-export docs/evidence/p0 | 0 | png-inspection.json、contact-sheet.png |
| bun probes/upstream-matting.ts（修正探针路由后） | 0 | matting-missing.txt/json；缺引擎伪完成 |
| Get-FileHash raw.png,processed.png -Algorithm SHA256 | 0 | matting-file-hashes.json；字节相同 |
| ffmpeg -version / -buildconf；ffprobe -version；py -0p | 0 | ffmpeg-version.txt/ffmpeg-buildconf.txt/environment.json |

桌面/Bun编译探针完整命令、退出与资源检查见 `../../desktop-probe.md` 及 `bun-report.json`、desktop证据。不将synthetic或最小探针当真实角色质量/完整便携包/Cocos验证。
