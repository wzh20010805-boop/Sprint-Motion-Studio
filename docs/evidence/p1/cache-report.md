# P1 缓存复用完整性修复

日期：2026-10-10。审查复现 `fixtures/generated/review-cache/proof.ts` 显示，原缓存分支仅解析 timing.json，损坏 PNG 或截断清单可被新 Clip 直接引用。

新增 `validateSourceArtifacts(directory, sourceId, probe, signal?)`，以已保存的 VideoProbe 重新计算完整预期 SourceTiming，用 `node:util.isDeepStrictEqual` 比较实际清单；无法读取／解析或语义不一致时返回明确 `INVALID_TIMING` 错误码。再复用首次提取的 PNG 校验：实际数量、连续整数索引、每帧尺寸与全部 PNG 的完整解码。服务缓存分支在创建可编辑副本或写入 GUI 帧之前等待上述验证。

`cache-red.txt` 记录修复前 3 项回归失败；`cache-green.txt` 记录修复后 3 通过、0 失败。每项在独立子进程与 `fixtures/generated/p1-cache-*` 工作区运行实际 FFmpeg 生成／提取的 3 帧视频。验证：

- 用纯文本替换源 PNG 后，新 Clip 提取失败，GUI 帧和时间轴步骤均为 0，Clip 不会标记已提取。
- 恢复 PNG，再把 timing 清单截断为 1 帧后，拒绝复用并返回 `INVALID_TIMING`，仍无 GUI 帧。
- 恢复合法完整清单，新 Clip 成功复用 3 帧，原视频及源 PNG、timing 字节不变。
- PNG 仅保留有效 IHDR 与截断压缩内容也会失败，证明实际执行了完整解码。
- 清单帧数保持 3 但更改文件路径或显示时长同样返回 `INVALID_TIMING`。

全部工作区、源文件与失败证据保留，没有执行删除。`cache-full-suite.txt` 为最终全仓库验证：243 通过、0 失败；`cache-typecheck.txt`（server／web／CLI）和 `cache-targeted-typecheck.txt` 均退出 0。

本次校验保证清单语义与 PNG 可解码结构完整；尚未为每张源 PNG 记录不可变像素或文件摘要，因此同尺寸、仍可正常解码的整张 PNG 替换不在本次检测范围内。原视频仍由已有 SHA-256 校验保护。

代码修改范围仅 `extractAll.ts` 新增验证函数与 `service.ts` 缓存分支及其 import；另新增隔离缓存测试和本证据。未提交。
