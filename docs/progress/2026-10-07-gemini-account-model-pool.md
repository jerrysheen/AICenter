# 2026-10-07 Gemini 账号＋模型并发池

用户重新授权正式上线五账号并发，并明确同一个账号不同模型单独算账。全池执行上限5；每账号/已知项目＋模型独立持久化租约、20RPM、500RPD、至少3000ms请求间隔与100000估算TPM；每模型全池2500RPD/2500滚动小时。供应商日界沿用America/Los_Angeles午夜。明确同项目Key合并，原冷却/失败预留与无账号归因历史保留。Ask和报告仍保留原串行上下文，小时/日报路由仍Grok。

同账号不同模型可同时运行，不共享该模型的分钟/小时/日计数或冷却。Host按请求googleModel/googleKeyEnv接口继续显式选择模型，不自动换模型重发原文。Google ListModels只读返回200，确认gemini-3.1-flash-lite、gemini-3.5-flash-lite、gemini-3.5-flash支持generateContent；五个本地Key存在且互异。正式文章默认模型保持3.1，以上模型加入白名单；ListModels不证明3.5生成质量或实际额度。

新增同账号两个模型经冻结Harness适配器同时执行的确定性验证，分钟满额仍允许另一个模型、独立小时和日预算、非法模型/Key拒绝、单模型冷却不传染等检查通过。最终npm run check 891/891通过。

上线过程：先在线SQLite backup与私有.env备份，暂停定时与queued领取，等待在途文章/小时任务自然结束，再通过现有启动器请求正常重载；不强杀模型。运行核验结果随后补记。

正式上线核验：安全重载成功，旧Worker10964→新Worker16732，355条暂缓queued任务和enabled定时恢复，健康200/schema45。上线后正式账本确认Google成功稿，详情保留body、列表投影排除body；已实际观察4个并行在途租约。Key2/3/4/5均有真实准入请求，Key1原日额度冷却保留，不宣称5个账号此刻均有可用额度。正式小时/日报仍Grok、每小时:30/日报08:30。

上线约106秒的只读分钟审计：Key2/3/4/5分别10/8/8/7个主模型预留，各自最大滚动分钟5/5/5/4，低于本地20上限；Token估算和模型耗时仍约束实际吞吐。原积压继续处理，队列304条，不宣称清空。该期间新建完成的准备Job中仍有191项budget-deferred、2项needs-content、1项lease-conflict；领取前检查避免全池彻底关闭时领取，但最小Token估算与实际长文请求估算不同时仍可能出现本地预算延期，不能冒称已完全消除重试。延期未发出模型请求。

额外1次隔离Harness连通性探针：Key4显式选择gemini-3.5-flash-lite，Google实际返回成功，未写正式文章或导入隔离结果，未触发Grok fallback。探针用最小测试指令，返回body混入Harness运行上下文，因此只证明模型选择/协议/账号可调用，不能算中文洗练质量验收；3.5尚未成为正式默认。正式文章继续3.1。私有运行证据保存在.ai-data/gemini-five-account-20261007/的reload.json、production-active.json、minute-audit.json、model-switch-smoke.json，密钥和备份不入Git。
