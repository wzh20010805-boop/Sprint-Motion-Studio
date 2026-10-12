# 素材创意工坊 1.0.2：中文品牌与首页插图

2026-10-12。按用户要求，中文名称改为“素材创意工坊”，首页标语改为“让创意，动起来！”；英文产品名称保持原值。顶部导航、首页标题、浏览器标题和 Windows 窗口标题一致，打包说明同步。

## 插图

首页改用 Pablo Stanley 的 Open Doodles “clumsy”：手绘人物和飘动纸张表现创意与运动。官方来源：https://www.opendoodles.com/ ，原 SVG：https://opendoodles.s3-us-west-1.amazonaws.com/clumsy.svg 。官方说明：https://www.opendoodles.com/about ，以 CC0 提供，可使用和修改。

原始图形路径保留，SVG 的填色改用现有主题粉色和墨色，调整画布留白以适配紫色横幅。插图随代码和便携包提供，不加载外部图片、不增加依赖。下载文件和原始 SHA256 已留档于 fixtures/generated/creative-brand-assets 与 THIRD_PARTY_NOTICES.md。

## 验证

- 真实 Electron 首页检查：1360px 亮色、1360px 暗色和 760px 窄窗口均通过。检查中文品牌、标语、document.title、主题、实际 SVG 路径和远程图片数量；横幅和插图在视口内，文字与插图不重叠，标语保留可读行宽。
- 首次窄窗口虽然没有重叠，但标题行宽过小。已让首页文案与操作按钮在窄窗口分行，重跑上述检查通过。初次目录保留；最终证据为 fixtures/generated/brand-ui-r3/desktop.json。
- 类型检查（server/web/CLI）通过，版本检查通过，版本为 1.0.2。此轮是界面和打包变更，没有新增镜像式单元测试。
- 使用新便携包再次运行原有正式导出验收，结果见 portable-summary.json；仍限于本机 Windows 换目录与系统 PATH，不能视作干净 VM 或真实素材美术验收。

## 工作区

程序版本与个人素材分开保存。此电脑桌面 preferences.json 已指向原有 D:\AIJOB\tools\Sprite Motion Studio\framebaker\workspaces\default，其中 test 项目的 27 帧原图及处理图片已在上一轮逐项检查存在。别人的便携版默认创建其 LocalAppData 下的个人工作区，也可用菜单选择已有目录。本次界面验证全部使用 fixtures/generated 下的隔离工作区，不修改个人项目。

下载本轮 1.0.2 便携包后运行新目录里的 SpriteMotionStudio.exe；此前已解压的旧程序不会被原地替换。本轮未提交或推送 GitHub。
