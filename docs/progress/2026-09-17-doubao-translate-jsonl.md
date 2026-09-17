# 信息流翻译走豆包 JSONL 信封

## 目标

把「一条 JSONL 信封发出去，收回固定 JSON」定为信息流批量翻译协议。格式验收失败再走 Gemini。

## 决定

- 信封：`custom_id`、`task=translate_feed_items`、`messages`、`input_template`（`batch_id` + `items[{id,text}]`）、`output_schema_hint=feed_translate_output.v0.1`。
- 发送前填好 `{{INPUT_JSON}}`，整包一行 JSONL。
- 验收：能解析为对象；`schema_version` 精确匹配；`batch_id` 一致；`translations` 为数组且至少有一条合法 `{id, translated}`；未知 id 丢弃。
- 验收通过的条目 `engine=doubao-jsonl` 入库。缺 id 的条目留给用户再点翻译，同一次请求不再补 Gemini / 单条引擎。
- 豆包挂起、超时、未确认发送、未登录：立刻失败返回，不自动重试、不串备用引擎。
- 仅当豆包已经给出回复但 JSON 格式不合格时，整批剩余走一次 Gemini。
- `AI_TRANSLATE_JSONL=0` 关闭豆包通道。Web Composition Root 把同一个 `browserRuntime` 注入 `createTranslateService`。
- 页面仍只读 `translatedText`。不接 Agent Tool。

## 验证

`npm run check`。单元测试覆盖验收失败回退 Gemini、挂起不启动 Gemini。
