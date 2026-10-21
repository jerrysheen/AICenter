# 2026-10-21 X 自动点赞选条与自动不感兴趣

线上自动点赞没有产生过点赞。页面开关默认关闭。就算打开，选条也是最近 400 条捕获，大约只覆盖 1 小时，其中大部分还没有 xFocus，模拟结果是 0 条。推荐流一天大约 9600 条，只有约 15% 打了分。另外，保留判断要求分类结果必须是 KEEP，而且不能是兜底，1447 条里只剩下 185 条。

## 决定

- 自动点赞只看最近 24 小时、已经写下模型分或沿用模型分的推文，按相关度从高到低选。关键词兜底分不点。查询走原来的 xFocus 索引，上限 5000 条，不再先拿最新 400 条原始捕获。
- 配置版本保持 `x-focus-2`。提示词收紧后，已经按这个版本打好的分仍然可以点，否则上线后 24 小时内仍然选不到。
- 分类提供者是 Bamboo 时，没有分类结果的推文可以进入点赞候选，只排除明确标成 DROP 的。其他提供者仍要求真实 KEEP，`fallback-` 和 `jev-disabled-` 开头的保留结果不点。
- Bamboo 的点赞分数线提高到 0.8。主方向是企业动态时仍至少 0.9。没有分类客户端时，其他方向仍至少 0.9。
- 七个方向都是 0 分时，主方向留空，不再落到美股大盘。
- 提示词写明：体育竞猜、比赛赔率和博彩不是 Polymarket。SaaS 或 AI 工具的推广、营销和口水帖算 `promotional`。娱乐八卦、明星私生活和与市场无关的爆料闲聊算 `gossip`。旧分数没有 `gossip` 时按 false 读取。
- 新增自动「不感兴趣」，只作用于推荐流。单条推文是推广、八卦，或正文命中自动点赞用的广告词，就标记这一条。或者同一个账号在这 24 小时的推荐流里，最近连续 3 条模型分都低于 0.3，就标记最新的一条。3 和 0.3 写在 `config/x-focus.json` 的 `notInterested`。
- 不标记已关注账号、政要本人发言、没打上模型分的帖、关注流里的帖，以及已经点过赞或已经标记过的帖。
- 默认每天 10 条、每小时 3 条、两次至少间隔 10 分钟。环境变量 `AI_CENTER_X_NOT_INTERESTED_DAILY`、`AI_CENTER_X_NOT_INTERESTED_HOURLY`、`AI_CENTER_X_NOT_INTERESTED_INTERVAL_MS` 可以覆盖。总开关 `AI_CENTER_X_NOT_INTERESTED` 缺省关闭，只有 `1`、`true`、`on` 才打开。页面开关也默认关闭。
- 登录失效、页面被拦截、连续 3 次点不到菜单、连续 2 次没有确认，或连续 2 次任务失败，就关掉页面开关并留下原因。成功一次会把这串计数清零。
- 点赞和不感兴趣共用原来的浏览器会话，同一时间只做一件。先尝试点赞，点赞没有发出时再尝试不感兴趣。
- 不感兴趣打开这条帖的固定地址，只认正文链接就是这条 id 的那一张帖。打开它自己的更多菜单，只点击「不感兴趣」或 “Not interested in this post”。不点静音、屏蔽或按位置乱点。确认看页面上的提示。菜单里没有这一项就记为暂时无法操作。
- 每条操作写入 `x_not_interested_actions`。推荐记录页列出这些记录，并给出最近 14 天每天的点赞条数、不感兴趣条数，以及推荐和关注各自的方向命中率。
- 自动点赞的页面开关仍默认关闭。要自动点赞，仍需同时打开 `AI_CENTER_X_AUTO_LIKE` 和页面开关。

## 改动

`config/x-focus.json`、`packages/domain/src/x-focus.js`、`packages/domain/src/x-auto-like.js`、`packages/domain/src/x-focus-score.js`、`packages/database/src/repositories/feed-repository.js`、`packages/database/src/repositories/author-repository.js`、`packages/connectors/src/x/like-browser.js`、`packages/contracts/src/feed-interaction.js`、`packages/domain/src/feed-interaction-service.js`、`packages/runtime/src/feed-interaction-module.js`、`apps/worker/src/worker.js`、`apps/web/src/routes/x-focus-routes.js`、`apps/web/public/x-focus-page.js`、`apps/web/public/styles.css`。migration 95 只新增 `x_not_interested_actions`。

## 验证

`node --test test/x-not-interested.test.js test/x-focus.test.js`。24 小时内的模型分和沿用分能被查到，关键词分和未打分的最新帖不会入选。Bamboo 下放行没有分类结果的帖并排除 DROP，0.79 不点、0.8 点，企业动态 0.89 不点、0.9 点。全 0 分的主方向为空。不感兴趣在两个开关都关闭时不运行；推广、八卦和连续 3 条低分会入选，已关注、政要发言、关注流和只有 2 条低分不会。浏览器表达式只点击匹配帖菜单里的不感兴趣，不点击静音或点赞。页面能画出每天的两组数字，两个开关默认都是关。

## 部署

不要重建数据库。migration 95 只加表。需要同时重启 Web 和 Worker，浏览器再加载一次。确认要自动点赞时，把 `AI_CENTER_X_AUTO_LIKE=1` 写入环境，并在推荐记录打开自动点赞。确认要自动不感兴趣时，再把 `AI_CENTER_X_NOT_INTERESTED=1` 写入环境，并打开对应的页面开关。服务器仍须设置 `AI_CENTER_HARNESS_HOURLY_PROVIDER=google`。
