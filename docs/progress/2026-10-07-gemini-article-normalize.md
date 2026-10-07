# Gemini 信息层接入与流量控制

用户授权从隔离原型接入正式代码，并修复短时间集中请求、正常报告半点调度。保留所有既有未提交修改，接入前在线备份用户数据库（schema43），新增migration44而不改历史迁移；代码快照和实际证据在实例私有 `.ai-data/article-normalize-pilot/20261007-implementation/production-integration/`。

真实验证：Gemini通过同一Harness生成教程样本四字段成功，供应商记录2247总Token；第二篇明确返回429 RESOURCE_EXHAUSTED、GenerateRequestsPerDayPerProjectPerModel-FreeTier、额度500、RetryInfo 64908秒，不能解释为分钟突发。冷却保存后，同一待处理市场样本通过现有Elucid Grok成功（7602供应商记录Token），重放零新增请求。该fallback实际请求基于此前真实额度冷却，不假称重新请求了全部三个Key。此前Grok原型8请求，加本轮Google2/Grok1共11次模型请求；启动配置校验失败没有供应商请求。费用、cacheWrite及reasoning未知不补估值。

新增两条Key最初使用中文冒号，已按用户授权改成等号并支持GEMINI_API_KEY2/GEMINI_API_KEY3。项目关系尚待用户确认，默认共享项目桶；“三Key已识别”不等于三个独立项目或都通过了生成验证。

确定性验证覆盖：正常四字段和摘要投影、同版本缓存、原文保留、两入口跳过旧路径、配额持久化/重启、滚动小时/分钟/Token预留、未知项目共享/重复Key去重、Google转义RetryInfo、分钟延后不触发付费fallback、真实Harness fake客户端的quota→等待→Grok、独立项目Key接续、半点调度锚点与日报截止不变。正式检查和重载结果见下文。

正式仓库 `npm run check` 879/879通过，包含同期已有测试；在线备份与schema44前向迁移完成。原启动器安全重载确认Worker PID变更，267个暂缓queued任务已恢复；未强杀运行任务。实例已开启Gemini文章整理与显式Grok fallback。正式调度回读：小时下一次为北京时间14:30，日报为次日08:30，仍按08:00截止；两项schedule均enabled。旧队列和独立手动/其他页面翻译仍保留，不声称清空历史积压或这次验证覆盖所有Google Key。

首条正式信息准备已完成并按新Contract回读：中文标题「彭博：英特尔将继续参与马斯克的Terafab芯片制造计划」，Tag=semiconductor，摘要144字符，中文正文474字符；节点格式article-normalize-v1，详情有body而列表摘要投影不含body。生产ledger的tree-information请求为Elucid Grok succeeded，说明此前真实Google额度冷却已让正式流程进入同一Harness fallback。真实结果与回读检查见实例私有production-integration/first-live-article.json。未宣称所有历史文章已重做或全部刊期ready。

后续用户纠正：仅第一条 Key 已知额度耗尽，另外两条应继续尝试。此前未确认项目关系就共享供应商冷却，导致过早进入 Grok，这是实现错误。修正后未知项目仍共享保守分钟流量预算，但拒绝按实际 Key 指纹单独持久化；已确认同项目才共享供应商冷却。第一条真实日额度冷却保留并归属第一条 Key，另外两条不继承未经验证的耗尽状态；所有候选都冷却才允许显式 Grok fallback。全仓检查882/882通过（包括新增3项测试），真实 Harness fake 客户端验证了 Key1→Key2→Key3 成功且未调用 Grok。

13:00—14:00 新入库五篇回放按保存时间选样，非全部在该小时首次发布；覆盖订单、长篇技术教程、产业分析、政策短讯和工具推广。首次错误共享冷却的回放已中止：R1 经 Grok 成功、R2 经 Grok 超时、R3 在途取消，未将其作为 Gemini 五篇验收。材料原文和已有生产成果保留，实验结果隔离保存，实验与生产共用持久化流量准入。

修正已通过原启动器安全重载正式Worker，在途任务自然结束、250条暂缓队列恢复。已知第一条Key的日额度冷却保留，不再传染另外两条。真实连通性结果：Key2经同一Harness完成上述五篇（5个供应商请求），Key3独立最小材料验证成功（1个供应商请求、供应商记录314总Token）；不假称已获知剩余具体余额或三个项目归属。五篇缓存复跑0新增请求，原始body哈希均未变，详情有中文body、列表与小时投影无body，仅id/title/text/tagId。本轮未额外生成正式小时报，小时/日报仍按Grok路由。

内容质量复核未全通过：产业测试分析和政策短讯可读；订单正文添加原文没有的“预计”营收限定；长教程正文过度概括，漏掉执行步骤、指标定义和测试参数，不能当作合格长文洗练；工具推广把作者的自动加载/迭代说法写成确定行为，需要保留归属。因此四字段结构与路由验证通过不等于正文质量全面验收。逐篇原文、结果、判断与实际用量存于实例私有 `.ai-data/article-replay-20261007-13-key-pool/`。等待本地预算窗口未发出模型请求，未以Grok绕过限流。

用户查看五篇回放后明确确认接入正式流程。北京时间14:44再次只读核验：tree-v3与article-normalize均启用，当前正式Worker与安全重载记录一致、健康检查200、schema44；信息整理路由google/gemini-3.1-flash-lite，小时与日报均elucid-grok/grok-4.7。第一条Key在真实额度冷却，Key2/Key3未被连带冷却。自修正重载后正式库已记录32次Google信息整理成功、32个新中文正文节点，最新详情正文与列表摘要隔离回读通过。小时下一半点15:30、日报次日08:30，均enabled。未重复重启或重跑已完成文章；上述质量问题仍保留，用户确认上线不改写为语义全面通过。核验数据存于实例私有 `.ai-data/gemini-key-failover-20261007/production-active.json`。
