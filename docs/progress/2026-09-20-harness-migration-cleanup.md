# 2026-09-20 Harness 迁移收口

把公开互联网彻底留在 DeepSeek Harness，清掉 Domain `web.search` 这条迁移残留。不增加产品功能。

## 目标

生产 Ask / 文章阅读只使用 Harness 内置 `web_search` / `web_fetch`。AI Center 只提供业务 Domain Tool。本地循环回退继续能跑测试和显式 `AI_CENTER_AGENT_RUNTIME=local`。

## 决定

- 默认 Worker / Web 不再创建 `DeepSeekSearchProvider`、`search.web`、Domain `web.search` 或豆包 sidecar。
- Article Reader 的 Domain allowlist 只剩 `knowledge.search` / `knowledge.get`。Harness 自己带 web；本地循环才把 Domain `web.search` 加回去。
- Harness 不再 import `agent-runtime.js`。共享可见性规则抽到 `tool-policy.js`，Prior 结算留在 `agent-quality.js`。
- 删除无引用的 `runtime/src/jev.js`。Jev 继续做 Observer，不指挥 Agent。
- `agent-runtime.js`、`deepseek-search.js`、`auxiliary-web-search.js`、SearXNG 明确标成 LEGACY / LOCAL-RUNTIME ONLY。
- Gemini / Grok 客户端改称为 structure LLM，不是主 Agent。

## 改动

- Worker / Web composition root 按 runtime mode 创建 legacy search。
- `createLocalToolRegistry({ includeLegacyWebSearch })` 默认 **false**。只有 local fallback 显式传 true。
- Harness 主模型只读 `AI_CENTER_HARNESS_MODEL`，不再继承 `DEEPSEEK_SEARCH_MODEL`。
- Prompt 拆成 Domain web / Harness web 两套语义。
- 架构校验禁止 `packages/harness` import 本地循环。

## 验证

- `node --test test/harness-runtime.test.js test/searxng.test.js`：Harness 模型不继承 `DEEPSEEK_SEARCH_MODEL`；未显式打开时 Domain `web.search` 不注册。

## 遗留

- 没有新建 `packages/agent-host/`；共享 helper 仍在 `packages/runtime`。
- JEV 文件仍在 `agent-quality.js` / `evidence-gate.js`，没有搬到独立 plugin 包。
- Harness native `web_search` / `web_fetch` 的 Session 投影仍是 `data: {}` / `refs: []`，JEV 与 Source Footer 还看不到 URL / 条数。这是观察层，不接管 Harness Web。
- Node 22.14 的 zlib shim 只给 `@deepseek-ai/*` 补 zstd 具名导出；undici 继续用真实 `node:zlib`，避免 native `web_fetch` 请求 zstd 后把子进程打崩。
- `options.agentClient` 仍会把 Worker 切到 local runtime；结构化任务应改用 `structureLlm`。
- X / B站 on-demand Domain Tool 仍未做，继续只做 Feed 采集。
