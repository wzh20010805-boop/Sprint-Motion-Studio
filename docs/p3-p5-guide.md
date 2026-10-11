# P2–P5 使用与 Codex 接入

便携版双击 `SpriteMotionStudio.exe` 或 `START.cmd`。包中自带 Bun 服务、独立 Python、FFmpeg、前端与字体，不要求安装开发环境。默认工作区是当前用户 `LocalAppData/SpriteMotionStudio/workspaces/default`，菜单可切换。模型不随包附带；菜单提供明确下载或离线导入 u2netp，验证 SHA256 后才安装。首次离线仍可导入 PNG、修正已有遮罩、对齐和导出。

已有开发版项目仍在原 `framebaker/workspaces/default`，可通过“切换工作区”选择该目录；不要复制/删除原件。新版拒绝复用缺少 production_api_version 1.0 的旧服务并返回 BACKEND_VERSION_CONFLICT。先保存旧窗口，等任务结束并关闭旧窗口，待服务空闲退出后再打开；不会自动杀死用户服务或修改项目审核。

GUI 导入动作后打开“场景抠图与修正”：在原图框住完整角色和装备、生成初稿、擦除/恢复、检查黑白底和 Alpha、逐帧确认。打开“导出动画”：配置公共画布/锚点/比例，固定根位置或标注地面轨迹关键帧，逐帧微调。源左侧、共享后端预览右侧；左右键选帧，空格按实际帧时长播放，播放时隐藏洋葱皮。

保存参数，执行全动作越界预检；确认当前修订后正式导出。跳跃、下蹲和倒地时标注地面投影，不追随脚底。越界不会自动缩小该帧。草稿明确标识，正式输出必须所有遮罩与对齐已确认且输入仍与确认时一致。导出完成可下载完整 ZIP。

CLI 在 PowerShell 使用 `& '发行目录/sfs.exe'`。以下省略该前缀；每条命令传相同的 `--workspace '工作区绝对路径' --json`。

```text
doctor --json
project list
project create --name 小兵
project inspect --project PROJECT
import video --project PROJECT --file input.mp4
import images --project PROJECT --directory png-sequence
clip create --project PROJECT --source SOURCE --name 攻击
extract --project PROJECT --clip CLIP --wait
matte --project PROJECT --clip CLIP --wait
mask show --frame FRAME
mask edit --frame FRAME --strokes strokes.json
mask undo --frame FRAME
mask review --frame FRAME
align --project PROJECT --axis AXIS --config alignment.json
inspect --project PROJECT --axis AXIS
preview --project PROJECT --axis AXIS
review apply --project PROJECT --axis AXIS --base-revision REVISION --patch review.json
export --project PROJECT --axis AXIS --wait --output NEW_DIRECTORY
pipeline run --project PROJECT --axis AXIS --clip CLIP --recipe recipe.json --wait
job status --job JOB
job wait --job JOB --timeout 300
job cancel --job JOB
job resume --job JOB --wait
schemas --name alignment --json
schemas --name recipe --json
schemas --name manifest --json
mcp --stdio
gui
```

`--axis` 也可由 `--clip` 推导，只有一个动作时可省略。`--format png-sequence|grid-sheet|manifest` 校验格式名；共享导出总附完整包。`--draft` 允许未批准的检查输出；`--timing source_pts|constant` 选择源逐帧时长或时间轴FPS/倍数。`--output` 要求新目录，拒绝覆盖。CLI stdout 长数组输出计数与8项样本，完整数据留在本地清单。

`alignment.json` 示例（坐标为源图左上像素边界，索引从0开始）：

```json
{"canvas":{"width":128,"height":128},"anchor":[64,112],"scale":1,"resampling":"pixel","mode":"ground_keyframes","roots":[{"index":0,"x":64,"y":112},{"index":2,"x":66,"y":112}],"offsets":{}}
```

高清卡通用 `resampling: "cartoon"`，采用预乘 Alpha 插值后还原直 Alpha。固定基准用 `mode: "fixed"` 和一个root；地面关键帧线性插值、区间外保持端点。

`recipe.json` 示例：

```json
{"schema_version":"1.0","extract":{"mode":"all"},"matting":{"backend":"rembg","model":"u2netp"},"output":{"draft":true,"timing":"source_pts","max_texture":2048,"gap":2,"margin":1}}
```

`--wait` 推进抽帧等已成功的自动阶段；生成抠图初稿后遇 `waiting_user` 停止。逐帧审核后可用相同 recipe 继续。明确包含matting时，仅处理无遮罩或未审核的导入PNG初稿，保留已确认/已有自动或手工处理的遮罩。recipe可包含 `alignment`，它会修改公共预设并使旧审核失效。正式导出前 `review.json` 要由已经获得的用户确认构成，例如 `{"confirmation":"用户已检查当前全部遮罩和地面轨迹","source":"本次对话的明确确认"}`；不能把示例当确认授权。

Codex 可直接执行 CLI；MCP 客户端配置可选择 stdio，程序为发行目录 `sfs.exe`，参数 `mcp --stdio --workspace <绝对目录>`。本项目不改已有全局配置。`skills/soldier-frame-studio/SKILL.md` 仅教调用实现接口，可在需要时由用户选择安装。九个 MCP 工具：inspect_capabilities、inspect_project、import_source、submit_pipeline、get_job、cancel_job、get_review_artifacts、apply_review_patch、export_assets。大视频推荐CLI multipart；MCP import_source接受已提供的视频字节且有大小限制，不接受服务器任意路径。

所有入口使用同一鉴权回环服务、项目修订、队列和产物。GUI不打开也可正式导出已有审核的项目。MCP保持客户租约；窗口关闭有任务时可保留后台、取消或返回，无客户无任务时服务空闲退出。

输出 `manifest.json` 含源帧索引、SHA256、逐帧有理数时长、规则图集左上矩形、公共画布与 Cocos y向上归一化锚点；序列不去重、不旋转、不逐帧裁边。`quality-report.json` 含空帧与越界检查。联系表最多256缩略图，完整序列和清单保留全部帧。`previews/preview-on-background.mp4` 是检查视频。`checksums.json` 支持校验，`assets.zip` 便于整包下载，旧成功版本不会被覆盖。

退出码：0成功、2无效参数/输入、3依赖、4待人工、5取消、6锁/修订冲突、1其他失败。`job status` 成功查询历史失败仍返回0。超时不会取消后台任务，错误应查询job或工作区 `.sfs/service.log`。丢失源/处理文件须重新定位或重新导入；不能以原图充作透明输出。

卸载删除解压目录；个人工作区、模型和素材默认保留。当前包未签名；本机换目录、限制PATH测试不等于干净Windows虚拟机验收。真实素材美术确认与Cocos实际播放仍应单独完成，详见 `docs/evidence/p2-p5/report.md`。
