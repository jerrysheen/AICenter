# 2026-10-11 股民讨论日摘

独立于日报和小时报。不改 `generateDaily()`、小时浓缩或刊期发布。按当天持仓和一份可配置主题列表，从雪球个股讨论区拉帖子和评论，用 Gemini Flash Lite 写成 3 到 5 句总结。

## 数据流

1. 持仓来自 `holding_lots` 里未归档的全部批次。A 股（含 ETF）、港股通、B 股都算。用已有 Yahoo 别名换成雪球代码后按代码去重。换不出来的标的记入缺失，不假装没有持仓。
2. 主题默认是半导体、光通信、存储。每个主题有关键词和代表股票。可用 `AI_CENTER_INVESTOR_DIGEST_THEMES` 覆盖。代表股票拉讨论区时间线，关键词走雪球搜索，再按帖子 id、评论 id 去重，只留当天（默认北京时间 0 点到次日 0 点）。
3. 雪球沿用现有浏览器登录态。讨论区帖子是 `query/v1/symbol/search/status.json`，参数 `type=11`、`sort=time`、`count=20`。评论优先 `/statuses/v3/comments.json`，按 `max_id` / `next_max_id` 翻页，遇到 `-1` 或空页就停；旧的 `/statuses/comments.json` 只在 v3 请求失败时兜底一页。登录失效抛出明确状态 `login_required`。当天 0 帖写成「今天没人讨论」，不调模型，并排在有讨论的标的后面。
4. 转发长文（`retweeted_status` 或转发标记）和纯回复链（以「回复@」「//@」开头，或没有自己的内容）不计入热度，也不写入模型材料。评论只对每只股票 `reply_count` 最高的前 N 帖去拉，默认 15，环境变量 `AI_CENTER_INVESTOR_DIGEST_COMMENT_POSTS`。楼中楼不做。覆盖率写「评论拿到 X / 帖子标称 reply_count Y」和「评论只含一级、不全」。帖子到达页数上限时写「帖子可能未抓全（到达页数上限）」。
5. 每个拉成功且有帖子的标的或主题，调用现有 Gemini `generateContent` 适配，并经 `createUsageFetch` 记用量，阶段名 `investor-discussion`。提示词写死两条：只做总结，不写交易建议；传闻必须标「未证实」。热度用实际帖子数和评论数，不信模型自己数。代表链接必须来自已拉到的原帖。

## 存储、调度、接口

- migration 52 新增 `investor_discussion_digests`，一个工作区一天一行。覆盖率、缺失原因和各段总结都在这一行里。写入与 `investor.discussion.digest.saved.v1` 同事务。
- Worker 任务 `investor.discussion.digest`，调度键 `investor.discussion.daily`。默认每天北京时间 21:30。`AI_CENTER_INVESTOR_DIGEST=0` 关闭定时。
- `GET /api/v1/investor-discussion?date=YYYY-MM-DD` 读取。`POST /api/v1/investor-discussion` 只在本机开放，入队同一任务。默认简报（`brief-page.js`）和三层浓缩树（`information-tree.js`）的标签栏都增加「股民讨论」，模块是 `apps/web/public/investor-digest.js`。这个标签不写入简报的小时/日报偏好。

## 环境与生效

需要重启 Web 和 Worker。启动时会执行 migration 52，不重建数据库。

```text
AI_CENTER_INVESTOR_DIGEST=1
AI_CENTER_INVESTOR_DIGEST_AT=21:30
AI_CENTER_INVESTOR_DIGEST_TIMEZONE=Asia/Shanghai
AI_CENTER_INVESTOR_DIGEST_MODEL=gemini-3.1-flash-lite
AI_CENTER_INVESTOR_DIGEST_INTERVAL_MS=1200
AI_CENTER_INVESTOR_DIGEST_RETRIES=2
AI_CENTER_INVESTOR_DIGEST_MAX_PAGES=8
AI_CENTER_INVESTOR_DIGEST_MAX_COMMENT_PAGES=5
AI_CENTER_INVESTOR_DIGEST_COMMENT_POSTS=15
GEMINI_API_KEY=
```

雪球仍要采集浏览器已登录。模型默认 `gemini-3.1-flash-lite`，与仓库里现有的 Gemini 调用相同，不回退到 Grok。

## 验证

雪球和 Gemini 都用 mock。定向测试覆盖代码映射、去重、登录失败、429 重试、提示词约束、用量记录、覆盖率和 21:30 调度。全量 `npm test` 里与本改动无关的既有失败不在本次范围内。
