# 信息流短帖标注改走 Gemma

## 目标

Gemini 3.1 Flash Lite 的 RPM 和 RPD 都已经顶到限额。信息流短帖的标签，以及灵感这类一条只选一个标签的简单分类，以前走 Flash Lite，配额不够还会改打 Elucid Grok。这类小任务改交给 Gemma 26B。Bamboo 负责的信息流准入分类不动。

## 决定

Worker 的 `taggingPort` 仍由原来的入口创建，模型固定为 `gemma-4-26b-a4b-it`。`AI_CENTER_GEMMA_TAG_MODEL` 只能写成这一个名字，写别的直接拒绝。不使用 31B，也不读取翻译模型池里的其他模型。

一批标签先按原来的 20 条、3 万字装好。送给 Gemma 之前再量输入和 4096 的输出上限。超过每分钟 16000 token 就按条目切开，几次结果按原来的顺序拼回去。单条本身放不下就不再请求。额度已经满的这一分钟会等到窗口过去，不等到 429。

不配置 Elucid，也不会因为 Gemini 冷却改走 Grok。调用记在原来的用量账上，阶段是 `tagging`，模型是 Gemma 26B。报错里的密钥会抹掉。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/gemini-tag.test.js test/gemini-grok-fallback.test.js test/tagging.test.js`
