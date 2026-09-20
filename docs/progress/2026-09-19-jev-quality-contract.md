# 2026-09-19 Jev 评价合同校正

## 目标

5 条真实问答暴露的不是 Jev 首轮主工具不准，而是评价口径把 root / follow-up、helpful / necessary、empty-valid / failure 混在一起。先改 `agent-quality.js`，再继续积数据。

## 决定

- 保持 `AI_CENTER_JEV_PRIOR=shadow`。
- T0 Prior 只问 root tool 是否 **required**，不再问 materially help。
- Follow-up 只保留明确依赖前一步输出的工具：`official.source.get`、`knowledge.get`、`memory.save`。`knowledge.search` / `taxonomy.list` / `holdings.rank` 是 root-capable。
- Audit 增加不泄露内容的 `outcome`（found / empty-valid / unavailable / failed / partial）和 `resultUtility`（empty / weak / usable / strong）。
- Reviewer 的 coverage / evidence / efficiency / completion 按这个合同改写：合法空结果可以完成任务；candidate 后再取 authoritative 不算浪费。

## 改动

- `packages/runtime/src/agent-quality.js`
- `test/agent-quality.test.js`
- `test/agent.test.js`（advisory hint 文案）
- `docs/architecture-modules-v1.md`

## 验证

- 日程案：`static.signals.list` hit，`official.source.get` 为 `excluded-follow-up`，不再算 T0 miss。
- `user.method.get` 返回 null 记 `empty-valid`，不把方法正文或 warning 原文发给 TypeSafe。
- `web.search` 有结果是 `weak`，`official.source.get` 是 `strong`。

## 遗留

- 仍未做 Observation-1 的 follow-up Prior。
- 新口径下的 30～100 条真实矩阵还没跑。
- 不要用旧的 0.6–0.8 helpfulness 分数当裁 Tool 规则。
