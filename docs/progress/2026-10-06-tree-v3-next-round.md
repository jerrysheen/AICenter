# tree-v3.1 审核修复与隔离验收

本轮以用户提供的 next-round 审核包为修改范围，保留 tree-v3、DS Harness、用量账本、原有未提交修改和旧稿。未主动执行生产重载或导入本轮新稿。最终只读检查发现：现有启动器在22:15–22:16已尝试重启，生产迁移43已执行；Worker碰到修改中的临时Schema哈希代码启动失败，现已修复并全仓通过。重启触发来源未确定，不能宣称生产完全未变。随后用户明确要求重启，23:10完成生产恢复；不得删除已执行43。静态页面源码保持旧API兼容。最终真实样本与用量在私有 `.ai-data/tree-next-2026-10-06/replay/`，这里不提交原文、数据库、会话日志或部署凭证。

## 代码与候选Skill

三份实际加载文件：

- `packages/runtime/src/information-tree/skills/information.md`
- `packages/runtime/src/information-tree/skills/hourly.md`
- `packages/runtime/src/information-tree/skills/daily.md`

候选内容取舍规则已与统一宿主协议一起接入源码。完成返回title/text/tagId，缺内容只返回status:needs_content。Skill加载器哈希实际封闭提示词、追加协议及显式validatorVersion。Skill的生效在Service创建时，刷新页面不证明生产加载了新提示词。

核心改动文件与职责：

- `packages/contracts/src/information-tree.js`、`tagging.js`、`types.ts`：单一响应协议、状态、归属校验、内部版本与原因；目录增加短说明及阅读映射。
- `packages/domain/src/information-tree-service.js`、`information-tree-policy.js`：正文预检、主分类真源、按版本重分类、父级归组、按组恢复、负缓存、正常小时只读信息。
- `packages/domain/src/information-tree-materials.js`、`daily-materials.js`、`tag-catalog.js`：独立材料准备端口，评论角色剥离，保存正文与版本元数据读取分开。
- `packages/database/src/repositories/information-tree-repository.js`、`feed-repository.js`、`media-repository.js`、`report-repository.js`、`packages/database/src/migrations.js`：迁移43、来源信息头、当前策略与预期head事务检查、元数据清单、原阶段诊断复用。
- `packages/runtime/src/information-tree-module.js`、`feed-automation-module.js`、`media-enrich-module.js`、`report-module.js`、`apps/worker/src/worker.js`：固定准备任务注册；采集/正文就绪先入队，不等待翻译或旧Tag；运行任务允许一个新版本跟进，内容不足不触发Job循环失败。
- `packages/runtime/src/information-tree/skills.js`、`packages/harness/src/harness-agent-runtime.js`：固定Skill加载及tree-*封闭任务的Ask prior隔离。
- `config/tags.json`、`config/tags.default.json`：显式、版本化父级阅读映射；人工主分类锁使用reading.primaryLocks，旧多标签仍保留检索。
- `apps/web/public/information-tree.js`：独立准备信息可读、待补原因、无发布时的成功部分、首读选择有内容刊期。
- `scripts/replay-information-tree-next.mjs`、`audit-tree-next-results.mjs`、`queue-tree-information.mjs`、`preview-information-tree.mjs`、`refresh-tree-preview.mjs`：受控回放、实际用量汇总、有限追赶、隔离预览。
- `test/information-tree.test.js`、`information-tree-next.test.js`、`harness-runtime.test.js`、`feed-automation.test.js`、`media-reading.test.js`：修复后的集成断言及外部模型隔离；`package.json`增加检查和回放入口。

## 执行链与安全边界

Worker → InformationTreeService → 固定Skill与本轮JSON → agentRuntime.run → buildHarnessPrompt → DSH SDK harness.run → 原供应商 → 校验、缓存、发布。没有新增Agent、Runtime、模型HTTP入口或Token账本，未开启原生Skill目录工具、外网、Host工具或聊天历史。信息与小时保持hourly-brief，日报保持daily-analysis；本轮实际路由均为Elucid Grok / grok-4.7，DS Harness是执行器名称。本机prior配置为shadow，不能由此推定旧任务必有额外调用；确定性SDK测试证明新tree-*不调用prior，开放Ask仍调用。

主分类以明确人工锁定优先，其余复用信息模型主旨分类；旧空Tag不会覆盖有效分类。目录改变使用标题和保存提炼稿补判，不读原文；日报路由或阅读映射改变不使信息正文缓存失效。旧策略信息头不被常规小时静默采用，也不触发原文回读，保持明确待准备。删除模块数量必须减少的硬条件，未知ID、遗漏、重复和跨层引用仍硬拒绝。

## 测试与回放命令

```powershell
npm run check
node --test test/information-tree.test.js test/information-tree-next.test.js test/information-tree-http.test.js
node --test test/harness-runtime.test.js test/feed-automation.test.js test/media-reading.test.js
node --env-file=.env scripts/replay-information-tree-next.mjs --run --output .ai-data/tree-next-2026-10-06/replay --max-calls 35 --max-requests 120 --minutes 20 --semantic-guards
node scripts/audit-tree-next-results.mjs --replay .ai-data/tree-next-2026-10-06/replay
node --env-file=.env scripts/preview-information-tree.mjs --serve --replay .ai-data/tree-next-2026-10-06/replay --port 8792
node scripts/refresh-tree-preview.mjs --replay .ai-data/tree-next-2026-10-06/replay
node scripts/verify-information-tree-ui.mjs --url http://127.0.0.1:8792 --output .ai-data/tree-next-2026-10-06/ui-final
```

UI脚本使用已有Host Playwright/Chrome的headless DOM，不模拟桌面操作。390/1440px包含三层展开、每模块一个ref、信息一段及原文阅读返回；页面无溢出与语义内容质量分开判断。包内16个旧分支复现只是理解故障机制，不作为本仓修复通过标准。

## 真实结果记录原则与限制

旧24篇sample-manifest/result/usage原样复制到baseline，76次请求是历史多轮合计，A没有重跑。本轮先完成10篇先导及18份保存完整正文，先导分组控制不足、重复夹具缺workspace记录，均保留pilot日志；夹具在发生重复模型请求前修复。最终固定12篇B/C对照：B保留旧主分类及精确旧分组，C复用有效正文恢复主分类/阅读父级。统一缺内容协议和安全校验由共享新宿主提供，不能将全部差异简单归因于Markdown。C中的冷却后补齐与分类变化分别报告。

三类真实原文各两次独立workspace重复，全部结果保留。另两份计划/设计单位输入明确标为合成语义边界，不计入保存新闻或完整正文样本；它们实际调用模型，绝不把包内semantic_examples候选文字当回放结果。完整正文队列含短快讯，长篇数量有限；超过150字只记录离线改善项，不硬裁、不因为151字反复调用。

用量从本轮隔离SQLite现有账本读取，仅request计数，turn汇总不重复相加。供应商SDK重试也计入，失败和未知用量保留；供应商金额未知。先导请求全计入本轮，旧76次排除。初次两次旧Worker回归测试继承本机配置，误触发真实模型；已固定测试为legacy环境，这两次测试应用调用的供应商请求/用量未保存在回放库中，不能以回放账本数字冒充整轮无缺口成本。

最终样本前后全文、分类、阶段、失败、实际请求与用量见隔离目录`comparison.md`、`audit.json`、`usage.json`。

最终全仓830/830通过；三层页面13宽度×3模式共39检查通过，390/1440px截图、逐层ref及原文返回通过。前后对照12份保存材料；C与B共有的8份有效信息正文全部复用，C另两份为冷却后补齐，不能归功于分类变化。B两个小时均partial，各4模块；C首小时ready/5模块，第二小时partial/4模块；两小时日报仍partial，保留一个供应商失败和一个非重试广告目录缺内容。并非全天日报。

实际配置的隔离Worker构造启动冒烟也通过（使用隔离data/runtime目录，不启动scheduler/runner，不执行模型），确认临时Schema加载故障已修复。随后用户明确授权重启，生产已通过原启动器恢复。

完整正文18份，17成功、1供应商503负缓存冷却待恢复；其中包含短完整快讯，长篇样本有限。真正标题=全文的24字快讯成功产出24字稿。三类原文各重复2次：外包观点133/140字，动态设计151/141字，AIDD150/149字。主对照教程249→143字，B仍旧ai_model、C改ai_application且text完全相同；一般数据中心software→null，GPU数据中心ai_compute→null，柴油宏观父子目录在相同阅读组中比较。

语义边界实际输出保留每日实验设计8000项、年末预测16000项及渠道归属；现金流计划仍明确当前为负、待审批、目标未实现。AIDD真实重复第二次也保留设计指标对象与预测归属，但把篇幅花在数字上，漏了临床/预算反对条件；这仍是内容取舍改善项，不声称所有重复都达标。另3份完整正文稿仍为194/170/170字，未硬裁或付费反复修到长度好看。

本轮隔离共60次应用模型运行（先导39+最终21）、100次实际供应商请求（含SDK重试），54成功/46失败记录；按信息70、小时20、日报10分开。账本已报告总Token455020，分阶段338056/48857/68107；未缺失用量记录，供应商金额未知，失败记录返回零用量不能据此断言未计费。旧76次不计入。本轮最终重放完整正文17个缓存命中、0个正文新调用；C准备有8个有效正文缓存命中及2个冷却后新增调用。两个合成边界真实模型调用单独标记，不计新闻数量。最终累计低于预先设置的120实际请求上限，没有为改善结果继续追加回放。

生产最终只读证据：迁移43；独立信息头/策略为空；配对设备60保留，旧原文/媒体索引和稿件未删除。启动异常日志、只读核对及修改前Git状态/差异均在私有验收目录保留。修复代码与隔离回放已交付；用户随后明确授权重启，生产恢复记录见下文。

## 切换与回退

用户随后明确要求服务器重启，已完成本轮生产恢复。恢复前在线备份DB及Instance配置，确认旧Worker已退出、没有活动模型进程；旧running记录由原Worker恢复机制处理。通过原启动器正常启动；43已执行时保留，不重复改写迁移；不热切在途任务。新建Service确认effectivePromptHash、准备handler、权限和SSE回读；先少量新采集，不导入隔离库或批量重编历史稿。需要追赶时仅显式排有限材料ID队列。回退改legacy并正常重载，历史节点、稿件、数据与用量全部保留，不删迁移、不还原用户库。长文取舍不稳定、供应商失败及partial范围仍需如实保留，不能宣布全来源或整日覆盖已通过。

## 用户授权后的生产恢复（23:10）

用户明确要求“服务器挂了需要重启”，已在线备份到私有 `.ai-data/backups/tree-v3-next-recovery-20261006-230959/`，包含数据库、环境配置、分类配置和恢复前计数。原启动器停在失败后的等待状态，未结束旧窗口；通过同一启动脚本以隐藏窗口恢复Web/Worker，不使用ExecutionPolicy Bypass。Web PID8592、Worker PID29684、启动器PID23296，8787健康检查通过；原Browser、Search、Tunnel复用。旧失败日志保留，不导入隔离回放库，不手工改Job状态。60台配对设备和原始29051条内容保留。

新Worker已创建当前树策略记录，并实际领取注册的 `report.information.prepare` 任务；三份Skill当前effectivePromptHash及恢复状态保存在私有 `production-recovery.json`。策略/任务记录证明新执行路径已加载，生产新稿语义仍需随正常加工观察，不把隔离质量限制改成已通过。

恢复后生产页面390/1440px三种视图共6次检查无横向溢出、无浏览器脚本错误，截图保存在私有 `ui-production/`。正常采集正在推进，部分最新小时仍显示“本期没有可用内容”的真实待补状态。原完整39项脚本在生产旧稿的子ref等待处超时，不能把隔离39项通过直接写成生产全套回归通过；旧日报历史坏短稿保持原样，本轮未批量重写。恢复后Worker错误日志为空，Web/Worker持续存活。
