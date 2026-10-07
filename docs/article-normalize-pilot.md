# 信息层文章整理隔离原型

后续状态：用户已授权正式接入，现行设计见 `gemini-article-normalize.md`，下文保留隔离阶段记录。

2026-10-07：用户本轮要求覆盖旧信息层短稿/独立全文翻译/打标要求。显式注入 articleStrategy 和 articleNormalizePort；默认生产不启用。当前有效修改的隔离副本为开发及验收工作区，不修改生产源码。

模型一次返回 title/tagId/summary/body。summary 在唯一写入点映射为节点 text；body 保留段落，同一不可变节点增加 formatVersion=article-normalize-v1。旧节点仍可读、不复制 text 冒充 body。JSON 存储已支持新增字段，不需新 SQL migration；现有 migration 不改写。

文章执行沿用封闭 Harness，独立 article-normalize 允许任务，现有 Elucid 模型 low/6144 输出预算（4096 可显式选择），retryPolicy=none。模型/协议/Skill/实际执行预算进入缓存。无外部工具或 Ask 历史。最长完整请求100000字节；超预算待处理，不沿用逐块短摘要扩正文。

媒体与Feed显式注入同一 prepareInformation Port 即替换旧后处理，不排树第二遍或小时补编。常规采集和入池保持原规则。实验直接读已保存允许材料，只写隔离 Repository；不创建正式 Job。列表排除 body；小时投影只选 id/title/text/tagId，日报结构保持。
