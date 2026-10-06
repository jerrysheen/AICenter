# 三项均 >=0.60 生产接入

用户后续明确修改二选三：保存价值、具体程度、信息充分程度三个都要0.6才入库，其余不要。

现行规则 `all-three-0.60`，三项全部 >=0.60（恰好0.60通过），沿用原五问、模型与输入边界。广告不否决，主题与Tag不作为门槛。

enforce仅KEEP新建ContentItem并进入新闻可读池；DROP不收，REVIEW（关键缺失、未确认续帖、接口失败、无有效分数）只存原始Capture captured待補。不再以技术失败为理由放行内容。媒体原始索引/正文快照继续保留，已拦截媒体不进入翻译/Tag后处理；补全正文后可重新评分。历史原文和ContentItem保存，但已拦截内容退出可读查询与日报材料查询，不改用户阅读/隐藏状态，不删库、不加migration。

同一批2632条相同五问评分重算：1069 KEEP /579 DROP /984 REVIEW，只有1069可读。旧二选三1370/420/842报告保留，不覆盖。本轮无重新请求JEV，完整新产物位于Host runtime `feed-quality-audit/2026-10-05-all-three-0.60/`。

历史应用2632条；2592条当前输入完全一致才复用原评分，40条输入改变保存当前原始采集并标记待重新评分，filterScores=null，未把旧评分移植到新输入。实际入池1069、其余隔离。原模型与评分问题哈希未变；新规则有独立ruleHash。

新增真实临时SQLite回归：三项0.60均通过，任意一项0.599拒绝；完整通过项才有ContentItem，低分/采集截断/接口失败均留Capture而不建内容；历史REVIEW实际退出可读池，输入改变不能复用分数。更新原默认配置断言，旧二选三兼容仍可回放。

全仓 `npm run check` 722/722通过。Bilibili API缓存测试显式注入feedFilter:null，防止它读取生产Instance配置发真实JEV请求；入库判定由独立真实SQLite回归覆盖。当前Web/Worker已重启，桌面Runtime确认mode=enforce、rule=all-three-0.60，健康检查通过。实际历史REVIEW样本验证filterApplied=true、已退出可读池、原文仍保留。
