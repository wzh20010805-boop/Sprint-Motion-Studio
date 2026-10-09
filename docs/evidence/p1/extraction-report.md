# P1 完整显示帧提取证据

验证日期：2026-10-10；Windows x64；固定运行时 Bun 1.4.2；FFmpeg / ffprobe 8.1.1-118-g1034b144ff-20260615。样本为实际编码的 64×48 SDR H.264 视频，验证不依赖 `duration × fps` 推测帧数。

| 实际输入显示帧 | 实际输出 PNG | 完整播放时长 | 时序与 contact sheet |
| --- | --- | --- | --- |
| 48（24 FPS） | 48 | 2 秒 | `extraction-timing-cfr48.json`、`extraction-contact-cfr48.png` |
| 61（24 FPS） | 61 | 61/24 秒 | `extraction-timing-cfr61.json`、`extraction-contact-cfr61.png` |
| 120（24 FPS） | 120 | 5 秒 | `extraction-timing-cfr120.json`、`extraction-contact-cfr120.png` |
| 300（24 FPS） | 300 | 25/2 秒 | `extraction-timing-cfr300.json`、`extraction-contact-cfr300.png` |

`extraction-matrix.json` 记录上述真实 PNG 目录，全部保留在忽略跟踪的 `fixtures/generated/p1-*`。原视频、成功源帧、失败／取消暂存目录均保留，不执行样本清理或删除。Contact sheet 用已提取的 PNG 按整数源索引生成；48 与 300 帧成图已打开检查。

测试先失败后实现：`extraction-red.txt` 包含 18 项缺失公开提取能力的失败断言；`extraction-red-geometry.txt` 和 `extraction-red-matrix.txt` 分别证明逐帧非方形像素和异常显示矩阵检查此前缺失。`extraction-green.txt` 是最终提取套件，23 通过、0 失败。`extraction-full-suite-final.txt` 是完整仓库套件，234 通过、0 失败。早期 `extraction-full-suite.txt` 的 4 项 CLI／HTTP 集成失败来自当时并行开发尚未接入的入口，最终完整套件已全部通过。

最终针对提取实现、测试及证据脚本的 TypeScript 检查退出码为 0；全仓库 `bun run typecheck`（server、web、CLI）也退出码为 0。分别保存为 `extraction-typecheck.txt` 和 `extraction-repository-typecheck.txt`。

额外真实媒体验证覆盖：48 个完全相同画面的显示帧不会去重；真实 VFR 的显示时长为 `1/24、1/12、1/8、1/24` 秒，合计 `7/24` 秒；Unicode／空格／shell 元字符作为普通路径参数；音频在全局流 0 且含两个视频流时，探测与提取均选择 `0:v:0`（全局流索引 1），原视频与输出序列的 RGB24 逐帧 `framemd5` 完全一致。

输入损坏、没有视频流、HDR、交错、旋转、非方形像素及异常显示矩阵明确失败。缺失或非单调 PTS 不按平均帧率补齐。整数 JSON PTS 在解析前受保护并以 BigInt 运算，约分后的有理数必须落在 JavaScript 安全整数范围内。末帧优先使用帧时长，然后可信流终点；只能沿用前一间隔时写入 `estimated` 与明确警告，唯一帧没有可信时长则失败。

提取通过参数数组运行，使用 `-nostdin -n -xerror -map 0:v:0 -an -sn -dn -fps_mode:v passthrough -start_number 0`，无重采样、去重或数量上限。每次使用唯一暂存目录，先检查剩余磁盘容量，再检查实际数量、连续整数索引、所有 PNG 尺寸，并用 FFmpeg 将整个 PNG 序列完整解码到 null。中间 PNG 的有效头但截断压缩内容及单帧尺寸变化均被测试拦截。通过全部校验后才发布 `raw/` 与 `timing.json`，已有正式产物拒绝覆盖；取消只终止当前任务自己的子进程，stdout / stderr 同时读完。

实现范围仅为 `apps/server/src/pipeline/probe.ts`、`extractAll.ts`、共享源时序契约与本测试／证据目录。未更改数据库、队列、GUI、导入接口或 CLI，未添加依赖，未执行 Git 操作。API 与路径的业务写入保证由唯一服务实例负责；本模块也拒绝同进程内对同一源目录并发提取。
