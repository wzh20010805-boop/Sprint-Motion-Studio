# P1 真实 Windows GUI 与 CLI 互通验证

实测时间：2026-10-10 01:55:28—01:55:45（Asia/Shanghai）。Bun 1.4.2、Electron 44.7.0；使用真实源码服务和上游编辑器，未用页面桩或第二套数据库代替。

最终命令退出 **0**，`desktop-p1-smoke.json` 的 `passed=true`；宿主 `smokePassed=true`，控制台错误与被拦截请求均为空。

## 已实际验证的流程

1. CLI 在 `fixtures/generated/p1-desktop-workspace/run-1791568528697` 创建项目，导入已有 160 × 120、24 FPS、48 帧合成 MP4，创建 Clip，执行 `extract --mode all --wait`。结果为 48 帧、状态 succeeded。
2. 宿主从该工作区 `.sfs/service.json` 获取本次实例的 URL 和令牌。令牌仅经环境变量传递，页面加载前设置 `sfs_token` Cookie（HttpOnly、SameSite=strict）；报告只保存属性，不保存值。
3. 加载同一项目 `/project/c261621b-9709-41a3-a70d-ca69f3872a50`，真实 Pixi 画布与 48 步时间轴渲染。未鉴权 API 与真正的 WebSocket 升级请求均返回 401；带 Cookie 的页面 API 返回 200，WebSocket 成功打开。
4. 点击真实界面“导入素材”→“上传文件”。`data-testid=sfs-extraction-mode` 内的 select 默认为 `all`，显示“全部原始帧（默认）”；抠图等待 P2 提示可见、没有默认选中的抠图复选框，生成 Tab 已禁用。
5. 使用 Electron DevTools 的 `DOM.setFileInputFiles` 选择该合成视频，再点击“导入 1 个文件”。此处执行真正的上传/任务流程，新增 Clip 有 48 帧、48 步，全部状态 ready，没有宣称完成场景去背景。
6. 点击真实时间轴第一格与“+ 时长”，由页面事件保存第一步时长 **1→2**。重新加载项目后仍显示 `×2`，且有实际 Pixi canvas；CLI 再查询相同项目看到修订 **99→200**、两个已抽帧来源与两个 Clip。两个来源各有 48 帧，是主动进行了两次导入，不是重复抽帧错误。
7. 烟测窗口关闭后，服务 PID **7116** 与 instance_id 保持一致，健康检查仍成功。GUI 没有停止 CLI 启动的共享服务。
8. 对同一轮已保存的 CLI / GUI 来源执行只读逐帧比较，没有重跑窗口或启动服务。忽略来源 ID 后，48 帧的 `source_index`、`pts`、`time_base`、`presentation_time`、`display_duration`、`duration_origin`、`decode_status` 全部精确相等，索引均为连续 **0—47**；总时长均为有理数 **2/1 秒**。两份原视频 SHA256 相等，48 对原始 PNG 的 SHA256 也逐一相等，**0 个差异**。完整字段与逐帧哈希见 `desktop-live/desktop-gui-cli-equality.json`，主报告同时保存该检查摘要。

这份证据验证完整抽帧入口、真实 GUI 编辑和持久化、API/WS 鉴权与共享服务生命周期。它不替代 P2 抠图质量、确定性导出或正式发行包验收。

## 实际发现并修复的 Pixi / CSP 问题

首次进入编辑器时，严格 CSP 下 Pixi 8.19.0 报：

```text
Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module to enable support.
```

P0 素材库页面没有创建 Pixi 画布，因此此前未暴露。此次在 `/pixi.min.js` 的普通和 gzip 响应中追加同版本安装包自带 `dist/packages/unsafe-eval.min.js`。该官方模块为 shader、UBO 等路径提供避免动态代码生成的实现；没有增加依赖或放宽 `script-src`。ETag 同时计入主脚本与兼容模块的文件信息，避免升级后沿用旧缓存。依据是已安装 8.19.0 模块源码和 [PixiJS v8 迁移说明](https://pixijs.download/dev/docs/migrations.html)。

回归测试执行真实返回脚本，在 VM 中禁止字符串代码生成：修复前得到相同异常；修复后渲染器检查通过。另验证 gzip 解压后的内容与普通响应一致，且两种 ETag 各自支持 304。实际 Windows Electron 画布也通过，没有只靠静态检查宣称修复。

宿主 CSP 的 `connect-src` 允许本地 `data:` / `blob:`，供 Pixi 图片解码能力探测使用；外部网络仍受同源白名单限制。P1 隐藏烟测使用 offscreen 绘制，导入弹窗等待配置稳定后再检查，避免把动画/异步初始化中间态当作最终产品状态。

## 命令、退出码与证据

工作目录：`D:\AIJOB\tools\Sprite Motion Studio\framebaker`。

```powershell
$desktopProbeBun = 'D:\AIJOB\tools\Sprite Motion Studio\.runtime\node_modules\@oven\bun-windows-x64\bin\bun.exe'
& $desktopProbeBun test tests/pipeline/pixi-csp.test.ts
& $desktopProbeBun test tests/server-runtime.test.ts tests/pipeline/pixi-csp.test.ts
& $desktopProbeBun run typecheck
& $desktopProbeBun probes/desktop/run-p1-smoke.ts
& $desktopProbeBun probes/desktop/run-p1-smoke.ts --compare-only
```

| 命令 | 退出码 | 证据与结果 |
| --- | --- | --- |
| CSP 回归修复前 | 1 | `evidence/p1/desktop-pixi-csp-red.log`：1 pass / 1 fail，精确复现动态代码生成错误 |
| CSP 回归修复后 | 0 | `desktop-pixi-csp-green.log`：2 pass / 0 fail |
| 服务既有回归 + CSP | 0 | `desktop-pixi-runtime-regression.log`：20 pass / 0 fail |
| server / web / CLI typecheck | 0 | `desktop-pixi-typecheck.log` |
| CLI + 实际 GUI 场景 | 0 | `desktop-p1-smoke.log`、`desktop-live/desktop-p1-smoke.json` |
| 已有 GUI / CLI 来源逐帧只读比较 | 0 | `desktop-gui-cli-equality.log`、`desktop-live/desktop-gui-cli-equality.json`：48/48 时序、原始 PNG 与总时长相等 |

`run-p1-smoke.ts` 为每轮建立新工作区与新服务实例，避免验证旧进程缓存的前端。完整 CLI argv、工作目录、退出码与原始 JSON 输出在 `desktop-live/desktop-cli-*`；宿主事件、Cookie 属性、资源、编辑值、截图及 token 缺失断言在 `desktop-live/desktop-report.json`。

截图已目视检查：

- `desktop-live/desktop-p1-editor.png`：CLI 创建的实际编辑器。
- `desktop-live/desktop-p1-import-defaults.png`：真实导入默认值与 P2 提示。
- `desktop-live/desktop-p1-upload-complete.png`：GUI 实际上传任务完成。
- `desktop-live/desktop-p1-editor-reopened.png`：保存并重开后首步 `×2`，真实画布显示合成帧。

首次失败记录与截图保留在 `desktop-attempt1/`，第二次实际 GUI 抽帧成功但探针关闭按钮文字假定有误的记录保留在 `desktop-attempt2/`。最初 gzip 测试把 Uint8Array 当字符串造成的探针错误日志也保留为 `desktop-pixi-csp-red-harness-error.log`，随后已修正解码/比较方法，再次得到针对真实产品问题的红测。

最终核查两次失败实例的记录 PID **18276 / 7824** 均已不存在，各自 `.sfs/service.json` 也已清理。因此没有向任何存活进程发送停止信号，也没有删除项目、来源、原始 PNG 或视频。该核查见 `desktop-failed-service-cleanup.json`。

P0 的已跟踪 `desktop-report.json`、`desktop-backend.stdout.log` 已按指定提交 `e09592c` 恢复；覆盖前版本保存在 `evidence/p1/desktop-preserved-p0-current-*`，后续运行不写 P0 证据。
