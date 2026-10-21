# Flash Lite 额度按密钥计算，小时浓缩用尽后改走 Gemma

## 原因

`#190` 把 14 RPM、480 RPD 加在整个模型的预留行上，没有按密钥分开。多把密钥各自有 Google 项目额度，本地却把它们加在一起。加总一旦到 480，`retryAt` 就是太平洋日切。夏令时这段日切对应北京时间 15:00。于是 `report.information.prepare` 排着不跑，12:30 的小时浓缩两次 `budget-deferred`，阅读分类也用同一条小时准入，一起被挡住。窗口本身没有算错，错在多密钥合并计数。

这个仓库没有生产库，不能读出线上今天的调用数。Worker 启动日志里的 `model-usage day` 是用量账，`flash-lite reservations day` 是本地预留。判断 480 时看的是后者，并且现在按密钥分开。

## 决定

Flash Lite 的 14 RPM 和 480 RPD 按密钥计数。只有 `GEMINI_API_KEY*_PROJECT` 写成同一个项目时才共用这一桶。一把密钥到了就换下一把，这个模型的密钥都到了再换另一个 Flash Lite。两把模型的密钥都到了当日上限，小时浓缩和阅读分类改走 Gemma 26B，不改走 Grok 或其他计费服务。这一分钟还没满、只是要等下一分钟时，仍等 Flash Lite，不因此改走 Gemma。文章整理仍走原来的 Flash Lite 准入。

Gemma 下一次调用的本地随机间隔如果只比落库的 2 秒下限长出不到 250ms，准入会把剩下的时间当成卡死，调用直接 `budget-deferred`。现在等到本地间隔结束再放行。已经过去的 `retryAt` 仍然立刻失败，不空转。

不新增 migration。当前 schema 是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。

## 验证

`node --test test/flash-lite-headroom.test.js test/gemini-hourly.test.js test/gemma-translation.test.js`
