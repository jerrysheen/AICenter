# 2026-09-19 TypeSafe / Jev Agent 质量层

## 目标

把 TypeSafe System One（Jev）接到现有单 Agent 上，先做可开关的先验 Shadow 与后验流程评审。Jev 不成为 Router，不裁剪 Tool Table，API 失效时不阻断原来的问答。

## 决定

- Connector 走现有 `fetch` 适配，不引入 SDK 依赖。
- 先验默认 `shadow`：预测每个可见 Tool 的帮助概率，只写 Trace，不告诉主模型。
- `advisory` 只追加 hint，仍把完整 Tool Table 交给 Grok / Gemini。
- 后验拆成 coverage / relevance / evidence / sequence / efficiency / completion 六个 Noul；总分由代码按 25/20/20/15/10/10 加权。
- Reviewer 只接收 Audit Projection，不发送持仓、资产或 Tool data。
- 同时用后验的「是否必要」对比先验，拆 Agent Quality 与 Prior Quality，避免自证闭环。
- 第一版不改 DB、API、UI、ToolRegistry。

## 改动

- `packages/connectors/src/typesafe-system-one.js`
- `packages/runtime/src/agent-quality.js`
- `packages/runtime/src/agent-runtime.js`
- `packages/runtime/src/agent-module.js`
- `apps/worker/src/worker.js`
- `.env.example` 增加 `AI_CENTER_TYPESAFE_API_KEY` / `AI_CENTER_JEV_*`
- 测试：`test/typesafe-system-one.test.js`、`test/agent-quality.test.js`，以及 `test/agent.test.js` 回归

## 验证

- 单元测试覆盖请求形状、Audit 不含持仓字段、质量层失败不失败 Run、shadow 不改 system prompt。
- 真实 Key 只写入未提交 `.env`。Worker 日志出现 `Jev quality prior=shadow reviewer=on` 即生效；缺 Key 或 `AI_CENTER_JEV_DISABLED=1` 时不创建该层。

## 遗留

- 评价合同已在 `2026-09-19-jev-quality-contract.md` 校正；旧 5 条的 miss / false positive 不再按 helpfulness 口径解读。
- 新口径下再积 30～100 条真实问答，然后才考虑 `advisory`。
- 页面统计与质量看板未做。
