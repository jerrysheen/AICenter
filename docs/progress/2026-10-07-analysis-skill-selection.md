# 问答本轮分析方法

2026-10-07 用户要求在现有 Ask 上增加轻量分析方法选择，并落地第一份「美股涨跌原因探索」。没有新增 Agent、模型规划调用、Host 工具或 Harness 文件系统技能插件。

`POST /api/v1/agent/runs` 增加 `selectedSkills`，最多一个 `{ id, version }`。旧客户端省略时为空。正文、路径和哈希不能提交，也不能放进 `references`。服务端对照 `config/analysis-skills/registry.json` 校验精确版本；未知、不可选或内容哈希不一致都拒绝，不改用最新版。Job 只保存编号和版本。Worker 再次读取受控 `SKILL.md`，把本轮指导放进首次 `buildHarnessPrompt` 和追问 `followUpPrompt`。`AiRun.output.activatedSkills` 保存 id、version、name、contentHash。历史重建只带这个身份。下一轮不选则为空。`webMode`、`researchMode`、`modelProfile`、工具权限和预算不变。没有数据库迁移，沿用 Job `input_json` 和 `ai_runs.output_json`。

第一份技能是 `market-driver-search` `1.0.0`。以后新增分析方法：新增版本目录和注册条目，并写入文件字节的 sha256。已发布版本不要改文件或哈希。问答核心调用链不用再改。

呼起与文章阅读对齐：选中时指导进入 `taskInstruction`，不写进用户问题。未选择时不注入。已有会话里下一轮不选，只声明当前未激活。移动端 `@` 菜单限制高度和说明行数，选择时不滚动整页。

`npm run check` 938/938 通过。其中确定性合约测试覆盖拒绝、排队、重启、追问清空和工具不变。`test/market-driver-skill-behavior.test.js` 只用模拟观察检查五条证据规则，没有调用模型，不能当成模型始终遵守指导的证明。真实模型验证未执行。隔离页面核对了桌面和 390px 的 `@` 菜单、本轮标签、失败保留、键盘、输入法组合和删除。
