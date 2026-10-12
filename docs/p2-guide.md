# P2：场景抠图与人工修正

双击仓库中的 `Start-SFS.cmd`。导入视频后，在项目编辑器顶部点击 **场景抠图与修正**。

1. 点击“框住要保留的角色”，画面自动切回原图。框内是保留区域，框外会透明；请框住角色、武器和装备，不能只框空白背景。同一动作共用区域，所以需要包含整个运动范围。点击“使用完整画面”取消区域限制。
2. 选择整个动作或仅当前帧，点击“生成抠图初稿”。近纯色边缘的场景自动用边缘背景色法处理，保留分离装备和内部浅色；复杂背景使用本地 CPU Rembg。同批只建立一个 session。纯背景区域或没有可见角色会报错，整批不提交，原图和上一版保留；任务可以取消。
3. 用“擦除背景”清除误保留像素，用“恢复前景”找回原图中的枪尖、头发和装备。笔刷直径使用源图像素，画面自动放大适配窗口。
4. 切换原始画面、透明底、Alpha、黑底、白底检查。画笔只改变透明度，不重画角色颜色；恢复保留原图本身的半透明度。
5. 保存修正，或撤销最近一笔。已经保存的修订也可撤销，关闭软件再打开仍能继续撤销；自动初稿和历史修订分别保留。
6. 用键盘 `←` / `→`、前后帧按钮或编号快速切换，逐帧点击“确认这一帧”。首尾帧不会循环跳转；输入参数、拖动画笔和任务处理中不会被方向键打断。有未保存笔画时，切换/关闭会提示；取消后保留当前帧和笔画。所有帧确认后对应任务结束，未确认则保持 `waiting_user`。

单帧透明 PNG 可在工作台下载检查。已有上游序列/图集导出仍是前端兼容功能，正式审核闸门与服务端统一导出属于 P4。

## 本地依赖与模型

本机已准备 `.venv-image` 的 Rembg CPU 环境和 `.models/u2netp.onnx`。重建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup_p2.ps1
```

脚本明确提示依赖和约 4.7 MB 模型下载；可传 `-ModelFile 'D:\离线模型\u2netp.onnx'` 从离线文件导入。下载来自 Rembg 官方 release，校验 MD5。Worker 本身不下载模型，不上传素材，不依赖聊天模型 API。小模型适合先做初稿，不保证复杂背景质量；可见错误和人工修正是流程的一部分。

## GUI / CLI 使用同一数据

```powershell
.\sfs.cmd matte --workspace 'D:\素材工作区' --project PROJECT_ID --frames FRAME_ID_1,FRAME_ID_2 --region 0,0,128,128 --wait --json
.\sfs.cmd mask show --workspace 'D:\素材工作区' --frame FRAME_ID_1 --json
.\sfs.cmd mask edit --workspace 'D:\素材工作区' --frame FRAME_ID_1 --strokes 'D:\修正.json' --json
.\sfs.cmd mask undo --workspace 'D:\素材工作区' --frame FRAME_ID_1 --json
.\sfs.cmd mask review --workspace 'D:\素材工作区' --frame FRAME_ID_1 --json
```

不传 `--region` 使用完整画面；`--frames` 使用逗号分隔的真实帧 ID。ID 可从 `project inspect` 的 `editor_frames` 读取。等待初稿返回退出码 **4**，表示需要检查；不表示推理失败。`job status/wait/cancel` 沿用 P1。修正 JSON 是笔画数组：

```json
[{"mode":"restore","size":1,"points":[[106,12],[106,105]]},{"mode":"erase","size":5,"points":[[50,50]]}]
```

坐标为完整源图左上角原点，size 是直径，不能越界。`--base-revision` 可明确指定预期项目修订。过期项目、旧遮罩或修改后的原图会拒绝提交，保留中间文件。自动/人工遮罩和透明图保存在 `projects/<id>/masks/<batch>/<version>/`，审核报告包含模型版本/摘要、异常帧清单和预览路径。

## 验收边界

已运行合成场景的实际 CPU 推理与桌面鼠标操作，验证分离细武器、半透明、擦除、保存、重启、撤销、旧结果拒绝和 CLI 待人工状态。2026-10-10 在用户默认项目真实31帧上复验近纯色背景，原始帧摘要不变、旧修订保留，第9帧的头发/脸/鞋/盾牌/剑抽样通过。见[问题修复报告](evidence/p2/roi-fix.md)。地面阴影可能保留，可用擦除画笔去除；复杂场景仍需人工逐帧检查，不能将抽样通过当作所有边缘的美术验收。
