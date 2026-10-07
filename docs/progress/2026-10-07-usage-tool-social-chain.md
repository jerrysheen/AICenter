# 用量查询工具与社媒信息准备入口

用户要求将Token工具接入现有Harness问答，并让社媒按新闻相同策略进入小时报。保留现有未提交修改，不更换Runtime、供应商或入库JEV规则。

## 根因及修复

原用量账本有旁路记录和desktop页面/API，但没有模型可见工具。新增`model.usage.get`，由既有ToolRegistry/Gateway调用Domain Service和Repository的SQL汇总；按workspace、时间、Job、阶段过滤，仅累加request，状态投影中断Job，failed attempts保留；每桶reported和unknownRequests分开，turn不重复收费。供应商缓存读取不是应用缓存次数，实际扣款未知。聚合不返回模型/供应商、会话日志、密钥或任务正文；原明细接口仍限desktop。树封闭任务仍无工具。Ask进度提供工具中文标签。

直接`feed.x.sync`/`feed.xueqiu.sync`原来经Feed Service保存后直接返回；只在订阅/旧enrich Handler显式排队准备。新增Feed Service轻量onContentReady Port，在保存成功后、翻译/标签之前通知既有注册信息准备任务；Worker与Web Composition Root注入该Port。直接刷新和订阅刷新均覆盖，队列按已有来源ID去重，准备仍走原缓存/租约。没有另加社媒Agent、第二篇节点或新Runtime。

实际诊断确认本轮保存X材料已有KEEP记录而信息头为空；小时报中的雪球新闻已经存在，不能说所有社媒都未接入。X正文的来源角色和作者归属沿用已有材料Port/Skill。材料按原发布时间分期，晚采集旧帖不移到当前小时。仅定向补本窗允许材料，不全量加工新抓到的多天旧帖。

## 验证与生产边界

新增`test/usage-and-social-tools.test.js`：真实SQLite汇总排除turn/重放重复、统计失败与未知、时间/工作区过滤；真实Gateway用函数名执行工具且封闭树目录为空；X/雪球直接同步→筛除丢弃材料→准备→小时模块直接refs集成。模型为fake，不能称真实SDK模型验收。全仓`npm run check`840项通过。

生产正常重载使用在线SQLite backup，保存Instance配置和三份Skill；通过Repository compare-and-set暂延queued任务领取，既有schedule临时暂停，等待在途任务结束后才写原启动器restart.request。完成或异常都恢复原queued可用时点及schedule；不能改running任务、输入/来源版本/attempt或覆盖其它较新的调度改动。到限恢复队列，不强杀模型。该运维重载不是新业务Runtime。

实际问答工具调用、有限社媒补处理、有效PromptHash、正式刊期和用量的生产结果保存在实例私有`.ai-data/tree-hour-2026-10-07/tools-social/`，待运行完成后补写实际结论，不用集成fixture冒充生产结果。

生产已通过原启动器安全重载，旧两个在途任务自然完成后才切换，原25个queued可用时点和5个enabled schedule已恢复；原本关闭的验收采集schedule仍关闭，8787健康正常。真实新问答已completed，持久化AI Run含一次`model.usage.get`调用，timeRange=today，结果与工具截至时刻的账本汇总一致；模型用了2次真实请求。后台当前读取新三份Skill与目录，不再是上一轮旧内存配置。定向X准备仅7份本窗口KEEP材料，未全量回填旧帖；后续成稿另补结果。

## 实际验收结果

7份本窗允许X中，4份已在原批次队列，未重复排队或为了验收加工其批次内的多天旧帖；本轮新定向Job实际输入3份，2篇信息稿成功，1篇只有外链标题的内容不足，负缓存标needs-content。原样再次注册执行该3份输入：prepared=2、cacheHits=2、calls=0，现有账本零新增模型请求；缺内容未重复付费。信息节点effectivePromptHash匹配新Skill，分类目录为本轮新目录，不重新翻译全文。

对应实际小时01:00—02:00已结束并发布新版本，10模块/11篇直接信息稿，正式状态partial、pending=7、groupFailures=0。包含2条X作者消息及原有雪球材料，X观点保留作者归属并按主题与新闻同类整理，普通数据中心已归入datacenter。待补包括4份X信息加工、1份X内容不足及2份新闻待加工/内容不足；不能称全小时齐备。完整正文、每模块直接子节点/源ID、所有待补和准确发布版本保存于私有`tools-social/hour/{hour.md,result.json}`，没有导入语义示例或隔离回放稿。

真实390/1440px正式页面所读editionId与新发布头一致，10模块方向展示不丢稿，无溢出/脚本错误；两个X模块实际展开均命中冻结信息节点，并有原文阅读入口。该次页面是在发布后打开，automaticUpdateNotice=false，不能用它冒称“持续打开自动接受”再次实测；上一轮实际自动发现及受控版本保留验证另有记录。

本轮显式验收Job统计仅request：问答2次/17898Token，定向信息3次/28066Token，基于保存信息稿重新分类2次/10600Token，小时5次/35378Token；合计12次/91942已报告Token，无失败请求、无未知总量。重复信息任务零模型请求；无本轮定向全文翻译请求。后台其它自动采集/准备/翻译/打标不计入该验收范围，真实费用仍未知。`usage.json`保留逐请求和聚合原始脱敏索引，turn不重复加总。全仓最终840/840及真实工具、社媒ref、宽度回读通过；仍不宣称所有历史社媒补齐、全系统供应商对账或整体验收完成。
