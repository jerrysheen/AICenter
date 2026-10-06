# Feed 保存价值二选三生产接入

用户明确要求：保存价值、具体程度、信息充分程度至少两项严格大于0.60；直接 enforce，整理新闻并给新报告。

## 完成

- 新规则 `two-of-three-0.60`；0.60本身不通过，三种组合均允许，包括低保存价值但另外两项通过。广告不否决；不读取兴趣/Tag。采集关键缺失、缺上下文>=0.60、技术失败保持 REVIEW；不通过且续帖未确认也 REVIEW。
- 当前 Instance `.env`明确配置 enforce/V3/新规则。新安装默认仍shadow。旧校准productionQualified=false不改写，不把用户策略冒称独立校准验收。
- 社交入口及媒体索引/正文共用 gate。媒体先保留原索引/正文快照与Capture；DROP不进入新ContentItem或可读池，正文升级重新评分可解除排除。REVIEW继续留存待补。
- Repository可读查询与日报材料查询排除已应用enforce DROP；原文、ContentItem、译文、Tag、阅读/隐藏状态保留。无Tag仍可读，Tag仍由现有AI后处理。
- 历史重分类由Domain Review Service对照当前输入完全相同才复用分数，经Repository保存Capture并发outbox。不直接SQL更新，不改migration。规则哈希与问题哈希分开，评分问题未变则不重复调用JEV。
- 原V3校准路径与结果文件冻结；新报告在Host runtime `feed-quality-audit/2026-10-05-two-of-three-0.60/`。报告HTML约226KB，只嵌选中摘录，不加载全量正文；完整分类结果另存JSON。

## 本轮结果

同一批2632条，复用同模型jev-1.13.0、同五问、同输入的V3评分，无新JEV请求：

|规则|KEEP|DROP|REVIEW|
|---|---:|---:|---:|
|原V3单主判断校准|1737|114|781|
|至少两项严格>0.60|1370|420|842|

原KEEP中1361仍KEEP，248转DROP，128转REVIEW；原REVIEW中9转KEEP、58转DROP，其余714仍REVIEW；原114DROP不变。
115条AI辅助SUBSTANTIVE参考材料现为101 KEEP/2 DROP/12 REVIEW，不等于人工真值、不是独立留出验收。原保留的实质信息参考样本还有3条不再KEEP，已列入HTML供查看。

生产历史回放应用2592条：1370 KEEP/420 DROP/802 REVIEW；40条当前输入不一致跳过，未拿旧分数覆盖新文本。
“We are having Santa rally this year.”三项为0.48/0.40/0.48，缺上下文0.51，现为DROP。实际Capture记录filterApplied=true，原文与ContentItem仍在，已退出可读池。

## 验证与运行

- 两项组合、严格边界、广告不否决、采集/技术保护、规则改变不混淆评分缓存。
- 真实临时SQLite验证历史原文保留、可读池排除、未实际应用的DROP不能被排除、输入变化拒绝复用。
- 媒体临时SQLite验证索引DROP留原记录并退出媒体/日报材料，正文新评分KEEP后恢复可读与ContentItem。
- 全仓`npm run check`通过，719/719测试成功。此前5个旧测试因依赖“无Tag不可读”失败，已改成用户要求；另隔离API缓存测试的真实Instance JEV配置，避免测试读取生产密钥发真实请求。
- 重启时无running/queued任务。Web/Worker已重启，桌面Runtime接口确认 `{mode:enforce,version:feed-value-v3.0,rule:two-of-three-0.60}`，健康检查通过，缓存信息流正常。

此报告为新筛选/新闻整理报告，未重写应用中的AI日报成稿。现有日报下次刷新会消费已过滤的材料。
