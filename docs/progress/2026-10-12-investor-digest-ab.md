# 2026-10-12 股民讨论日摘离线 A/B

线上日摘、Worker 任务和日摘页都不改。这一轮只做离线对照，脚本只读数据库，不写日摘表，也没有 migration。不需要重启 Web 或 Worker。

## 决定

10/12 生产数据是 28 个目标、12 个有讨论、帖子 207、评论 175。现有 `investor_discussion_digests` 只存总结和覆盖率，没有原始帖子和评论，所以不能直接重跑分析。导出脚本先只读检查；没有原文时必须重新抓取，抓取结果只写成 JSON。

两个方案吃同一批材料、同一个模型：

- 方案 A：参考阅读关注的固定是非题。每条问是否看多、是否看空、有没有业绩/估值/订单/政策依据、是不是传闻、是不是纯情绪宣泄、有没有说自己买了或卖了。立场在本地按这些是非题归成看多、看空、中性、无关。不调用 TypeSafe。
- 方案 B：逐条结构化标签。stance、strength、reasonType、hasEvidence、unverifiedRumor、claim。缺 id 或字段非法的条目算未标注，不让整批失败。整批无法解析就退避重试，最终失败记入覆盖缺口。

帖子和评论都打标签。聚合在本地完成：有点赞数就用点赞数，否则用评论数，权重是 `1 + log1p(互动数)`。看多占比不低于 0.5 且比看空高出不少于 0.15 记为偏多，看空同理；两边都不低于 0.25 记为分歧；其余记为平淡。占比只在看多、看空、中性里计算。报告用种子 20261012 抽最多 40 条帖子对照，不写结论。

模型用 `AI_CENTER_INVESTOR_DIGEST_AB_MODEL`，缺省再看 `AI_CENTER_INVESTOR_DIGEST_MODEL`，否则是 `gemini-3.1-flash-lite`。换成 `gemma-4-26b-a4b-it` 时走现有 Gemma 流式调用（`streamGenerateContent`、`thinkingLevel: minimal`）。输出上限是 8192，避免一批 25 条 JSON 被截断。不写翻译配额表。

## 10/12 调用估算

207 帖 + 175 评论 = 382 条。默认每批 25 条，每个方案 16 次，两边合计 32 次。重试算进各自上限，默认各 40 次，最坏 80 次，低于 flash-lite 单 key 每天 500 次。小时报仍在用同一 key，建议先把上限留在 40，不要放到 500。

## 服务器命令

在仓库根目录用 Windows PowerShell。脚本会读现有 `.env`，进程里已经设置的同名变量优先。不打印密钥。

```powershell
node .\scripts\experiments\export-investor-discussion.mjs --date 2026-10-12
node .\scripts\experiments\export-investor-discussion.mjs --date 2026-10-12 --fetch
$env:AI_CENTER_INVESTOR_DIGEST_AB_MODEL = 'gemini-3.1-flash-lite'
$env:AI_CENTER_INVESTOR_DIGEST_AB_BATCH = '25'
$env:AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_A = '40'
$env:AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_B = '40'
node .\scripts\experiments\investor-digest-ab.mjs --input .\data\experiments\investor-digest-ab\2026-10-12\materials.json
```

第一条会说明 10/12 没有原文。第二条用现有雪球采集重抓，采集浏览器需要已登录。第三条跑 A/B。

报告写到 `data/experiments/investor-digest-ab/2026-10-12/report.md`。材料 JSON 在同目录的 `materials.json`。

换成 Gemma：

```powershell
$env:AI_CENTER_INVESTOR_DIGEST_AB_MODEL = 'gemma-4-26b-a4b-it'
```

## 环境

```text
AI_CENTER_INVESTOR_DIGEST_AB_MODEL=gemini-3.1-flash-lite
AI_CENTER_INVESTOR_DIGEST_AB_BATCH=25
AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_A=40
AI_CENTER_INVESTOR_DIGEST_AB_MAX_CALLS_B=40
AI_CENTER_INVESTOR_DIGEST_AB_RETRIES=2
AI_CENTER_INVESTOR_DIGEST_AB_INCLUDE_COMMENTS=1
AI_CENTER_INVESTOR_DIGEST_AB_KEY_ENV=
AI_CENTER_INVESTOR_DIGEST_AB_TIMEOUT_MS=120000
GEMINI_API_KEY=
```

`AI_CENTER_INVESTOR_DIGEST_AB_KEY_ENV` 为空时，Gemini 用 `GEMINI_API_KEY`，Gemma 用现有翻译密钥槽的第一把。重抓还沿用日摘的抓取间隔、页数和主题变量。

## 验证

合成小样本加 mock 模型跑通解析、加权、规则标签、重试、调用上限和报告。没有生产库，也没有真实模型调用。
