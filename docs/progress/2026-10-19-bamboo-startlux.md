# 2026-10-19 Bamboo StartLux

分类可以改走 Bamboo Relay 上的 StartLux Decision（`startlux-decision-27b-autothink`）。默认仍是 TypeSafe。`AI_CENTER_JEV_ENABLED` 的默认值和现有兜底都不改。不新增 migration，下一个空闲编号仍是 87。空号仍有 63、79、80、82。

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
```

密钥只读 `BAMBOO_API_KEY`。请求不带 `think_budget`。`think_mode` 默认 `auto`。

未设置 provider，或仍是 `typesafe` 时：JEV 关闭，信息流、小时报和问答质量检查继续走 2026-10-19 的兜底。设为 `bamboo` 之后：

- 信息流准入用现有 feed-value 题调用 Bamboo。技术故障（超时、网络、未配置、401、403、429、5xx）仍走本地兜底，不改去调用 TypeSafe。422、坏正文和非法 noul 保持 REVIEW，不把缺分写成 0。
- 小时报选题对已分组材料调用 Bamboo 的 FOCUS noul，不再直接记 1。故障时仍用阅读分组命中。命中线仍是 0.5。
- 问答先验、复核和证据门按原来的子开关恢复，客户端换成 Bamboo。`AI_CENTER_JEV_DISABLED=1` 仍然全关。
- 质量刷新在 provider 为 bamboo 时会调用 Bamboo。JEV 仍关闭且 provider 不是 bamboo 时，已有 KEEP、DROP 和分数保持不动。
- 资料召回的标签和相关性判断仍只跟 JEV 开关，这次不切。

信息流的 0.60 和阅读小时的 0.5 都是旧阈值。Bamboo 的 noul 还没有按这些阈值重估。接口文档里的 0.5 只是演示。

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

`config/bamboo-label-fixtures.json` 是五条合成难例（创业板光通信、沪市主板光纤、创业公司、光伏、港股光通信）。它们不计入那 50 条。阈值用 `--threshold`，默认 0.5，只用于这张对照表。
