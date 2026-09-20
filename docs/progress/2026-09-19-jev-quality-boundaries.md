# 2026-09-19 Jev 质量层三个实现边界

## 目标

Shadow 可以继续跑真实样本前，先去掉会系统性噪声的三处实现。

## 决定

- `knowledge.search`、`taxonomy.list`、`holdings.rank` 改回 root-capable；`memory.save` 只依赖 `taxonomy.list`，不再循环。
- `partial` 先于 strong：官方日程部分源失败时 utility 是 usable，不是 strong。
- Reviewer 只评 Process Quality，不看最终回答对不对；`empty-valid` 是「查询成功、资源不存在」，不是「存在内容」的正向证据。
- 继续 `AI_CENTER_JEV_PRIOR=shadow`，不开 advisory。

## 改动

- `packages/runtime/src/agent-quality.js`
- `test/agent-quality.test.js`
- `docs/architecture-modules-v1.md`

## 验证

- 「查知识库有没有 AVT」会把 `knowledge.search` 送进 T0 Prior。
- `static.signals.list` 带未就绪 sourceHealth 时 outcome=partial、resultUtility=usable。
- Reviewer completion / evidence 文案不再要求判断 Agent 说了什么。

## 遗留

- role / dependency / resultAuthority 长期应落到 Tool Registry metadata。
- Observation-1 follow-up Prior 仍未做。
- 新口径下的 30～100 条真实矩阵还没跑。
