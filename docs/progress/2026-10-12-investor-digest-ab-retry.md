# 2026-10-12 股民讨论日摘离线 A/B 拆批重试

线上日摘、Worker 任务和日摘页都不改。只改离线实验。脚本仍然只读数据库，不写日摘表，没有 migration。不需要重启 Web 或 Worker。

## 上一轮结果

同一份材料是 295 帖、227 条评论，合计 522 条。A、B 各调用 22 次。未标注 A 47 条、B 75 条。B 整批丢掉 3 批，都是小标的。报告里输入 token 全是 0。方向判断先修 B。

## 整批丢失

默认每批 25 条时，522 条第一遍是 21 次。实际 22 次，整轮只多了 1 次。B 未标注 75 条正好是 3 批。解析失败或输出被截断会按当时的退避再打同一批，3 批至少再加 3 次，调用数不会停在 22。所以这 3 批更像返回了能解析的 JSON，但 id 对不上，旧逻辑把缺失 id 标成未标注后不再重试。小标的整批都落在这 3 批里，看起来就像整批丢失。

这次补了两层：

- id 完全一致优先。否则只在本批里做唯一后缀对齐，例如模型回了 `9`、本批只有一个 id 以 `:9` 结尾。`post:A:9` 和 `comment:A:9` 同时存在时不对齐。
- 解析失败，或返回条数不齐，就把缺失条目对半拆开再打，最小到 1 条。拆批次数计入调用上限。A、B 同一套。HTTP、超时、429、5xx 仍先对同一批退避重试，再拆。输出 `finishReason=MAX_TOKENS` 记为「输出被截断」，有正文时缺的条目继续拆。

输出上限从 8192 调到 16384。Gemma 也带 `responseMimeType=application/json`。Gemini 本来就有。

## 输入 token

实验自己读 `usageMetadata.promptTokenCount`。Gemini 经常不回 `cachedContentTokenCount`，共享用量助手会因此丢掉输入 token，报告就停在初始的 0。共享助手不改。

## 聚合和报告

看多或看空的已标注条数少于 5 时，情绪是「数据不足」。占比和净分留空，不显示「平淡」或 100%。门槛是常量 `MIN_DIRECTIONAL_LABELS`。A、B 都用。没有帖子的标的仍是「今天没人讨论」。

报告增加按方向一致率，中性和无关都算无方向。每个方案写覆盖率（已标注 / 总条数），并列出拆批重试次数。`--only A` 或 `--only B` 只跑一边。

## 调用估算

522 条。A 仍默认每批 25，第一遍 21 次，上限 40。B 默认每批 12，第一遍 44 次，上限 80。两边一起第一遍 65 次，低于 flash-lite 单 key 每天 500 次。B 的上限给拆批留了余量。每条都拆到 1 仍可能超过 80，超出的记覆盖缺口。

`AI_CENTER_INVESTOR_DIGEST_AB_BATCH` 只影响 A。B 只用 `AI_CENTER_INVESTOR_DIGEST_AB_BATCH_B`，避免服务器上残留的 `BATCH=25` 把 B 又打回 25。

## 服务器重跑

在仓库根目录用 Windows PowerShell。脚本会读现有 `.env`。用上一轮已经抓好的 `materials.json`，只跑 B。

```powershell
node .\scripts\experiments\investor-digest-ab.mjs --only B --input .\data\experiments\investor-digest-ab\2026-10-12\materials.json
```

默认就是 B 每批 12、上限 80。要写明的话：

```powershell
$env:AI_CENTER_INVESTOR_DIGEST_AB_BATCH_B = '12'
$env:AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_B = '80'
```

报告仍写到 `data/experiments/investor-digest-ab/2026-10-12/report.md`，会覆盖上一份。不重新抓取。

## 验证

`node --test test/investor-digest-ab.test.js` 16 项通过。`npm run syntax` 通过。没有生产库，也没有真实模型调用。
