# X 首页时间线接入（Chrome 50 条）

## 目标

接上旧仓已实现的 Node 拉取：`fetch_home_timeline.js --feed for-you --limit 50`，不是 Nitter 公开 RSS。对照更新后的 `.cursor/rules/` 校准分层、落库与 451 提示。

## 对照 rules 的结论

符合：

- Route → Feed Service → X Connector；页面只消费 FeedItem，不暴露 GraphQL / CDP 字段。
- Connector 落在 `packages/connectors/src/x/`，manifest `connector.x`，Job `feed.x.sync`。
- 抓取结果写入 Capture / ContentItem，并与 Outbox 同事务（Repository 已有 `feed.capture.saved.v1`）。
- Cookie 不入库；登录在用户采集 Chrome 完成。
- HTTPS 451 映射为中文说明（关掉 `twitter.com`，改用 `https://x.com/home`）。

仍有缺口：

- 首次「拉取 50 条」仍走 Web GET 同步唤起 Chrome。规则要求长时间抓取进 Worker；`feed.x.sync` 已注册，定时调度尚未接上。
- Skill 路径仍允许兄弟目录 `../AI/skills` 回退；优先应使用 `AI_SKILLS_DIR`。

## 451 原因

`451 Unavailable For Legal Reasons` 来自采集 Chrome 打开了 `twitter.com`（或镜像），不是本机 CDP JSON。Skill 已改为只复用 `https://x.com/home` 标签。

操作：关闭采集 Chrome 里所有 `twitter.com` 页，打开并登录 `https://x.com/home`，重启 AI Center 后再点「拉取 50 条」。

## 改动

- `packages/connectors/src/x/home-timeline.js`、`x/index.js`；`twitter.js` 仅再导出
- `packages/domain/src/feed-service.js` 将外部快照落入 Capture / ContentItem
- `packages/connectors/src/index.js` 注册 `feed.x.sync`
- 旧仓 `pull-Twitter`：`startup_url` 与首页标签只走 `x.com/home`

## 验证

- `npm test`：50 条映射、登录墙、451 说明、落库、Job 注册、注入式 API
- 真机：采集 Chrome 需已在 `https://x.com/home` 登录

## 后续

- Web 改为入队 `feed.x.sync`，GET 只读已落库 ContentItem
- 去掉非环境变量的旧仓路径回退
