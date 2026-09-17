# 问答 @ 引用本地 Knowledge

## 目标

在问答输入框输入 `@` 后，拉起本地分析框架和知识文档，选中后作为已有 `references` 协议加入本次提问。不引入 MCP Skill 运行时，不直接暴露本地路径。

## 决定

- 可引用对象就是 Knowledge：文件框架（`knowledge/` Markdown）和 SQLite 知识文档。
- 页面补全走 `GET /api/v1/knowledge/mentions`；选中后 `resourceType=knowledge-revision`，发送时仍走 `CreateAgentRunInput.references`。
- 输入框里留下 `@标题` 文本，同时 chips 显示 ref；Agent 仍由 `resolveReferences()` 读取正文。

## 验证

- `npm run check`
- 浏览器：问答输入 `@` 出现科技成长框架，选中后 chips 出现，发送请求带 references。
