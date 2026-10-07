# Gemini 信息层整理

2026-10-07 用户授权接入正式代码，覆盖此前仅隔离试跑的执行边界。业务仍是同一冻结 Harness 上的封闭 `article-normalize` Skill，不增加 Agent、HTTP 供应商参数或直接 Connector 生成旁路。

正常请求一次产出中文 title、tagId、summary、body；唯一写入点把 summary 映射为信息节点 text。列表和小时层只读取摘要投影，正文在信息节点详情按需展开；日报继续使用小时成果。原始内容和旧节点不覆盖，旧摘要不能作为完整中文正文缓存。媒体/Feed 后处理直接进入注册的信息准备任务，跳过独立翻译、打标、短稿生成。Ask、文章阅读和小时/日报模型路由保持各自现有配置。

`AI_CENTER_ARTICLE_NORMALIZE=1` 启用；文章主供应商 `AI_CENTER_HARNESS_ARTICLE_PROVIDER=google`，默认模型 `gemini-3.1-flash-lite`。Google 使用安装包已有的内置 native provider；不要声明冻结适配器不支持的自定义 `api: google-generative-ai`。默认6144输出上限，不启用 SDK 自动重试。Harness off 映射为 Gemini 的 MINIMAL thinking，不声称推理 Token 为零。

Key 名为 `GEMINI_API_KEY`、`GEMINI_API_KEY2`、`GEMINI_API_KEY3`，也可用 `AI_CENTER_GEMINI_KEY_ENVS` 显式指定。配置必须使用 `=`。Key 值只在环境中，生成设置仅写变量名。相同 Key 去重；项目关系通过各变量对应的 `_PROJECT` 本地稳定别名配置，同项目填同值。未确认时共享分钟流量预算，但供应商失败按实际被拒绝的 Key 单独冷却，依次尝试剩余 Key；不能因为一条额度耗尽就判定另外两条不可用。已确认同项目才共享供应商冷却。Google 额度按项目计算，三 Key 不保证三倍额度，参见 https://ai.google.dev/gemini-api/docs/rate-limits 。

Worker 内的持久化 admission 默认全局至少间隔10秒、每分钟6请求、滚动小时60请求、每项目每分钟100000估算Token预留。输入UTF-8字节数+输出上限+8192是本地保守估算，不作实际用量统计或供应商额度保证；实际用量沿用 modelUsage ledger，未知桶保持未知。migration44仅新增配额预留/冷却表，原 migration 不修改。事务准入和 outbox 同时提交，重启不清预算，失败请求不退预算。繁忙批次分散处理；10分钟是批次目标，不保证在模型延迟、长文Token限制或剩余额度不足时强行完成。

本地限流：保存 budget-deferred 与实际 retryAt，后续任务到时继续，不切付费供应商逃避本地限流。Google明确的429/QUOTA：读取原生 RetryInfo，包括被Harness转义的JSON；按已知项目或单 Key 身份及模型持久化冷却，日额度无RetryInfo时保守等待24小时。剩余可用 Key 在全局间隔之后接续。所有候选 Google Key 都处于供应商冷却时，仅显式 `AI_CENTER_HARNESS_ARTICLE_FALLBACK=elucid-grok` 才使用既有Grok路由；fallback同样占全局时间/次数预算。认证、网络、格式错误不触发供应商fallback。通常只有成功供应商接收一次正文，Google拒绝请求后的供应商切换属于明确的异常重试。

正常小时调度在启用新整理后改为每小时 :30；准备完成触发的小时补编也对齐下一半点。日报生成分钟默认30，可用 `AI_CENTER_DAILY_RUN_MINUTE` 配置；统计截止仍取 `AI_CENTER_DAILY_CUTOFF`，例如08:00截止、08:30生成。未就绪资料仍记partial，手动任务和既有异常补编不被定时规则伪装成已完成。

退回方式：移除/设为0 `AI_CENTER_ARTICLE_NORMALIZE` 并正常重载Worker。保留数据库和迁移，所有旧新版本继续可读；不要回滚或删除用户数据库。实际启用与验证状态见 `progress/2026-10-07-gemini-article-normalize.md`。
