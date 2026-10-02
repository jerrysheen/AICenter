# 0.2.0 发布门槛

当前工作以本文为准。`docs/plan/` 与 `docs/progress/` 是历史，不重新驱动开发。

## 当前基线

仓库版本是 **0.2.0 基线候选**。局域网连接、配对、快速发布和 SSE 已经跑通，不再把「第一版连接原型」当作当前范围。

当前要完成的是隐私、安全和稳定性验收，**不继续扩大功能**。量化实验室 V0 是单独授权的范围例外，只跑通一条 Qlib 研究基线，说明见 `docs/quant-lab-v0.md`。不加 Intent Router、不多 Agent、不换数据库体系。Ask / 文章阅读的生产执行器是冻结 DeepSeek Harness；不在这轮设计资料搜索插件。本地循环只作测试注入或显式回退。0.2.0 发布门槛仍是隐私、安全和稳定性，不因此扩大产品功能。

成功标准仍包括：重启后 Capture / ContentItem / 设备授权仍在；更换采集或行情实现不改页面 Contract。

## 已实现、待验收（不要写成「尚未开始」）

| 主题 | 文档里容易写错的说法 | 当前事实 |
|---|---|---|
| 产品范围 | 根 README / AGENTS 仍以连接原型为当前范围 | 0.2.0 基线候选，进入隐私、安全和稳定性验收 |
| 同花顺 / 雪球 | 尚未接入行情 | 沪深/港股通/B 股现价优先雪球批量行情；同花顺快照作缺票回退。延迟与风控需验收 |
| AI | AI Worker 后续接入 | 已有单 Agent / Worker；生产执行器是 DeepSeek Harness。文章阅读是 Article Analysis Skill（`ai.article.analyze`）：复用同一套执行器，不改普通问答 Tool Loop |
| 鸿蒙分享 | 分享详情页加载远端 ArkWeb | 原生分享先写本地 RDB Outbox；主 ArkWeb 恢复授权后上传 |
| 翻译 / Tag | 仍走豆包网页或手动 CLI | 自动翻译和粗筛 Tag 走 Gemini。生产 Ask 的公开互联网是 Harness 内置 `web_search` / `web_fetch`。默认启动不再创建 DeepSeek Search Provider、`search.web` 或 Domain `web.search`。这些与豆包补充检索只留给本地循环回退。SearXNG 保留代码，主链路不调用。豆包翻译 / 标注不恢复，历史译文 / Tag 行保留 |
| 下一步 | 固定做 B4 关注同步 | 先完成发布门槛，不继续扩大功能 |
| 持仓 | 加减仓都产生交易流水 | 仍是手工批次账本（`HoldingLot`），不宣称完整流水会计 |
| Instance | 已实现多用户 / 多租户 | 仅完成 single-user Instance 边界；没有 User、Tenant、权限后台或动态扩展加载 |
| 静态信号源 | 宏观日历仍只是未来占位 | 已注册 17 个中美宏观、央行、会议和政策官方源，并提供确定性聚合首页；SCIO 使用已明确接受的官方 HTTP 列表，GACC 在当前主机仍受官网证书链影响降级为 unavailable |
| 市场原生源 | 与官方日历混成一类或自动解释成预测 | 已注册 Polymarket、Kalshi、Hyperliquid、DefiLlama 只读 Snapshot；场所报价保持分离，真实网络可用性与字段漂移仍需逐源验收 |

B站贴链接抓 AI 中文字幕已接入。关注 UP 列表同步不是本轮范围。

## 本轮验收方向

2026-10-02 媒体正文稳定性修复在 `docs/progress/2026-10-02-media-body-audit.md` 记录逐篇
响应、失败、预算和版本核对。DCD / Next Platform / Decoder 与已有美联储来源走同一正文闭环，
BBC / FT 继续按实际用途限制保留索引。该验收不扩大信源数量或 Agent Runtime。
随后用户明确授权全文阅读闭环，见 `docs/progress/2026-10-02-media-reading-pipeline.md`：
全文分段翻译、X标签、每小时检查和阅读排版已实测，25篇全文均完成译文和标签；
Techmeme仅接入两家登记原报道，宏观全文4篇，其他摘要/受限线索保持真实等级。
该授权不改变Agent Runtime或其安全边界。
本地提交前补充处理启动器身份边界与真实工作簿集成测试：未记录进程须精确匹配入口和Instance身份，资产测试逐行核对源工作簿而不锁死历史期数。提交检查结果见 `docs/progress/2026-10-02-local-commit.md`；媒体专项测试通过仍不等于整个0.2.0发布验收完成。

- **隐私与迁移**：当前私有仓库提交可移植的 Instance 文件内容（Knowledge 文件、个人 Catalog、必要导入资料与附件）；运行 SQLite 数据库只在本地保存和更新，通过独立的一致备份恢复，不再提交 Git，也不启用 LFS。不提交 `.env`、API Key、Token、Cookie、浏览器 Profile、WAL/SHM、PID、运行日志或真实公网 Hostname。设备凭证服务端只存哈希。停止数据库跟踪与未发布超限提交修正见 `docs/progress/2026-10-02-local-database-git.md`。
- **Instance 边界**：进程启动不灌入个人持仓；Market / Tag / Taxonomy / Knowledge / imports 通过统一 Instance 路径；V16 Taxonomy 只作 Legacy Bootstrap；Browser / Search 仍是 Host 服务。
- **安全**：对手机只开放 Web/API；Worker、SQLite、浏览器调试口、Search Worker、旧仓服务只听本机。公网模式遵守 `docs/public-access-security.md`。二维码只带一次性配对码。已配对不等于 Host 编码权限：公网 Ask 不得使用 bash / 写盘 / subagent，也不得派发 Cursor CLI。调用方能力平面已写入设计；实现收口另做，不在本轮扩功能。
- **稳定性**：`npm run check`；重启后数据与授权仍在；SSE 可按 `Last-Event-ID` 补发；换 Adapter 不改页面字段。
- **Harness 运行状态**：Ask / 文章阅读的 Job 状态继续以 SQLite 为真源；Harness `session.event` / `session.status` 只进入脱敏的 Agent Run 进度投影。`GET /api/v1/agent/runs/:id` 和 SSE 不读取 DSH 私有 JSONL、Session Query 数据库或 Host 路径。真实 Harness 事件结构必须有端到端测试，不能只用扁平假事件证明进度可用。
- **静态信号源**：BEA TBA、Census Suspended、NBS 单月双日期与 GACC 年度缺失/日期精度已有确定性测试；官方固定规则生成项必须显示为 tentative；来源不可达时降级为 unavailable/partial，不能回填第三方预测数据。SCIO 的 HTTP 例外必须保持 URL 级隔离；GACC 的真实网络可用性仍需在官网证书恢复或另一受信网络环境复核。
- **市场原生源**：逐源核对公开 API 的字段与限速；不得把两个预测市场报价合成“真实概率”，不得把 tokenized / derivative 价格当官方股票现价；Funding、OI、Volume、Supply 的单位必须在页面可辨认。

Local Files MCP / Tailscale Funnel 不是 AI Center 公网入口，也不列入本产品发布范围。操作说明不得写入真实 Hostname 或本机路径。

## 不要一键批准无关补丁

Cursor 待处理文件操作里，可能混有更早的 Agent 补丁（例如不同版本的 `feed.tagged` / `feed.tag.search`、Runtime、Contract 和测试）。部分基于旧代码。批准全部待处理操作，可能把已经调整好的单 Agent 实现覆盖回旧方案。本轮只收束文档，不应用那些补丁。
