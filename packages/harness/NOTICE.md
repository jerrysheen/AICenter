MIT License notice for DeepSeek Harness integration.

This directory does not copy DeepSeek Harness source. AI Center launches a
pinned `dsh --profile sdk` runtime (`@deepseek-ai/dsh-base` 0.1.6-alpha.2,
commit ddefc45fbc7f8e46dd73185e68295696d1297887) as a subprocess and registers
Domain tools through a loopback gateway.

DeepSeek Harness is copyright DeepSeek AI and licensed under MIT.
See https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE

The accounting integration directly consumes the same pinned MIT packages:
`dsh-token-meter/client`, `dsh-llm/assistant-stream`, and the released
`dsh-session-format-catalog` codec. Native token folds are not copied.
The JSONL read path also uses the pinned official persistence backend and
Cordis 4.0.2. The original frozen-commit MIT text is included in
`LICENSE.deepseek-harness`.
