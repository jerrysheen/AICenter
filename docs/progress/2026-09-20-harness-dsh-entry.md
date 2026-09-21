# 2026-09-20 Harness SDK 在 Node 22.14 上能启动

真实 `dsh --profile sdk` 冷启动原先在 `initialize` 失败。分两层：

1. Node 22.14 没有 `import.meta.main`（22.18 才有）。官方 `@deepseek-ai/dsh` 入口只在该字段为真时调用 `runCli()`，SDK 子进程加载完就空退。
2. `dsh-session-persistence-jsonl` 静态 import `node:zlib` 的 `createZstdCompress`（22.15 才有）。插件树加载失败后 JSON-RPC 还在，于是 `initialize` 报 `cannot create effect on inactive context`。

## 决定

- 不升本机 Node。Worker 通过 `packages/harness/src/dsh-entry.js` 直接 `await runCli()`。
- 22.14 上用 `module.register` 给 `node:zlib` 补 zstd 具名导出；overlay 把会话日志设为 `compression: none`，不走 zstd。
- Overlay 里的 `./plugin/src/index.js` 在启动子进程前改成 `file://` 绝对路径。
- 仍不接 Elucid Grok；Harness 只用已接入的 `DEEPSEEK_API_KEY`。

## 验证

- `node --test test/harness-runtime.test.js`
- `node scripts/probe-harness-init.mjs`
- `node scripts/live-harness-ask.mjs`
