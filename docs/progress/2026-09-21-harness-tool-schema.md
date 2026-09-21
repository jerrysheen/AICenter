# 2026-09-21 Harness Tool Schema 投影保留约束

文章阅读里 `knowledge.search` 连续失败，不是知识库空，是模型乱填 `taxonomy`。

## 原因

`toDefineToolParameters` 是我们自己写的 DSH `defineTool` 投影。它之前做了两件错事：

1. 把 Zod 带 default 的字段（`query` / `taxonomy` / `limit`）标成 `required: true`，模型以为必须填 taxonomy。
2. 丢掉 `pattern` 等约束。DSH 的 schema 子集不接受 `pattern`，直接传会拒工具；但投影也没有改写到 `description`，模型只看到 `string[]`。

## 决定

仍只改 Harness 投影，不改 Contract 或 `knowledge.search` 执行。

- 有 `default` 的字段不再标 required。
- `pattern` / min / max 写进 `description`；taxonomy 点分 key 给 `domain.investment` 示例。
- 不把 `pattern` 传给 `defineTool`。

稳定约定已写入 `docs/architecture-modules-v1.md`、`docs/architecture-agent-v1.md`、`docs/contracts-v1.md`、`docs/ai-development-guide.md`。本文只记这次踩坑，不再当规范入口。

## 验证

- `node --test test/harness-runtime.test.js`
