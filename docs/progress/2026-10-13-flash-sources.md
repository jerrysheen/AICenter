# 2026-10-13 快讯来源不进小时链路

## 决定

雪球 7x24 这类快讯本身已经是短讯。它们继续入库，但不再做 JEV、信息准备、阅读分类和阅读 JEV，也不进小时候选。信息流增加「快讯」页签，按时间用现有新闻列表展示原文，点击打开原链接。不调用模型。

名单放在 `config/flash-sources.json`。媒体源可以把 `flash` 设为 `true`，会同时认 `sourceKey` 和 `media:sourceKey`。`AI_CENTER_FLASH_SOURCES` 非空时整表替换文件和媒体标记，分隔符可以是逗号、中文逗号或空白。文件缺失且环境变量为空时，内建名单只有雪球 7x24。`livenews` / `7x24` 只在名单仍含 `xueqiu:home:livenews` 时才算快讯。

## 实测

产业在线快讯列表来自 `POST http://weixin.chinaiol.com/News/PageData`（`navBarTitle=快讯`，`pageSize=30`）。去空白后 30 条：标题平均 / 中位 22 字，正文平均 158、中位 145、最长 279、最短 48。页面脚本 `getFlashHtml` 把标题和 Content 当作整条快讯。80 条从「4小时前」到「15天前」，大约每天 5 条。这是短讯，列入名单，id 为 `chinaiol:flash`。

同一站点的「观察」15 条标题平均 21 字，列表接口正文为空，是文章 / 报告栏目，不把整个站点标成快讯。

媒体目录里抽过的源都不是已经浓缩的快讯，没有改 `flash`：

| 来源 | 样本 | 结果 |
|---|---|---|
| Techmeme | 15 | 标题平均 179，描述平均 322，且 `enabled` 为 false |
| The Elec | RSS | 描述大约 300 字 |
| The Decoder | RSS | 描述平均 444 |
| Bloomberg | 20 | 描述平均 195、中位 184 |
| BBC | 25 | 描述平均 101、中位 101，正文走 `contentAccess: body` |
| Digitimes、MoneyDJ、TrendForce、早报世界 | RSS | XML 没解析出来 |
| Reuters、AP | HTTP | 401、403 |
| Yahoo Economy | RSS | 解析失败 |

MoneyDJ 是首页实时列表，没有正文样本，不标。雪球 7x24 公开接口 `https://xueqiu.com/statuses/livenews/list.json` 这次返回 HTTP 400，没有新的当日条数。

产业在线不在 41 个媒体源里。这次只把 id 写进名单，没有新增抓取。库里还没有 `chinaiol:flash` 的条目时，快讯页不会出现它。

## 省下的调用

一条快讯如果走完整小时链路，大约是 1 次入库 JEV、1 次信息准备，再加阅读分类。分类默认 10 条一批，分摊约 0.1 次，合计约 2.1 次。被分进阅读题的条目还会再有一次阅读 JEV，那时接近 3 次。译文和打标任务也不会为这些 id 排队，那部分没有算进 2.1。

2026-10-05 的质量样本里，近期社媒池有雪球 7x24 42 条，不是按自然日计的。按大约每天一轮估算，约 42 × 2.1 ≈ 88 次/天；若把阅读 JEV 算进去，大约 130 次/天。2026-10-07 一次刷新只新增 3 条雪球快讯，实际节省随当天新条数变化。产业在线大约 5 条/天 × 2.1 ≈ 11 次/天，只有以后真的按 `chinaiol:flash` 入库才发生。现在没有抓取，这部分是 0。

## 重启

不新增 migration。已用到 62（`model_usage_http_status`），下一号仍是 63。不要重建数据库。

需要同时重启 Web 和 Worker。Web 提供「快讯」页签和 `GET /api/v1/feed/flash`。Worker 才停止把这些来源送进 JEV 和小时树。静态脚本仍是 `app.js`、`mock.js`、`news-list.js`，都已带 `?v=` 并在静态白名单里，没有新的公共 JS 文件。
