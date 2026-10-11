---
name: soldier-frame-studio
description: 通过已实现的本地 Sprite Motion Studio CLI 或九工具 MCP 处理小兵动画、读取修订、提交任务与导出透明素材；适用于本机工作区，不适用于远程云端或直接修改游戏。
---

先定位发行目录的 `sfs.exe`，运行 `sfs.exe doctor --json`。不从源码重新创建一套处理链。缺模型时可检查、修正已有遮罩、对齐和导出；需要抠图才提示用户从 GUI 菜单明确下载或离线导入登记模型。

所有命令传同一个 `--workspace <绝对目录>`，用 `--json` 读取结构化结果。`project list` 找项目，`project inspect --project ID` 查动作、源和修订，`inspect --project ID --axis ID` 查对齐参数。数组超过32项时 stdout 是摘要；完整数据在产物文件或共享HTTP服务。

自动处理用 `pipeline run --project ID --axis ID --clip ID --recipe recipe.json --wait`；recipe schema 由 `schemas --name recipe --json` 查询。仅下一未完成阶段被提交；`--wait` 连续推进自动阶段。`waiting_user` 与退出码4表示初稿需要人检查，此时展示本地预览路径与异常，等待用户明确确认。不得因用户要求“导出”自动执行 `mask review` 或伪造 `review apply` 确认。

对齐用 `align --project ID --axis ID --config alignment.json`。坐标为源图左上像素边界，`q=s*(p-r)+c+d`；角色公共画布、锚点、比例共享，根轨迹按动作标注。跳跃/死亡不能把每帧最低像素当根；越界要扩大共同画布或请求修正，不独立缩小异常帧。

用 `preview --project ID --axis ID` 做全序列越界检查。用户已经明确检查所有遮罩与根轨迹后，才用 `review apply --project ID --axis ID --base-revision N --patch review.json` 记录确认内容和来源。修订或输入字节变化后重新检查；不能替用户进行美术验收。

`export --project ID --axis ID --wait --output <新目录>` 导出正式包；用户允许检查草稿时加 `--draft`。PNG序列、规则多页图集、manifest、检查报告、联系表、背景预览视频及 ZIP 由同一服务产生。核验 `checksums.json`、帧顺序、透明Alpha、画布、锚点和有理数时长；预览MP4不是透明素材。Cocos锚点已在manifest标明，实际Cocos播放验收另做，不修改用户游戏。

任务用 `job status|wait|cancel|resume --job ID`。中断/失败恢复创建新任务并重新核验当前输入；历史失败与旧产物保留。退出码：0成功，2参数/输入，3依赖，4待人工，5取消，6修订/锁冲突，1其他失败。超时只结束等待，任务可能仍在后台。

MCP 启动命令为 `<发行目录>/sfs.exe mcp --stdio --workspace <目录>`，只使用九个公开工具；不安装全局配置。MCP不能绕过逐帧遮罩审核。更完整命令、样例与接入说明见发行根 `CLI与Codex接入.md`，源码见 `docs/p3-p5-guide.md`。
