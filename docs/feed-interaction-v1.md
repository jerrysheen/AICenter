# X 点赞试用

2026-10-07 用户授权单独扩展：在已保存的 X 推文阅读页，由用户点击「在 X 点赞」，通过现有 BrowserRuntime 在已登录采集浏览器执行。不使用官方 API 凭证，不新增 Agent、Runtime、数据库或关注同步。

## 边界与兼容

- 这是 Feed 的明确写入命令，不注册为只读 Source 或 Harness Tool。页面只提交已保存 ContentItem ID 和 `confirmed:true`，不接受 URL、脚本、浏览器 ID、供应商权限或任意动作。
- `POST /api/v1/content-items/:id/x-like` 受现有设备鉴权保护，Service 用 Repository 校验 workspace、来源、推文 ID 与原始链接后建立固定 `feed.x.like` Job。Worker manifest 声明 `feed.interaction.like`，只执行注册 handler。
- 已配对设备只调用这一固定业务操作，不获得浏览器会话、Shell 或其他 Host 能力。会话内部使用 Instance Browser ID，HTTP 入参不能覆盖。任务结果不输出 Cookie、调试端口、浏览器路径或命令异常。
- `GET /api/v1/content-items/:id/x-like/:jobId` 校验 workspace、任务类型和关联内容，只投影任务状态及脱敏结果。
- Job/Outbox 沿用现有事务、租约和 SSE；不改用户数据库结构，不保存假的本地点赞状态，不改收藏、重点或原文。结果真源仍是 X，Job 只是一次执行记录。
- 同一 workspace 只允许一个待完成点赞，重复请求复用任务；单次执行只点击一次，最多一次 attempt，不自动重试外部写入。恢复执行时先读状态，已点赞不点击取消。
- 专用标签页只访问固定 `https://x.com/i/web/status/<数字ID>`。定位原帖自身时间戳链接，拒绝歧义、登录墙和可见弹窗。点击后重新打开原帖核验持久状态；超时/验证失败显示未确认。
- 当时仅点赞。关注作者仍不做。2026-10-18 增加用户手动触发的 `feed.x.unlike`，以及按方向分自动派发的 `feed.x.like`（来源记为自动，默认关闭）。重复点赞仍不点击取消。见 `progress/2026-10-18-x-focus-steer.md`。2026-10-26 起，模型分或沿用分写上内容项、关键词分被补写成模型分、以及已有模型分的帖分类结论发生变化时，立刻再选一条。整批入库结束后的那次选条仍在。同一条已有点赞任务，或已经有一条点赞还在处理，就不会再入队。见 `progress/2026-10-26-x-auto-like-score-timing.md`。

## 稳定性与验收

网页改版、验证、登录失效和网络错误会影响此适配。X 官方不支持非 API 网站自动化；不能将 BrowserRuntime 接通或按钮变红写成官方支持或真实写入通过。

先只读探测真实已保存推文，确认账号和原帖按钮可识别。使用隔离夹具验证回复/引用隔离、已点赞幂等、乐观更新后回滚、结果未知、权限与 workspace 边界。真实点赞由用户在选定内容上点击验收；没有指定测试推文时不对随机作者执行点赞。
