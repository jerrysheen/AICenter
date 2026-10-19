# 2026-10-19 资料召回改走 Bamboo noul

`AI_CENTER_CLASSIFICATION_PROVIDER=bamboo` 且 `AI_CENTER_RESEARCH_RECALL=on` 时，研究标签和相关性改用 Bamboo 的 `state + questions`。每题返回 0 到 1 的 noul。provider 仍是 `typesafe` 时，题面保持原来的自由文本 JSON，不改缓存版本。不新增 migration。需要同时重启 Web 和 Worker。

密钥只读 `BAMBOO_API_KEY`。日志仍不记录请求原文。

## 现在要落库的字段

研究判断行只存两类结果：

- 标签：某个标签是否命中，布尔值。未知标签 id 记入 `discarded`，不进材料包。
- 相关性：`direct`、`background`、`irrelevant`、`insufficient` 四选一。缺分或无法解析记 `invalid-verdict`。

没有理由字段。旧 JSON 题面也写明不要写报告。自由文本理由不能映射成 noul，这次去掉，不另做规则生成。

用量仍记 `requests`、`inputTokens`、`outputTokens` 和 `model`。Bamboo 按实际 HTTP 次数写入 `requests`。一次判断里没有发出请求时记 0，不按 1 次计。

## 题面

一条材料一次 `evaluate`。标签和相关性仍是两次判断，跟现有服务的两段调用一致。

标签，每个候选标签一题，题 id 用标签 id：

- 题面：这条材料是否符合研究标签「名称」。只根据材料本身判断，不写理由，不判断涨跌。
- `criteria.true`：定义和计入边界。
- `criteria.false`：排除边界。
- 分数 `>= 0.60` 打上这个标签。`0.599` 不算命中。

相关性三题：

| 题 id | 问什么 | 成立 | 不成立 |
| --- | --- | --- | --- |
| `direct_answer` | 是否直接回答研究问题 | 写出问题所问的变化、条件或事实 | 没有回答，或只提到相关名字 |
| `related_context` | 是否提供相关但不是直接答案的背景或旁证 | 有背景、上下文或旁证，仍不能当成直接回答 | 无关，或它本身就是直接回答 |
| `verifiable_fact` | 是否有可核对的事实或数据 | 有可核对的事件、数字、主体或明确条件 | 只有口号、情绪、传闻或无法核对的判断 |

相关性规则，按这个顺序：

1. `direct_answer >= 0.60` 且 `verifiable_fact >= 0.50` → `direct`
2. 否则 `related_context >= 0.60`，或 `direct_answer >= 0.40` → `background`
3. 否则标题、摘要和正文去掉空白后不足 40 字 → `insufficient`
4. 否则 → `irrelevant`
5. 三题里缺任一分数，或分数不在 0 到 1 → 空结果，服务记 `invalid-verdict`

`state` 只放截断到 800 字的目标和材料，不放整份标签表。

## 预筛

当前 `config/research/ai-compute.json` 是 8 个标签，加上 `optical-export.json` 后是 9 个。都不超过 12，全部出题，不靠关键词挡掉语义命中。

候选标签超过 12 个时，先用关键词和别名预筛，只保留有命中的标签，按命中次数和 id 取前 12。其余直接记未命中，不再调用。一个关键词都没有时，这次标签判断不调用。

## 调用量

不计入信息流准入的每日 7000。研究召回是显式任务，默认预算仍是 400 次请求、120 秒。质量刷新和小时报选题也不占这 7000。

每条可用材料、每一轮：有标签时 1 次标签调用，再加 1 次相关性调用。摘要判成 `insufficient` 且有正文时，正文轮再加同样的一对。

按现有目录、摘要轮算：200 条材料是 400 次，刚好用满默认预算。若一成材料要补正文，大约再加 40 次。两次用满预算的手工报告大约 800 次，仍不进信息流计数。2026-10-08 的隔离快照大约 200 条信息节点，量级相同。

缓存版本是 `research-tag-noul-v1` 和 `research-relevance-noul-v1`。TypeSafe 仍是 `research-tag-v1` 和 `research-relevance-v1`。同一模型 id 不会复用另一边的判断行。

## 和 JEV 的对照

没有可算的一致率。`progress/2026-10-08-research-recall-v1.md` 写明真实 JEV 未执行，仓库里也没有那份 100 条分层对照。隔离脚本的关键词模拟不是模型结果。因此这次没有拿 Bamboo 分数去对历史 JEV 标签或相关性。
