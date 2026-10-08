# Gemini 信息层整理

2026-10-07 后续授权：Gemma 已从独立 benchmark 扩展为专用原文翻译链路，详见 `gemma-original-translation.md`。本篇的 Article Normalize 继续负责中文整理，Tag、小时和日报保持原模型；原文翻译只走 Gemma，不回退本篇主文章模型池。

2026-10-07 用户授权接入正式代码，覆盖此前仅隔离试跑的执行边界。业务仍是同一冻结 Harness 上的封闭 `article-normalize` Skill，不增加 Agent、HTTP 供应商参数或直接 Connector 生成旁路。

后续五账号扩容代码（用户随后重新授权正式启用）：显式开启文章执行并发池（最多5），同一冻结Harness适配器为各在途封闭任务使用隔离的执行上下文、Gateway和DSH Home，不共享可变Session状态；Ask与小时/日报仍用原串行上下文。这是单篇任务并发，不是多Agent协作。账号模式按用户配置的独立账号身份进行20次/分钟、500次/日限制，全池2500次/日；日界按Google的America/Los_Angeles午夜，明确同项目的Key继续合并预算。原三Key保守模式兼容。每账号/项目＋模型最多一个在途请求，以持久化租约防止多执行上下文抢同一Key，超时可回收、完成立即释放。领取信息准备Job前先检查全池可用窗口，预算关闭时保留原queued任务等待，不创建数百个短周期重试任务。旧无账号归因预留保留并保守计入当日预算，不清账来恢复额度。

正常请求一次产出中文 title、tagId、summary、body；唯一写入点把 summary 映射为信息节点 text。列表和小时层只读取摘要投影，正文在信息节点详情按需展开；日报继续使用小时成果。原始内容和旧节点不覆盖，旧摘要不能作为完整中文正文缓存。媒体/Feed 后处理直接进入注册的信息准备任务，跳过独立翻译、打标、短稿生成。Ask、文章阅读和小时/日报模型路由保持各自现有配置。

`AI_CENTER_ARTICLE_NORMALIZE=1` 启用；文章主供应商 `AI_CENTER_HARNESS_ARTICLE_PROVIDER=google`，默认模型 `gemini-3.1-flash-lite`。Google 使用安装包已有的内置 native provider；不要声明冻结适配器不支持的自定义 `api: google-generative-ai`。默认6144输出上限，不启用 SDK 自动重试。Harness off 映射为 Gemini 的 MINIMAL thinking，不声称推理 Token 为零。

Key 名为 `GEMINI_API_KEY`、`GEMINI_API_KEY2`、`GEMINI_API_KEY3`，也可用 `AI_CENTER_GEMINI_KEY_ENVS` 显式指定。配置必须使用 `=`。Key 值只在环境中，生成设置仅写变量名。相同 Key 去重；项目关系通过各变量对应的 `_PROJECT` 本地稳定别名配置，同项目填同值。未确认时共享分钟流量预算，但供应商失败按实际被拒绝的 Key 单独冷却，依次尝试剩余 Key；不能因为一条额度耗尽就判定另外两条不可用。已确认同项目才共享供应商冷却。Google 额度按项目计算，三 Key 不保证三倍额度，参见 https://ai.google.dev/gemini-api/docs/rate-limits 。

Worker 内的持久化 admission 默认全局至少间隔10秒、每分钟6请求、滚动小时60请求、每项目每分钟100000估算Token预留。输入UTF-8字节数+输出上限+8192是本地保守估算，不作实际用量统计或供应商额度保证；实际用量沿用 modelUsage ledger，未知桶保持未知。migration44仅新增配额预留/冷却表，原 migration 不修改。事务准入和 outbox 同时提交，重启不清预算，失败请求不退预算。繁忙批次分散处理；10分钟是批次目标，不保证在模型延迟、长文Token限制或剩余额度不足时强行完成。

本地限流：保存 budget-deferred 与实际 retryAt，后续任务到时继续，不切付费供应商逃避本地限流。Google明确的429/QUOTA：读取原生 RetryInfo，包括被Harness转义的JSON；按已知项目或单 Key 身份及模型持久化冷却，日额度无RetryInfo时保守等待24小时。剩余可用 Key 在全局间隔之后接续。所有候选 Google Key 都处于供应商冷却时，仅显式 `AI_CENTER_HARNESS_ARTICLE_FALLBACK=elucid-grok` 才使用既有Grok路由；fallback同样占全局时间/次数预算。认证、网络、格式错误不触发供应商fallback。通常只有成功供应商接收一次正文，Google拒绝请求后的供应商切换属于明确的异常重试。

正常小时调度在启用新整理后改为每小时 :30；准备完成触发的小时补编也对齐下一半点。日报生成分钟默认30，可用 `AI_CENTER_DAILY_RUN_MINUTE` 配置；统计截止仍取 `AI_CENTER_DAILY_CUTOFF`，例如08:00截止、08:30生成。未就绪资料仍记partial，手动任务和既有异常补编不被定时规则伪装成已完成。

退回方式：移除/设为0 `AI_CENTER_ARTICLE_NORMALIZE` 并正常重载Worker。保留数据库和迁移，所有旧新版本继续可读；不要回滚或删除用户数据库。实际启用与验证状态见 `progress/2026-10-07-gemini-article-normalize.md`。

## 同一个 Key 按请求切换模型（Host 接口）

用户后续要求先预留模型切换接口，暂缓五账号并发上线。`createHarnessAgentRuntime().run()` 的封闭文章任务接受可选 `googleModel`、`googleKeyEnv`；省略时保持已有默认模型和账号池策略。此参数只在 Host 内部调用，不加入页面 Contract 或 HTTP Job 入参，不允许设备指定供应商凭证。

`AI_CENTER_GEMINI_ARTICLE_MODELS` 为逗号分隔的本地模型白名单；`AI_CENTER_HARNESS_ARTICLE_MODEL` 默认模型始终在白名单内。模型必须是供应商支持的确切 ID，接口不猜测模型是否可用。Key 选择只接受已配置且去重后的 `AI_CENTER_GEMINI_KEY_ENVS` 名称，不接收 Key 值。非法模型、Key 或非 Google 封闭文章任务在模型请求前拒绝。

```js
await runtime.run({
  closedContext: true,
  closedTask: 'article-normalize',
  message: savedMaterial,
  taskInstruction: articleInstruction,
  googleKeyEnv: 'GEMINI_API_KEY',
  googleModel: configuredModelId,
});
```

同一个 `googleKeyEnv` 可连续选择不同 `googleModel`。实际选定模型贯穿 Harness 引擎身份、native Google settings、配额准入和用量记录；切换模型重建对应引擎，凭证仍从环境读取。分钟预算、供应商冷却及账号模式日预算按项目/Key身份＋模型隔离，账号模式的全池滚动小时限制也按模型独立，旧串行模式及显式Grok fallback仍保留原全局保护。一次请求只调用指定模型，不隐式轮换 Google 模型或重送正文；原有显式全 Key 冷却后的 Grok fallback 策略仍适用。上层如需为同一篇文章比较模型结果，必须用实际模型区分缓存身份，不得复用另一模型的稿件冒充新结果。

最初仅接入接口与确定性测试；用户随后授权正式并发上线，新的运行验收单独记录于 progress/2026-10-07-gemini-account-model-pool.md。

正式并发上线决定：全池同时执行最多5个封闭任务，每账号/项目＋模型最多一个在途调用、20次/滚动分钟、500次/供应商自然日；各模型全池2500次/日及2500次/滚动小时分别记账。保留每账号/模型100000估算Token/分钟和至少3000ms发起间隔，20RPM是上限而非保证吞吐。同账号不同模型可同时在不同执行上下文运行，不互占租约或冷却。请求不自动切模型；默认仍为gemini-3.1-flash-lite，白名单可用模型以实际Google ListModels结果核验。Google供应商实际额度不足时遵守原始429冷却，不能把本地上限当作供应商余额。


主文章双模型池：用户明确要求将3.1 Flash Lite和3.5 Flash Lite一并纳入正式主阅读/文章整理预算。`AI_CENTER_GEMINI_ARTICLE_MODEL_POOL`显式列出白名单中的确切模型ID；空值保持原单模型行为。未指定googleModel的封闭article-normalize请求，在持久化准入阶段轮换选择一个可用模型与账号；在HTTP发送前完成选择，一份原文正常只发送一次。显式googleModel继续固定该模型。账号＋模型各自500RPD/20RPM；两个模型五账号理论合计5000RPD，真实供应商限额/冷却另算，不保证每Key都有1000可用次数。Job领取前检查整个模型池，仅所有候选模型的所有Key均处于供应商冷却才允许原显式Grok fallback；本地分钟/Token/日预算不足不转付费供应商。选定的实际模型贯穿引擎、settings和用量账本，modelPool进入generationConfig/缓存策略指纹；旧版本与引用保留。

Gemma纯翻译测试是独立有限benchmark，不进入这个文章整理模型池。用户提供30RPM、16K输入TPM、14400RPD供后续翻译调度参考，不能当作无限并发；本轮只测试，不将未通过质量/可用性检查的Gemma自动上线。

2026-10-07主页兼容读取修复：社交Feed读取通过Domain的normalizedArticlePort复用当前信息头，并核对workspace、sourceId和原文updatedAt/sourceVersion。返回独立normalizedArticle（nodeId/title/summary/body/generatedAt），不把洗练正文写入旧全文翻译缓存。旧社交Feed本来携带正文/译文，此兼容阅读投影带中文正文；树列表与小时模型仍只读摘要。前端卡片使用中文标题/摘要，详情标为“中文整理”并保留原文/对照；等待整理的条目不自动进入旧X批量翻译。读取不调用模型、不写入原文或翻译表。

主页同步边界：中文整理稿不进入客户端全文译文上传队列；服务端同时拦截空engine且与当前整理正文完全相同的旧客户端上传。信息就绪事件复用现有防抖刷新。修复缓存仅用Repository的完整值＋updatedAt条件删除，同事务记录outbox，不批量清空翻译表。验收见`progress/2026-10-07-feed-normalized-reading.md`。
