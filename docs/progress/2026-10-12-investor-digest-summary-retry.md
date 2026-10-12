# 2026-10-12 股民讨论日摘总结重试

10/12 日摘是 partial：昊华科技的总结遇到 Gemini 503，只记了失败。南大光电只有 2 条方向发言，页面仍画出看多 100%。总结里还会出现和占比不一致的「分歧明显」。

## 总结请求

500、503、429 先换 `GEMINI_API_KEY` 到 `GEMINI_API_KEY5` 里下一个还没冷却的 key。同一模型的 key 都失败后，按 1 秒、2 秒、4 秒退避，默认再试 3 次，封顶 8 秒。仍然失败就换 `AI_CENTER_INVESTOR_DIGEST_SUMMARY_MODELS` 里的下一个模型。主模型仍是 `AI_CENTER_INVESTOR_DIGEST_MODEL`，缺省 `gemini-3.1-flash-lite`。没有 Grok 回退。429 按模型和 key 写入现有配额冷却。

## 页面和措辞

方向发言少于阈值（默认 5）时，只显示「数据不足（n 条）」，不显示百分比，也不显示看多/看空条数。已经落库、但条数不够的行同样按条数隐藏百分比。

总结提示词带上算好的占比。任一侧超过 60% 时禁止「分歧明显」；模型仍写了，就改成「看多占多数」或「看空占多数」。样本不足时去掉带百分比的句子。

## 只重试失败标的

日摘页在有失败标的时显示「重试失败的标的」。请求体是 `{ "date": "2026-10-12", "retryFailed": true }`。只重抓 `failed` 和 `summary_failed`，以及覆盖率里缺失的标的。已经成功的总结保留。

## 环境变量

- `AI_CENTER_INVESTOR_DIGEST_SUMMARY_MODELS`：总结备用模型，逗号分隔。空则只用主模型。
- `AI_CENTER_INVESTOR_DIGEST_SUMMARY_RETRIES`：每个模型在换模型前的额外轮数，默认 3，范围 0 到 6。非法值按 3。
- 打标签用的 `AI_CENTER_GEMINI_KEY_ENVS` 同样用于总结。

改完需要重启 Web 和 Worker。没有新的 migration。
