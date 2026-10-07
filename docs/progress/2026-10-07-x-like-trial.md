# X 单条点赞试用

## 目标与决定

用户希望在 AICenter 阅读后直接点赞 X 原帖。经检查，本机没有 X 官方 API 用户写入凭证；用户明确改选 BrowserRuntime 直接点击。复用现有 Instance 浏览器登录态，不索取账号密码、不新增 OAuth 凭证。本轮只实现点赞，关注另行验证。

## 改动

- 新增严格请求/结果 Contract、FeedInteractionService、固定 Worker manifest/handler 和受设备鉴权保护的命令/任务状态接口。
- 只接受保存内容 ID。Service 从 Repository 校验 workspace、X 来源、数字推文 ID 和原始链接；页面不能传 URL、脚本、Browser ID 或 Host 权限。
- Worker 单次点击原帖自身点赞按钮；已点赞不切换。拒绝歧义/弹窗/账号变化；页面乐观变红后重新打开原帖核验，失败保持未确认。
- 阅读页作者信息旁新增「在 X 点赞」。任务按 workspace 合并，客户端只查询既有任务；错误和未确认不会显示成功。重新渲染页面时按钮仍跟随正在执行的任务。
- 复用 jobs/outbox 事务与 lease，不新增 migration、不改原文、收藏或重点。Task 只执行一次 attempt，不自动重试外部写入。

## 验证

- `npm run check`：861/861，通过语法、Contract 类型、架构、Harmony 与全仓测试。
- `scripts/verify-feed-interaction.mjs`：隔离 Chromium DOM 验证原帖/回复隔离、账号变化保护、已点赞幂等、弹窗拦截、乐观更新回滚；390/1440px 用户点击与结果显示通过。
- 真实 BrowserRuntime daemon/extension/浏览器均连通；使用生产库只读选取一篇已保存 X 推文，在新标签页确认登录账号及准确的未点赞原帖按钮。未点击随机推文。
- 等待当时正在执行的信息准备/小时任务正常完成后，经现有启动器重载 Web/Worker。242 项排队任务临时延后并按预期 availability 全数恢复，未中断运行任务；新 JS 返回 200、专用任务查询路由已加载、健康检查通过。
- 真实保存内容阅读页 390/1440px 均显示「在 X 点赞」，无页面脚本错误或横向溢出。只打开阅读页核对显示，没有触发 X 写入。

## 遗留

真实写入由用户在选定推文上点击后验收。网页改版、登录失效、验证和 X 对网站脚本操作的限制仍会影响稳定性；不能将只读定位通过当成真实点赞写入通过。全仓检查不替代长期稳定性或整体发布验收。
