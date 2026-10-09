# P0合成样例检查（不代表角色质量验收）

- 输入：自造testsrc2，160×120，24 FPS，48显示帧，2秒。
- 上游导入：16张帧资产，符合旧默认8FPS重采样；不满足all要求。
- 编辑：offset_x=3/duration=2，经真实HTTP保存并在重开编辑器显示。
- 编排：帧资产复用进入16个轨道步骤；UI总帧数包含资产+实例，显示32，并不表示源帧数。
- 导出：在实际上游GUI选择PNG序列，下载ZIP，解压得到16张RGBA PNG与JSON。使用Pillow load逐张解码，尺寸一致、无空帧。查看contact-sheet.png确认测试图像完整可见。
- 背景：Canvas导出留白含透明像素，但测试场景依然存在；Alpha通道存在不等于场景背景已去除。不得作为透明角色输出。
- 抠图：engine=none、modelCached=false。上游matting任务仍done，material=matted；raw/processed SHA256完全相同：191D33FCFCD003A76D1DA7C26F91C2E4EF03E76BEC730115B1826FC7D949F80D。这是缺引擎伪成功复现，不是算法验收。
- 武器/主体形变/根位置：合成测试图不是角色，此项未评估。真实素材尚未提供。

证据：upstream-smoke.json、upstream-place.txt、png-inspection.json、contact-sheet.png、matting-missing.json、matting-file-hashes.json。下载ZIP保留本地但不提交二进制中间数据。
