# 0.2.0 发布门槛

当前工作以本文为准。`docs/plan/` 与 `docs/progress/` 是历史，不重新驱动开发。

## 当前基线

仓库版本是 **0.2.0 基线候选**。局域网连接、配对、快速发布和 SSE 已经跑通，不再把「第一版连接原型」当作当前范围。

当前要完成的是隐私、安全和稳定性验收，**不继续扩大功能**。不重写 Agent、不加 Intent Router、不多 Agent、不换数据库体系。现有分层继续用，把边界说清楚即可。

成功标准仍包括：重启后 Capture / ContentItem / 设备授权仍在；更换采集或行情实现不改页面 Contract。

## 已实现、待验收（不要写成「尚未开始」）

| 主题 | 文档里容易写错的说法 | 当前事实 |
|---|---|---|
| 产品范围 | 根 README / AGENTS 仍以连接原型为当前范围 | 0.2.0 基线候选，进入隐私、安全和稳定性验收 |
| 同花顺 | 尚未接入 | 已有适配代码；真实依赖、覆盖范围与延迟需验收 |
| AI | AI Worker 后续接入 | 已有单 Agent / Worker；Context Service 已向其供数 |
| 鸿蒙分享 | 分享详情页加载远端 ArkWeb | 原生分享先写本地 RDB Outbox；主 ArkWeb 恢复授权后上传 |
| 豆包队列 | Web、Worker、CLI 共用一条队列 | 目前仅各进程实例内部串行，进程之间不共享 |
| 下一步 | 固定做 B4 关注同步 | 先完成发布门槛，不继续扩大功能 |
| 持仓 | 加减仓都产生交易流水 | 仍是手工批次账本（`HoldingLot`），不宣称完整流水会计 |
| Instance | 已实现多用户 / 多租户 | 仅完成 single-user Instance 边界；没有 User、Tenant、权限后台或动态扩展加载 |

B站贴链接抓 AI 中文字幕已接入。关注 UP 列表同步不是本轮范围。

## 本轮验收方向

- **隐私与迁移**：当前私有仓库有意提交可移植的 Instance 内容（SQLite、Knowledge、个人 Catalog、必要导入资料），以便另一台 Windows 主机恢复同一内容；不提交 `.env`、API Key、Token、Cookie、浏览器 Profile、WAL/SHM、PID、运行日志或真实公网 Hostname。设备凭证服务端只存哈希。
- **Instance 边界**：进程启动不灌入个人持仓；Market / Tag / Taxonomy / Knowledge / imports 通过统一 Instance 路径；V16 Taxonomy 只作 Legacy Bootstrap；Browser / Search 仍是 Host 服务。
- **安全**：对手机只开放 Web/API；Worker、SQLite、浏览器调试口、Search Worker、旧仓服务只听本机。公网模式遵守 `docs/public-access-security.md`。二维码只带一次性配对码。
- **稳定性**：`npm run check`；重启后数据与授权仍在；SSE 可按 `Last-Event-ID` 补发；换 Adapter 不改页面字段。

Local Files MCP / Tailscale Funnel 不是 AI Center 公网入口，也不列入本产品发布范围。操作说明不得写入真实 Hostname 或本机路径。

## 不要一键批准无关补丁

Cursor 待处理文件操作里，可能混有更早的 Agent 补丁（例如不同版本的 `feed.tagged` / `feed.tag.search`、Runtime、Contract 和测试）。部分基于旧代码。批准全部待处理操作，可能把已经调整好的单 Agent 实现覆盖回旧方案。本轮只收束文档，不应用那些补丁。
