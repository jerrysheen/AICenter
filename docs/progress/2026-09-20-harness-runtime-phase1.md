# 2026-09-20 Ask 执行器开始切到冻结的 DeepSeek Harness

把 AI Center 从「自研通用 Agent Runtime」改成「DeepSeek Harness Runtime + 应用层插件」。第一阶段不断开旧循环。

## 决定

- 不 fork、不复制 `packages/core`。冻结 `@deepseek-ai/dsh-base` **0.1.6-alpha.2**（commit `ddefc45fbc7f8e46dd73185e68295696d1297887`）。
- 官方嵌入方式是 `dsh --profile sdk` 子进程 + `--patch`，不是把 `dsh-base` 当库 import。
- 产品进程仍是 Web / Worker / SQLite。Domain Tool 继续走 ToolRegistry；Harness 只通过 127.0.0.1 Tool Gateway 回调。
- 默认 `AI_CENTER_AGENT_RUNTIME=local`。`harness` 第一阶段只开放 `holdings.rank`。文章阅读仍走本地 `AgentRuntime`。
- Profile overlay 关闭 shell / 写盘 / subagent / web 内置工具，以及 OTel 与 DeepSeek session-log。

## 验证

- `node --test test/harness-runtime.test.js`
- 现有 `test/agent.test.js` 仍走本地循环（注入 fake LLM 时不会切 Harness）

未做真实 `dsh` 冷启动联调；本机 Node 是 22.14，部分 Harness 依赖声明要求 >=22.19，真跑时可能还要升 Node。
