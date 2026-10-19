# 2026-10-19 Bamboo StartLux

分类可以改走 Bamboo Relay 上的 StartLux Decision（`startlux-decision-27b-autothink`）。默认仍是 TypeSafe。`AI_CENTER_JEV_ENABLED` 的默认值和现有兜底都不改。不新增 migration。最新 main 的 87 已是 `youtube_podcast_backfill`。用量不进数据库，写在 `data/bamboo-usage-YYYYMMDD.json`。空号仍有 63、79、80、82，下一个顺序号是 88。

需要同时重启 Web 和 Worker。不要部署。真实调用只在已经放好 `BAMBOO_API_KEY` 的服务器上跑。

## 开关

保持现在的 JEV 开关。要试用 Bamboo 时在服务器 `.env` 增加：

```text
AI_CENTER_CLASSIFICATION_PROVIDER=bamboo
BAMBOO_API_KEY=已放在服务器上的密钥
# 可选
# AI_CENTER_BAMBOO_ENDPOINT=https://api.bamboonode.dev/v1/decisions
# AI_CENTER_BAMBOO_MODEL=startlux-decision-27b-autothink
# AI_CENTER_BAMBOO_TIMEOUT_MS=30000
# AI_CENTER_BAMBOO_THINK_MODE=auto
# AI_CENTER_BAMBOO_DAILY_MAX=7000
# 默认先到先得。设成 hourly 后，每小时最多用当天剩余额度除以剩余小时数。
# AI_CENTER_BAMBOO_DAILY_SPREAD=hourly
# 质量刷新默认不调 Bamboo。要重评时才打开，并设单次上限。
# AI_CENTER_BAMBOO_REFRESH=1
# AI_CENTER_BAMBOO_REFRESH_MAX=200
```

密钥只读 `BAMBOO_API_KEY`。请求不带 `think_budget`。`think_mode` 默认 `auto`。

未设置 provider，或仍是 `typesafe` 时：JEV 关闭，信息流、小时报和问答质量检查继续走 2026-10-19 的兜底。设为 `bamboo` 之后：

- 信息流准入用现有 feed-value 题调用 Bamboo。技术故障（超时、网络、未配置、401、403、429、5xx）和当日调用达到上限仍走本地兜底，不改去调用 TypeSafe。422、坏正文和非法 noul 保持 REVIEW，不把缺分写成 0。
- 小时报选题对已分组材料调用 Bamboo 的 FOCUS noul，不再直接记 1。故障时仍用阅读分组命中。命中线仍是 0.5。
- 问答先验和证据门在没有显式设置 `AI_CENTER_JEV_PRIOR`、`AI_CENTER_JEV_EVIDENCE_GATE` 时用 shadow：只记录，不把提示注入主模型，也不按证据门丢掉检索结果。显式设成 `advisory` 或 `enforce` 才按原阈值拦截。复核仍只在回答写完后记分，不改回答。`AI_CENTER_JEV_DISABLED=1` 仍然全关。
- 质量刷新默认只复用已有 KEEP、DROP 和分数，没有结果的走本地兜底，不调用 Bamboo。只有 `AI_CENTER_BAMBOO_REFRESH=1` 才调用。单次上限 `AI_CENTER_BAMBOO_REFRESH_MAX` 默认 200，超出的计入 `skipped`，不改那些行。JEV 仍关闭且 provider 不是 bamboo 时，行为与原来一样。
- 资料召回在 provider 为 bamboo 时改走 noul 题，见 `progress/2026-10-19-bamboo-research-recall.md`。provider 仍是 typesafe 时继续只跟 JEV 开关。这些调用不占信息流每日 7000。

信息流的 0.60 和阅读小时的 0.5 都是旧阈值。Bamboo 的 noul 还没有按这些阈值重估。接口文档里的 0.5 只是演示。对照脚本会按 0.4、0.5、0.6、0.7 输出准确率和召回率，供之后重估。

## 调用量和价格

信息流准入对每条通过确定性预检的新材料调用一次。订阅同步每分钟检查到期订阅，默认间隔 30 分钟。X 关注、X 推荐、雪球关注、雪球精选各拉最多 50 条。雪球 7x24 和产业在线快讯不进分类。首页列表快照上限 12，收藏第一页 50，快讯列表 80，已存信息流列表 200，这些是展示上限，不是调用次数。重复条目在调用前跳过。若上面 4 个社交源每 30 分钟全是新条目，理论上限约 4 × 50 × 48 = 9,600 次/天。本环境没有生产库，实际新增条数没有测到。媒体和新入库的哔哩哔哩动态另计，每条一次。

`AI_CENTER_BAMBOO_DAILY_MAX` 默认 7000，只计信息流准入。数字来自 2026-10-11 到 10-17、JEV 开着时的准入请求峰值 7011（10-17），取整到百位。按上海日期计算，写到 Instance `data/bamboo-usage-YYYYMMDD.json`。`data/*` 已被忽略，所以这个文件不会把工作区弄脏，自动部署的 `git status --porcelain` 不会因为它放弃。Web 和 Worker 写同一个文件，用排他锁串起来。重启和自动部署都不清零。触达每日上限后，当天剩下的准入都走本地兜底，不再调用 Bamboo。小时报、问答质量和显式打开的质量刷新不占这个额度。锁超时、文件读不了，或 Windows 上覆盖用量文件遇到 EPERM、EBUSY 且重试仍失败时，不记成「已达每日上限」，日志只写「Bamboo 用量文件异常，走本地兜底」和错误类别，然后走本地兜底。

默认先到先得。`AI_CENTER_BAMBOO_DAILY_SPREAD=hourly` 仍是可选项，不默认开启。打开后，每个上海小时最多用「当天还剩的额度 ÷ 还剩的小时数」（含当前小时，向下取整）。这个小时用完就走本地兜底，下一个小时按当时的剩余额度再算。额度小于 24 时，前几个小时的份额可能是 0，次数留到后面的小时。最后一小时可以用掉当天还剩的全部。

价格：目前免费。用户已确认。响应里的 `input_tokens` 和 `output_tokens` 只记用量，不表示费用。

统计口径是 2026-10-11 到 10-17，JEV 开着时按上海日汇总。没有计入客户端重试、`jev-replay` 和质量刷新重评。

| 日期 | 信息流准入请求 | 小时报 FOCUS 已保存 |
| --- | --- | --- |
| 10-11 | 2664 | 547 |
| 10-12 | 3316 | 1509 |
| 10-13 | 3116 | 1553 |
| 10-14 | 2714 | 1191 |
| 10-15 | 1990 | 898 |
| 10-16 | 4739 | 1336 |
| 10-17 | 7011 | 1269 |

信息流准入峰值 7011（10-17）。小时报 FOCUS 峰值约 1550（10-13 为 1553），不受每日上限控制，目前免费。问答质量这几天接近 0：10-12 各 1 次，10-14 先验和复核各 5 次、证据门 2 次，其余日期没有。

## noul

一篇材料放在同一个 `state`，每个题一个 noul。可以多题同时过线，也可以全部不过。不取最大值当主标签。

`criteria.true` / `criteria.false` 按 StartLux 文档原样随 noul 送出，不并进 instructions。2026-10-19 的真实冒烟没有带 criteria，所以还不能说和 JEV 语义相同。离线样例只比较两条请求体。

非法 noul（缺失、字符串、布尔、越界）是契约错误，不默认 0。`choice` 可以是 null。`none_probability` 只作未校准警报，不因为某个选项概率最高就强选。`score` 落在 `0 .. n-1`。

## 服务器对照

仓库里没有真实密钥，也没有跑过 50 条真实新闻。在服务器上：

```text
node --env-file=.env scripts/bamboo-news-compare.mjs --limit 50 --out data/bamboo-news-compare.json
```

要同时打 TypeSafe，并且当时 JEV 开关是开的，再加 `--jev`。人工标签用 `--labels labels.json`，格式是 `{ "内容条目id": ["a_share","optical"] }`。没有标签的行留空，不进 P/R/F1。没有任何正例的标签写明不算分。

`config/bamboo-label-fixtures.json` 是五条合成难例（创业板光通信、沪市主板光纤、创业公司、光伏、港股光通信）。它们不计入那 50 条。单行命中用 `--threshold`，默认 0.5。另外按 `--thresholds`（默认 `0.4,0.5,0.6,0.7`）输出每个标签的准确率、召回率、精确率和 F1，写入 JSON 的 `thresholdSweep`。准确率是 (tp + tn) / 已标条数。

错误信息只保留 HTTP 状态码和错误类别，例如 `Bamboo 调用失败（422 unprocessable）`。网络错误只记 `error.cause.code`，例如 `Bamboo 网络失败（ECONNRESET）`。上游正文不进入 Error.message，也不进入日志。
