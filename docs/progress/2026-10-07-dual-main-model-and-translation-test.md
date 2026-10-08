# 2026-10-07 主文章双模型池与Gemma翻译测试

用户明确授权两项：3.1/3.5 Flash Lite同时进入主阅读请求预算；两个Gemma独立翻译有限实测。前者通过AI_CENTER_GEMINI_ARTICLE_MODEL_POOL开启，Host显式googleModel仍固定。未指定模型的文章任务轮换可用账号＋模型，HTTP发送前选定，正常只发送一次原文。每账号＋模型20RPM/500RPD、每模型池2500RPD，双模型五账号理论上限5000RPD；供应商真实项目额度、既有冷却与Token限流照常，不声称已获每Key每日1000可用余额。只有所有模型全部Key供应商冷却才允许显式Grok fallback；本地预算延期不转付费。

modelPool加入generationConfig执行指纹，模型配置变化不冒充旧模型缓存；原版本和引用保持。实际选定模型同时用于引擎、settings、准入与原使用账本。两个新增确定性测试验证轮换实际Harness模型、显式模型固定、一个模型冷却仍使用另一模型、所有模型冷却才允许供应商fallback。全仓npm run check 893/893通过。

上线前用正式Article Normalize Skill和结构化source输入，对3.5进行英文财务短文及含表格长文各1次隔离实测，两次均输出四字段中文JSON，无运行上下文污染。该Skill检查仅证明结构/中文可用，不能冒称完整语义通过：长文882字符遗漏承诺支出与发票不可相加、已过指定检查不等于运营许可、质量试验抽样限制等重要限定，且把cleared误译成已清除/检查凳。先前3.1长文洗练的质量遗留亦未修复。用户明确要求纳入主池，保留这些验收限制，不以中文比例代替语义审查。

Gemma翻译独立benchmark，原程序及原3份fixtures不修改；新增外部Host桥扩展5个模型，最多15次、不重试、不替代模型、至少5.1秒间隔，现有配额Repository准入/持久化租约及translation-benchmark用量索引。只从已有环境取Key5，Key不进命令或报告。原benchmark10项离线测试通过。Gemma参考额度由用户提供：30RPM/16K输入TPM/14400RPD，不能只按RPM盲目拉高长文并发。本轮未启用正式Gemma翻译或修改翻译路由。

真实13次生成：26B三次200；31B三次500；2.5第一次404后余2份跳过；3.1三次200；3.5三次200。数字/表格启发式不能判定质量：26B韩文把任一条件不满足译为任何条件均未满足；3.1正确等值换算美元单位导致原数字literal检查误报；3.5英语短文原文重复、长文只回英文，韩文比较基准漏译。31B质量未知，500不能称额度耗尽。模型和样本结果/人工判断在外部benchmark报告目录，未导入生产文章。

正式重载与双模型生产请求核验随后补记。


正式重载已完成：旧Worker16732→37656，最终36条queued和定时恢复，健康200/schema45。模型池实际为gemini-3.1-flash-lite＋gemini-3.5-flash-lite；自重载后真实生产请求3.1成功6次、3.5成功5次、10个正式新正文节点，列表排除body、详情保留body回读通过。11次请求不伪装10次，模型格式修复与额外请求仍计账；原文章修复流程不在本轮重写。Key1的3.1日冷却仍保留，不复制到3.5。小时与日报仍Grok，调度恢复。

用户随后提供AI Studio get-started入口要求核对调用规则。该URL HTTP200仅返回动态应用外壳；实际规则依据可读的官方Gemma API文档核对。两个模型ID、native v1beta generateContent、contents/parts/text以及thinkingLevel minimal均与文档一致。31B另1次去掉thinkingConfig仍500；再次用无任何generationConfig的最小请求，在Key5和Key2各1次均500/INTERNAL。31B合计6次500，未取得译文；不是429，不声称已确认额度耗尽、所有账号不可用或精确服务端根因。追加诊断分别限定最多2次且实际1次/2次，没有无限重试。

纯翻译基准实际13次，追加协议诊断3次，主阅读Skill隔离检查2次；这些与正式后台请求分别记账。基准9次200已报告14571总Token、4次失败Token未知；不把缺失用量补0或声称供应商账单免费。本轮未把Gemma接入正式翻译默认。外部报告目录含原文、完整输出、人工复核评测结论.md、HTML和原始脱敏元数据。核心代码check893/893，原benchmark离线10/10；调用规则补充与诊断不改变冻结Harness或正式翻译策略。


用户要求继续后，完成26B minimal/high条件句有限复测：计划上限4次，实际3次（minimal英文/韩文均200，high英文90.2408秒network_or_timeout，high韩文依停止规则跳过且零请求）。两档均6000输出上限，原fixtures和指令不修改。minimal两份输出与首轮逐字一致，韩文任一条件不满足被译成若任何条件均未满足的逻辑问题仍可复现。high没有返回最终译文，不能宣称改善或计算实际供应商费用。两次成功共报告1769总Token，超时用量未知；本轮31B零请求，未修改正式翻译默认或无限重试。原benchmark桥仅增加受限26B minimal/high对比选项，未修改原benchmark.py或fixture。

本轮只读回查主阅读池：原Worker37656保持健康200，3.1/3.5分别24/23次成功、46个新正式信息节点，双模型生产路由仍启用。核心源码未新改，因此沿用上一轮893项通过，不将本轮外部模型实测冒称新增全仓测试。外部reports/20261007T083037Z-d71619b6-26b-condition-retest含完整输出、复测结论.md、独立thinking_level CSV和脱敏用量。

已阅读用户提供论坛原文，相似31B 500而26B正常反馈发表于2026年4—5月，不能冒称Google对本次故障已确认根因或当前全网故障。官方规则验证两个模型共用native generateContent、Gemma minimal/high开关有效；先前31B六次500仍仅支持暂缓生产使用，不构成用户额度耗尽证据。


用户纠正为只直接测Gemma连通性与26B具体问题后，使用相同韩文传感器短段、相同native generateContent最小请求（contents/role/user/parts/text，无generationConfig），仅替换模型ID，Key5各1次，未调用Harness或3.1/3.5做测试。31B本次1.031秒500/INTERNAL，26B本次26.35秒200/STOP。26B新译文为“若任何条件未得到满足，将维持现有的手动检查”，该短段条件逻辑正确，单位也译为韩元；旧完整样本minimal的“若任何条件均未满足”存在任一失败变成全部失败风险，不能泛称26B不能翻译。本次默认配置返回thoughtsTokenCount1091，prompt143/candidates91/total1325；输入范围和thinking均与旧minimal样本不同，不能把改善单独归因于某个变量。31B当次用量未知。脱敏原文/请求/输出在Host .ai-data/gemma-direct-only-1791362257103/results.json。本次只作两次直接Gemma实测，不更改正式主模型池或翻译默认。
