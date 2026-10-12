# Windows 便携版：依赖源码与重建

发行版：Sprite Motion Studio 1.0.0；本地1.0.1至1.0.3修复包使用相同版本的依赖与对应源码归档（仍可从v1.0.0 Release取得）。应用源码与安装包在 [本仓库](https://github.com/wzh20010805-boop/Sprint-Motion-Studio) 和 [Release](https://github.com/wzh20010805-boop/Sprint-Motion-Studio/releases/tag/v1.0.0) 提供；源代码 MIT，依赖按各自许可，用户示例媒体不授予 MIT 再分发许可。

## FFmpeg / ffprobe

本包不修改 FFmpeg，作为独立进程调用。实际构建 `n8.1.1-118-g1034b144ff-20260615`，含 GPL / version3；完整构建参数与 GPL3 正文在包内 `licenses/FFmpeg-build.txt` / `licenses/FFmpeg-LICENSE.txt`。

- 对应 FFmpeg 源码：[1034b144ff73aeae201ecbf132b3ca89b321ec16](https://github.com/FFmpeg/FFmpeg/tree/1034b144ff73aeae201ecbf132b3ca89b321ec16)，Release 同时附源代码归档。
- 构建当天可取得的 BtbN 构建配方：[a9410e4be2b332e535000004a8ebf304d9b46689](https://github.com/BtbN/FFmpeg-Builds/tree/a9410e4be2b332e535000004a8ebf304d9b46689)。Release 同时附此配方归档；`scripts.d` 列出第三方库源码、下载地址、补丁和构建方式。此提交按构建日期定位，不能视作原二进制构建的独立复现证明。
- 在 Docker / Bash 环境按该配方的 README 使用 `./makeimage.sh win64 gpl 8.1` 和 `./build.sh win64 gpl 8.1`；第三方依赖源码从各配方提供的原站取得。浮动分支在后续时间的构建可能产生不同二进制。
- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)；本包不能标成 LGPL-only。FFmpeg 的 GPL 不取代独立调用它的本项目源码 MIT 许可。

## Bun 与 JavaScriptCore

- [Bun 1.4.2 源码](https://github.com/oven-sh/bun/tree/bun-v1.4.2)，Release 同时附源码归档；随包保留该版本原始 `LICENSE.md` 与第三方 notices。
- Bun 1.4.2 的 WebKit 固定版本由 `scripts/build/deps/webkit.ts` 给出：[2e2aa2290fac856d6f451ceacb58f7f5b44dd057](https://github.com/oven-sh/WebKit/tree/2e2aa2290fac856d6f451ceacb58f7f5b44dd057)。JavaScriptCore / WebKit 为 LGPL；允许修改库并重建。
- 按 [Bun 1.4.2 原始许可中的重新链接步骤](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md) 获取固定版本源码，执行 `bun sync-webkit-source`、`bun run build:local`。应用的 TypeScript 源码、锁文件与编译命令公开在本仓库，可使用修改后的 Bun 重建 `sfs.exe` 与 `runtime/sfs-service.exe`。

## 其他运行时与依赖

Electron 44.7.0 的许可与 Chromium notices 在解压目录，Python 3.11.9 许可在 `licenses/Python-LICENSE.txt`。Python 依赖版本在 `sfs-package.json`，发行元数据和许可保留在 `runtime/python/Lib/site-packages/*.dist-info`。字体 OFL、Pixi MIT、Rembg MIT 及可选模型项目 Apache-2.0 notices 均随包保留。

模型未附包；u2netp 的登记 SHA256、来源与离线导入说明在 `licenses/model-u2net.md`。本版保留实际构建的许可和源码取得方式，尚未独立审计所有第三方静态库的原构建重现结果。
