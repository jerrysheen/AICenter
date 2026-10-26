# Bamboo 信息流准入不再默认每天停在 7000

## 原因

2026-10-20 至 10-26，信息流准入连续多天顶到本地 7000。到顶之后当天剩下的准入走本地兜底，打分停住。

这个 7000 写在 `resolveBambooDailyMax`。环境变量 `AI_CENTER_BAMBOO_DAILY_MAX` 没配时就用它。数字来自 2026-10-11 至 10-17、JEV 开着时的准入峰值 7011，取整到百位。Bamboo 没有这道日额度。供应商返回 429 时，原来的限流兜底仍在，和这道本地日上限是两件事。

小时报、问答质量和资料召回本来就不占这道计数。研究召回仍用自己的请求预算。

## 决定

`AI_CENTER_BAMBOO_DAILY_MAX` 未设置、空、`0`、`unlimited`、`none`、`off` 时，信息流准入不做本地日封顶。写错的值也不恢复 7000。要封顶必须写成正整数，例如 `12000`。正整数到顶后，当天其余准入仍走本地兜底。

计数仍写在 `data/bamboo-usage-YYYYMMDD.json`，按上海日，Web 和 Worker 共用，重启不清零。只计信息流准入。

`AI_CENTER_BAMBOO_DAILY_SPREAD=hourly` 只在设了正整数日上限时，把剩余额度按剩余小时均分。不封顶时不再另造一道小时墙。

用量页仍列最近 14 个上海日。不封顶时 `limit` 为 null，页面写「不限」。这次读取不另记一次。

不新增 migration。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。不要重建数据库。

## 部署

先看服务器 `.env`。如果有 `AI_CENTER_BAMBOO_DAILY_MAX=7000`，删掉这一行，或改成 `0`。没有这一行时，代码默认已经不封顶。

然后同时重启 Web 和 Worker。浏览器再加载一次，用量页才会显示「不限」。只重启 Worker 时，准入已经不再被 7000 挡住，用量页仍可能显示旧页面。

## 验证

`node --test test/bamboo-usage.test.js test/bamboo-startlux.test.js test/feed-filter.test.js`

计数已经是 7000 时，未设置上限或设成 `0` 仍会调用 Bamboo。显式 `7000` 或 `1` 仍在到顶后走本地兜底。设了正整数且 `hourly` 时，本小时份额用完仍走本地兜底。
