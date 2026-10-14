# 2026-10-14 工作区、端口与重复文件清理

本次由用户授权执行实际清理。最终完整目录从 **27,985,615,783 字节（26.06 GiB）**下降到 **22,404,123,509 字节（20.87 GiB）**，实际净减少 **5,581,492,274 字节，约 5.20 GiB（19.94%）**。这已经计入本轮新生成的测试数据、保留的归档、验证清单和日志。

下表重复副本的删除对象扣除 CI 归档为 5.55 GiB；之后还归档清理了本轮测试目录。对象回收量与完整目录前后差有不同口径，以以上最终目录统计为瘦身结果。

## 已清理

| 对象 | 删除字节 | 保留与核验 |
| --- | ---: | --- |
| 已合并的 `ci-platform-fix` Git 工作树 | 3,462,444,750 | 分支提交均已在 main；先保存独有资料，再由 Git 正式移除工作树 |
| `dist/最新便携版/SpriteMotionStudio-1.0.7` 解压副本 | 1,446,000,308 | 保留 `SpriteMotionStudio-win-x64-1.0.7.zip` 及 SHA256/JSON；ZIP 的 9,343 个文件逐项 SHA256 相等 |
| Electron 下载 ZIP 缓存 | 158,293,649 | 保留实际运行的 `probes/desktop/node_modules/electron` |
| 6 个旧 `no-console-worker.exe` 测试产物 | 516,538,368 | 保留各次 console.json/日志；测试每次重新编译，新增结束后删除本次 EXE |
| 旧 UUID 目录中的完整 Electron 副本 | 385,514,847 | 73 文件与标准运行时逐项哈希相同；5 个验证脚本和真实桌面测试均改用标准路径，保留旧 provenance 历史记录 |
| 新增 CI 资料归档 | −10,973,352 | 下文记录归档及校验结果 |

CI 归档位于仓库上级 `production/_archive/ci-platform-fix-20261014.zip`，包含 779 个文件、原始资料 66,341,791 字节。保存独有 CI 日志、非 FFmpeg 测试夹具、storage、历史证据、分支/HEAD、原工作树 21 项已缺失图片的删除补丁和 SHA256 清单。所有归档文件逐项读回通过 CRC 与 SHA256 校验。保留分支 `fix/ci-platform-dependencies`，不删除 Git 历史。

归档 SHA256：`321ef029107b3e12a1ad1a6d952454d98d7ee1d02bb8c499b4dcb3e5b25180bc`。

本轮新生成的 **514 个合成测试工作区**（47,983 文件、746,467,422 字节）另外保存至上级 `production/_archive/cleanup-validation-20261014.tar.gz`（254,055,741 字节）。容器全部文件逐项 SHA256 读回通过，源文件复核未变化，随后删除这些新目录；额外复制运行日志、源码哈希和两份新 SDD 结果，原日志仍保留。三个指向主项目 apps 的 junction 只保存链接元数据，并先删除链接本身，没有遍历或删除其目标。旧手工验证、SDD、provenance 及生产素材保留。

测试归档 SHA256：`b53b671689e96793d4333f26bf8c13431db47b72221830fe637d9f84c2947edc`。外部完整验证清单位于上级 `.runtime/cleanup-validation-verified-20261014.json`。最终检查确认 514 个容器全部移除、主项目 apps 保留、没有 Bun/Electron/SpriteMotionStudio 进程运行。完整体积扫描跳过 277 个重解析节点，0 错误。

## 统一工作区

本机登记位于 `framebaker/.sfs/workspaces.json`，文件被 Git 忽略。默认选择为 **character-current**；双击 `Start-SFS.cmd` 和未指定工作区的源码 CLI 使用这份当前角色工作区。登记现存目录，不移动数据库或素材路径。

| 登记名称 | 用途 | 当前状态 |
| --- | --- | --- |
| `character-current` | 上级 production/character-20261014/v2/workspace，当前六动作及正式交付 | 当前选择 |
| `studio-default` | workspaces/default，已有素材与编辑结果 | 保留 |
| `upstream-baseline` | storage，上游基线及历史编辑 | 历史保留 |
| `character-first` | production/char-b7718bbe/workspace，早期角色制作 | 历史保留 |
| `character-legacy` | 上级 production/character-20261014/workspace，包含独有静态口型项目 | 历史保留 |
| `portable-default` | Administrator 用户目录中的旧便携工作区 | 保留，不移动 |

这些工作区有独立数据库和项目历史。相同来源视频/原帧不能证明整个目录可删除；候选还需保存固定输入、父候选和真实审核记录。现有正式素材包、final-approved、timing-60fps、原视频、全部候选和生产日志保留。

```powershell
.\sfs.cmd workspace list --json
.\sfs.cmd workspace current --json
.\sfs.cmd workspace use --name character-current
.\sfs.cmd workspace add --name my-work --directory D:\MyWorkspace
.\sfs.cmd service status --json
.\sfs.cmd service stop --json
.\sfs.cmd service clean --json
```

优先级为 `--workspace` → `SFS_WORKSPACE` → 已选工作区 → 默认目录。源码缺省目录为 `workspaces/default`；便携版缺省目录及登记位于用户本地目录。登记损坏或已选目录丢失时明确报错，不静默创建另一个数据库。查询不启动服务、不输出凭据；登记拒绝同目录的重复别名，已有目录解析真实路径，Windows 比较忽略大小写。登记读改写受排他锁保护，竞争返回 `WORKSPACE_REGISTRY_LOCKED`，避免成功响应后资料丢失；未知锁不自动删除。列表中 `registered:false` 为默认/当前目录提示，名称不会覆盖真正登记的别名。

## 端口与接口

每个实际启动的工作区只有一个经认证的 `127.0.0.1` HTTP 监听，网页、API、WebSocket 和 maker MCP 共用它。默认 `PORT=0` 自动分配；端口通过当前工作区服务发现，不再依赖旧 3000 或曾经的随机端口。多个独立工作区同时运行时各有一个端口，这是数据隔离所需，不应强行合并数据库。

`bun start/dev` 改为锁、会话、桌面审核 broker 就绪的 bootstrap 入口。CLI、DB 与 bootstrap 共用工作区选择。未来便携桌面选择也使用同一用户登记；首次沿用旧 preferences 中的工作区。现存 1.0.7 ZIP 保留旧发布行为，没有改写发行包。

服务停止使用经认证的 `POST /api/v1/runtime/stop`。服务在同一同步步骤核验任务、其他请求及 WebSocket，忙碌时拒绝退出；接受后立即阻止新请求，再协作关闭。不使用外部 Windows SIGTERM 强杀。`service clean` 仅清理确认无活动所有者的发现记录，保留数据库、素材和日志。

本次移除两处生产工作区共 10 份旧 service/lock/bootstrap 连接记录。旧生产工作区仍有 **2 个受旧 Windows 私密权限保护的 bootstrap 备份（合计 579 字节）**无法删除，已保留且未放宽权限；对应端口描述及锁已删除，它们不会参与服务发现或审核启动。当前工作区旧记录已清除。生产重启脚本不再按时间戳复制旧凭据。

源码生产 API 从 1.2 升至 **1.3**，精确版本握手避免复用旧服务。删除 7 个没有 GUI/CLI/MCP 消费者的 flat 审核写入别名和一个重复读取别名，改用已有 candidate/issue/task 范围接口；旧入口返回 404 且不写入审核记录。移除无生产调用的 `authorizeLocalRequest`，实际鉴权仍使用 `localSessions`。完整迁移表见 [API 文档](api.zh-CN.md)。保留编辑器、流水线、协作接口和独立桌面审核 IPC 的权限边界。

## 验证与保留事项

新增工作区与服务管理测试包含选择优先级、失效端口、损坏登记、不泄露凭据、启动锁冲突、忙碌退出、历史记录、登记并发、目录别名和真实鉴权服务协作停止。固定最终源码哈希后冷启动完整测试：**549 通过、1 默认跳过、0 失败**（550 项、95 文件，387.06 秒）；全程源码哈希一致。默认跳过的真实桌面宿主测试已另外启用，与工作区和服务管理组合共 **25 通过、0 失败**，标准 Electron 的两个宿主均使用私有审核会话。Python image-worker **31 通过**；TypeScript、版本一致性及 `git diff --check` 通过。

测试日志位于仓库上级 `.runtime/workspace-cleanup-cold-tests.log` 和 `.runtime/workspace-cleanup-runtime-final.log`；已保存固定源码 SHA256 清单。完整验证只使用生成的独立测试目录；正式角色工作区的数据没有搬移或合并。用户随后授权将本轮源码与文档作为一个独立提交同步到 GitHub main；本机目录、私密配置、测试归档和此前缺失的历史图片不纳入这个提交。

清理前已有 144 个被 Git 跟踪的历史证据 PNG 在本地缺失；本次没有将其恢复、提交或当作瘦身成果。已有历史资料与测试证据不批量删除。目录大小核算跳过 junction/reparse points，删除前逐项核对绝对路径，避免清理越出工作区。

## 源码回滚与本机资料恢复

清理前源码为 `93a34ec71d896b4144d70c7192e7411135fe1b9d`（生产 API 1.2）。发布时保留回滚标签 `backup/pre-workspace-cleanup-20261014`，本轮源码/说明集中为一个提交。若需要撤销，可在保存当前工作、关闭 GUI/MCP 并停止空闲服务后，对本轮提交执行 `git revert <本轮提交号>`，再推送 main；这会追加恢复提交并保留所有历史，无须强制推送。

回滚源码不会搬移工作区或恢复磁盘文件。现有素材、候选与数据库一直保留；本机 `.sfs/workspaces.json` 是 Git 忽略的个人选择，同步前另保存到上级 `production/_archive/workspace-selection-20261014.json`。源码回滚后按对应版本的入口和明确工作区启动，不应同时启动两个版本写同一工作区。

- 独有 CI 资料从上级 `production/_archive/ci-platform-fix-20261014.zip` 恢复；原分支仍保留。
- 本轮合成测试资料从 `production/_archive/cleanup-validation-20261014.tar.gz` 恢复，先解压到独立恢复目录并核对归档/文件校验，不覆盖当前工作区。三个 junction 保存为元数据，需确认目标后再重新创建。
- 旧便携版解压副本可从保留的 `dist/最新便携版/SpriteMotionStudio-win-x64-1.0.7.zip` 重新解压。
- 被删除的 Electron/FFmpeg 下载缓存及测试 EXE 属于可再生文件，使用安装/构建脚本重新生成；没有为每个缓存保留完整副本。

这些本机归档没有上传 GitHub，因此 GitHub 源码标签提供源码回滚，本机归档提供本机证据恢复。已发布的 1.0.7 便携包保持原发布版本，本次同步不重新打包发行 ZIP。
