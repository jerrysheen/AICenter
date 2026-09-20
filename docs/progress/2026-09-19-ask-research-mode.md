# 问答专业研究档位接口

## 目标

问答先留一个「专业研究」开关：开了之后走更高模型档位和更审慎的提示。具体研究方法关键词和额外工具还没定，先把 Contract / Service / Job 口留好，不接新模型供应商。

## 决定

- `CreateAgentRunInput.researchMode`：`standard` | `research`，默认 `standard`。
- Domain `resolveResearchProfile` 产出 `AgentResearchProfile`（`modelProfile` / `thinking` / `methodKeywords` / `extraToolIds`）。Runtime Service 写入 `ai.agent.run` Job input，不新增表。
- Runtime 把 Profile 传给 Prompt 和 LLM Connector。`researchOnly` 工具只在 `extraToolIds` 出现时暴露；当前没有这类工具。
- Connector 可映射 `AI_CENTER_AGENT_RESEARCH_MODEL` / `AI_CENTER_ELUCID_GROK_RESEARCH_MODEL`；没配就继续用当前 Grok / Gemini。
- 问答页增加「专业研究」开关，选择记在 localStorage。页面 Contract 不暴露供应商。视觉按 HarmonyOS 开关适配，见 `2026-09-19-ask-research-mode-ui.md`。

## 验证

`npm test -- test/research-profile.test.js test/contracts.test.js test/agent.test.js test/elucid-grok-agent.test.js test/gemini-agent.test.js`
