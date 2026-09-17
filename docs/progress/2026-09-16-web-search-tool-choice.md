# 强制 web.search 的 function calling

## 问题

`webEvidenceRequired` 与「工具是否注册」绑在一起；强制 tool choice 仍把全部 Tool schema 发给 Provider；Provider 不遵守时会空转 7 轮。

## 修改

- `webEvidenceRequired` 与 `webSearchAvailable` 拆开。需要联网但工具未注册时，不调用 LLM，直接说明不可用。
- `toolChoice=required` 时只把 `web_search` 发给 Provider。
- Provider 不遵守 required tool choice：最多再试一次，然后明确失败。
- required 轮 Elucid 超时 60s，超时记为 `PROVIDER_REQUIRED_TOOL_TIMEOUT`，不把默认超时改成 180s。
- 进度文案改为联网核实任务语义。

## Probe

`node scripts/elucid-web-search-probes.mjs A|B|C`

- A 无工具「回复 OK」：3.5s，200，文本 OK。Elucid 未宕机。
- B 只声明函数、AUTO：第一次因函数名 `web_search` 撞上内置 `web_search_call` 失败；改名为 `public_web_search` 后 28s 返回 `function_call`。
- C `tool_choice=public_web_search`：14s 返回 `function_call`。Forced tool choice 有效。
- 真实 Runtime（原问题 + SearXNG）：2 轮模型，第一轮 required `web_search`，命中 10 条，第二轮根据结果作答。约 28s。
