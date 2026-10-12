# 2026-10-12 阅读分类批量离线评测

小时报里的阅读分类仍是一条材料一次调用。这一轮只加离线脚本，看 Gemini 把多条放进同一次调用时，主类还能不能和单条基线对齐。生产分类、小时任务、提示词和数据库写入都不改。不需要重启 Web 或 Worker。

## 决定

基线优先用已经落在信息节点上的 `readingClassification`。节点没有可用结果时，再读 `daily_analysis_stages` 里 `report_date=reading-class`、输入哈希为当前 `READING_CLASS_VERSION` 的完成记录。可用结果只认 `classified` 和 `out-of-scope`，和小时分类缓存的采纳条件相同。`pending` 会再走单条调用。

没有可用基线，或显式指定 `--baseline reclassify` 时，用线上同一段 `READING_CLASS_INSTRUCTION` 把该条单独发给 Gemini。`--baseline stored` 只保留已有分类，不再单条补标。

批量调用使用同一段类别和判断规则。输出改成 `{"items":[{"id":"..."}]}`，`id` 必须等于输入的信息节点 id。主类和细类的允许取值与线上单条解析相同。温度 0，默认输出上限 16384，避免 30 条 JSON 被生产小时调用的 4096 上限截断。这个上限只在评测脚本里。

对照按批大小汇总。一致率的分母是进入对照的样本数，分子是该 id 只出现一次、取值合法、且 `primaryDirection` 与基线相同的条数。各类一致率按基线主类分母计算。缺失、重复、未知 id、非法标签、解析失败、请求失败、截断、延迟和调用次数分列。解析失败和请求失败另计，不记入缺失 id。

## 命令

在仓库根目录执行。`node --env-file=.env` 会读仓库 `.env`；进程里已经设置的同名变量优先。脚本不打印密钥。

```powershell
node --env-file=.env scripts/eval-classify-batching.mjs --sample 200 --batches 10,20,30
```

默认基线是 `auto`：最近 200 条里，已有分类直接用，缺的再单条补。200 条都已有分类时，批量大约 37 次（20 + 10 + 7）。200 条都要单条补基线时，再加 200 次。`--baseline stored` 会多看一些最近条目，最多 2000 条，从中取已有分类。

没有数据库时，用样本文件：

```powershell
node scripts/eval-classify-batching.mjs --input .\data\experiments\classify-batching\sample.json --sample 200 --batches 10,20,30
```

`--dry-run` 只打印预计调用次数，不请求模型。报告写到 `data/experiments/classify-batching/<上海日期>/report.md`，同目录的 `sample.json` 是这次对照用的材料。同一天再跑会覆盖这两份文件。可以用 `--output` 指定报告路径。

## 环境

```text
AI_CENTER_CLASSIFY_BATCH_MODEL=
AI_CENTER_HARNESS_HOURLY_MODEL=gemini-3.1-flash-lite
AI_CENTER_CLASSIFY_BATCH_KEY_ENV=
AI_CENTER_HARNESS_HOURLY_KEY_ENV=
AI_CENTER_CLASSIFY_BATCH_TIMEOUT_MS=120000
AI_CENTER_CLASSIFY_BATCH_MAX_OUTPUT_TOKENS=16384
AI_CENTER_CLASSIFY_BATCH_PAUSE_MS=0
AI_CENTER_CLASSIFY_BATCH_SCHEMA=1
GEMINI_API_KEY=
```

模型缺省先看 `AI_CENTER_CLASSIFY_BATCH_MODEL`，再看小时模型，否则是 `gemini-3.1-flash-lite`。密钥缺省先看评测变量，再看小时密钥变量，再按 `AI_CENTER_GEMINI_KEY_ENVS` 或 `GEMINI_API_KEY` 取第一把已配置的。`AI_CENTER_CLASSIFY_BATCH_SCHEMA=0` 时仍要求 JSON，但不附带响应 schema。

## 验证

`node --test test/reading-classify-batch-eval.test.js` 覆盖 id 对齐、各类一致率、解析失败不计入缺失、提示词类别、基线读取、批量循环和 Gemini 请求体。没有生产库，也没有真实模型调用。
