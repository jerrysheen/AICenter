# 2026-10-11 股民讨论日摘 WAF 与翻页

生产重跑 184 秒，28 个目标里 22 个成功。失败的 6 个都在后段连续请求，返回 200 和约 987 字节的混淆脚本，是阿里云 `acw_sc__v2` 挑战页，之前被记成 HTML，采集没有停。

## 修复

- 这种页面记为 `waf`。先等 20 到 40 秒，在同一个会话里重新打开 `https://xueqiu.com/hq`，让页面脚本写下 acw cookie，再重试当前请求。最多重试 2 次。仍然是挑战页就记为 `verification_required`，原因写「WAF 挑战」，后面的标的不再请求。
- 请求间隔默认 2.5 秒，抖动约 ±0.5 秒。`AI_CENTER_INVESTOR_DIGEST_INTERVAL_MS` 和 `AI_CENTER_INVESTOR_DIGEST_INTERVAL_JITTER_MS`。
- 翻页只在整页非置顶帖都早于当天窗口时停止。置顶帖（`mark=1` 或置顶标记）不计入热度，也不能单独把这一页判成已经翻过今天。南大光电这种第一页只有旧置顶、当天帖在后面的情况会继续翻。
- 每个标的单独占一次浏览器会话，标的之间可以插入其他抓取。会话锁最长持有 `AI_CENTER_BROWSER_LOCK_MS`，默认 15 分钟；超时放行排队任务并记 warn。

需要重启 Worker。没有新的 migration。
