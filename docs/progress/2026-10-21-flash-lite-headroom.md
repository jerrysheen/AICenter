# Flash Lite 按剩余额度换模型

## 目标

Gemini 3.1 Flash Lite 的 RPM、RPD 都顶到限额，3.5 Flash Lite 的 RPM 还很空，但 RPD 也到了 500。快到上限时换到另一个模型，不要等 Google 返回 429。记下每个模型当天的调用次数，方便上线后核对。

## 哪些功能在用哪个模型

- 小时报和信息树浓缩：默认 `gemini-3.1-flash-lite`。输出被截断时改用 `gemini-3.5-flash-lite`。小时准入如果配置了模型池，按当天用量较少的（模型，密钥）挑选。
- 文章整理：`AI_CENTER_HARNESS_ARTICLE_MODEL`，默认也是 3.1 Flash Lite。
- YouTube / X 长视频正文：Gemma 26B。Gemma 失败时，缺的那一段才用 Flash Lite。
- 投资讨论摘要、x-focus 直接打分：默认 3.1 Flash Lite。
- 信息流短帖标注：仍走 Gemini 标注端口，默认 3.1 Flash Lite。这一项改交给 Gemma 是单独的变更。
- 信息流准入分类：Bamboo 或本地兜底，不在这次的 Flash 轮换里。
- 语音转写：`gemini-3.5-transcribe`，不在这次里改。

过去 28 天的限额是每个 Flash Lite 15 RPM、250K TPM、500 RPD。3.1 的分钟峰值到了 19，是因为多把密钥各自计数，项目级的 15 次没有拦住。3.5 多数时候只接截断和少量回退，所以 RPM 只有 4，但全天仍能加到 500。

## 决定

两个 Flash Lite 都放进小时准入的默认候选。本地额度在 14 RPM、480 RPD 时就停掉这一个模型，改走另一个。14 和 480 是限额减去余量：RPM 留 1 次，RPD 留 20 次。只指定了其中一个模型时，余量用完也会改走另一个。两个都到了余量，就等下一分钟或太平洋日切，不再把请求打出去。

投资摘要没有另外配置模型列表时，同样带上另一个 Flash Lite。x-focus 直接打分在两个模型之间轮换。

`model_usage_index` 里按模型汇总当天 `kind=request` 的次数。Worker 启动时打一行 `[worker] model-usage day model=<模型> calls=<次数>`。不写密钥，页面契约也不增加模型字段。不新增 migration。

当前 schema 仍是 94。下一号仍是 95。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。
