# AI Center 本地 Grok Codex 启动入口

## 目标

为 AI Center 仓库提供独立的 Codex CLI 启动入口，使用 Elucid 的 OpenAI 兼容接口和 `grok-4.6`，同时避免把 API Key 或本机 Codex 状态提交到仓库。

## 决定

- 使用隔离的 `.codex-grok/config.toml`，配置 `responses` 协议和模型 Provider；该目录由 Git 忽略。
- `ELUCID_GROK_API_KEY` 是 **Elucid 专用 Grok Key**，只注入 Codex 进程；信息流翻译读取 `GEMINI_API_KEY`，Web/Worker 不得读取 Elucid Key。
- 新入口是根目录 `启动-Codex-Grok.bat`，调用 `scripts/start-codex-grok.ps1`；不影响现有 Web/Worker 启动器和手机端 API。

## 验证

- Elucid 的 `/v1/responses` 与 `/v1/chat/completions` 都已返回成功响应。
- `启动-Codex-Grok.bat` 等价的脚本调用已通过 Codex `exec` 实测，`grok-4.6` 成功完成请求。

## 注意

- Codex 当前会提示 `grok-4.6` 没有内置模型元数据，因此使用兼容回退元数据；这不影响本次连通性，但复杂的工具调用行为应另行逐项验证。
