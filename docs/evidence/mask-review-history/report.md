# 1.0.5 逐帧遮罩确认修复

用户在当前 test 项目确认第 9 帧时，第一次看到“帧不存在”，第二次看到“遮罩已更新”。只读检查发现 5 个历史 waiting_user 抠图任务引用了已删除帧。旧 reviewMask 先提交 reviewed=1 和项目修订，再扫描这些任务；扫描抛错后没有返回最新状态，因此重试又遇到旧修订冲突。

修复将确认、修订、任务状态和返回状态读取放入同一事务。引用已删除或移出项目帧的历史批次标记 cancelled，不冒充审核通过；完整批次仍须全部有效遮罩已确认才变为 done。任务参数、结果和文件保留。任务事件在提交后发送，失败不泄漏成功状态。

验证：

- 新增 tests/pipeline/mask-review-history.test.ts，旧实现首次确认实际返回 HTTP 404；修复后通过。覆盖缺帧、跨项目帧、完整但未审核的批次、旧修订拒绝，以及任务写入失败时审核/修订/先前任务更新全部回滚。
- Bun 完整测试 268 pass / 0 fail，46 文件，5222 个外层断言；新增测试内部另有实际 HTTP 与数据库断言。日志：fixtures/generated/mask-review-full-tests.txt。补充跨项目/任务回滚断言后针对性测试再次通过。
- server/web/CLI 类型检查及 1.0.5 版本一致性检查通过。
- scripts/verify_mask_review.py 使用真实项目数据库的只读快照，通过旧、新便携包的实际编译服务对比：1.0.4 返回 404→409；1.0.5 返回 200，刻意提交旧修订仍返回 409；副本 14/14 帧通过，5 个历史批次取消，当前批次等待最后一帧后才完成。验证期间真实项目数据库摘要及 189 个源图文件摘要未变化。
- 便携包证据：fixtures/generated/mask-review-portable/20261012-210648-6874cf6f/summary.json。仅验证当前 Windows，本轮不宣称干净虚拟机验收。
- ZIP 完整 CRC 校验通过，554209204 字节，SHA256 abf0c6d4701708610566fc0ef26fc1d36593d1f13a7db357b2d63e2914974840。

本机恢复：确认旧版宿主没有窗口或子进程、没有 queued/running 任务后，退出残留宿主和旧后台，启动 1.0.5。之前已保存的 14 帧确认状态和模型均可读取。先保存工作区数据库快照，再通过新版共享 HTTP 接口重试用户已经确认的第 9 帧（确认前再次检查 reviewed=true、源图未变化）；遮罩版本不变、14 帧审核标记不变，5 个失效历史任务取消，剩余已完成审核批次变为 done，waiting_user 归零。恢复证据：fixtures/generated/mask-review-upgrade/recovery.json。

dist 中仅保留 最新便携版/ 下的 1.0.5。1.0.4 移到 fixtures/generated/archived-installers/before-1.0.5，可恢复；未删除原图、素材工作区或模型。
