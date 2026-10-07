# 小时简报缺稿诊断

`information-not-ready`表示小时层没有找到满足来源版本、有效信息提示词及校验要求的信息节点，且没有匹配版本的明确准备失败原因。它不能区分任务尚未领取、批次处理中或旧稿不适用，不能直接当作JEV筛除或模型精选，也不能通过反复重跑小时层补出信息稿。

## 只读检查

先保留已有验收目录，输出到新的Instance私有目录：

```powershell
node scripts/inspect-tree-hour.mjs --hour-start <UTC整小时毫秒> --output .ai-data/hour-audit/<新的检查目录>
```

要对照某份保存的历史刊期，附加`--baseline <旧目录/result.json>`。窗口必须一致，禁止输出覆盖baseline文件。旧result不改写；新result读取当前正式头，readiness诊断对照baseline刊期，二者editionId可能不同。

脚本只读生产SQLite，在一个读事务中收集一致证据，不迁移、不排任务、不调用模型、不重启Worker。它增加：

- `readiness.md`：逐条待补、历史/检查时状态、吞吐、实际调度周期和解释。
- `readiness.json`：检查/出刊时间、editionId、每条来源版本/信息头/提示词/校验版本、全部相关准备Job和attempt、准备阶段错误及冷却、原始记录差异、模型阶段计时与调度快照。
- `readiness-items.jsonl`：逐来源分行，便于按sourceId查证。

原result的preparation也包含发布/尝试待补来源，不再只查已有信息稿的成功来源。

## 必须区分的时间与数量

出刊时的队列状态从保留的Job attempt开始/结束区间重建；无attempt且当时已入队归为queued。批次running只证明该篇属于在途批次，不能证明已轮到它。检查时ready不代表已经进入旧刊期；两者必须分别列出。

准备失败使用匹配来源版本的阶段记录，保留retryAt、queueMs和executionMs。Job completed不等于所有材料成功，需读prepared、pending、calls、cacheHits。`queue-timeout`是模型队列等待失败，不同于Job尚未领取；`execution-timeout`是得到模型执行机会后超时；`budget-deferred`是批次预算不足。

最近六小时吞吐按来源首次入队与首次信息节点生成计唯一来源，拆分子Job/重试不重复计新增；它不是原始采集量、JEV候选量或指定信息窗口的覆盖率。当前未结束小时另标partialHour。calls/cacheHits是任务汇总，不能凭cacheHits少就认定重做多；没有逐请求来源版本关联就保留未知。

原始窗口记录与刊期输入/待补清单按ID差集对照，附当前准入分数、隐藏/抓取状态；历史排除清单未冻结时，不能把当前原因冒称出刊时原因。准备阶段记录可能被后续重试覆盖，无法还原的历史状态写no-matching-evidence。

## 抓取与汇总是否抢时间

Scheduler只入队，Worker按Job类型限制并发，不是所有类型共用一个全局Job锁。社交抓取由每分钟轮询到期订阅驱动，各订阅有自身刷新周期；媒体和小时报有独立schedule。实际周期、enabled和next_run_at以诊断快照为准。

单篇信息准备和小时汇总使用同一个冻结Harness，其执行队列一次一个activeEntry，可能互相等待。对照tree-cache的executionTiming及失败原因；不能把模型队列等待直接归咎于抓取HTTP请求。先比较入队/完成速率和失败，再判断错峰是否足以解决。

诊断数据属于Instance，不提交真实标题、数据库、主机信息或运行日志。
