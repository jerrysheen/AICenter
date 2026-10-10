# 总览首页重设计 v2.1

## 决定

`#sources` 首页改成左栏「今天」时间轴，右栏四张行情卡、今日日报，以及官方来源不可用时的一行提示。今日关注、近期日程、最新内容、事件市场四块从首页去掉。事件报价面板原样放到 `#market/global` 的 `#global-events`，只在进入全球行情时读取。

首页首屏并行请求刊期索引、阅读小时索引、总览行情和最新日报。阅读小时索引若是 404，先画出小时骨架，再补最近三期。画完之后才请求首页自己的官方日程，结果放在 `state.homeBoard`，不复用日程页的 `state.staticBoard`。`#sources/schedule` 仍在进入时读取原来的日程板。

行情卡继续用 `preferredOverviewFocus()`。工作日 05:00–17:00 显示上证50、创业板50、科创50、恒生；其余时间含周六显示标普 500、纳斯达克、道琼斯、VIX。缺的指数用当前分组里已有的指数按顺序补满四张。加载中是名称加 `--`。10 秒内出不来显示「读取较慢 · 重试」，失败显示「行情暂不可用 · 重试」。没有改 `config/markets.json`。

`#report?hour=HH` 只由首页生成链接。地址解析留给后续的 parseLocation 修复。

## 验证

- `npm run syntax` 通过。
- `node --check apps/web/public/app.js` 与 `node --check apps/web/public/home-timeline.js` 通过。
- `node --test test/home-timeline.test.js test/feed-scope.test.js test/market-placeholders.test.js`：14 通过。
- 全量 `npm test`：1014 项，通过 1003，失败 10，跳过 1。失败项是既有的分析方法登记 7 项、信息树策略 1 项、本机缺少 Cursor CLI 1 项，以及 `test/model-usage.test.js` 的 `node:zlib` zstd 导出（Node 22.14，不计入）。不计 zstd 后失败 9，不超过基线 10。
- 用真实 `styles.css` 和 `home-timeline.js` 在 1280×800 画了白天（A 股/港股）和晚上（美股）两栏，内容停在约 500px，视口内不用滚动。390×844 时间轴在行情卡上面，首屏能看到。仓库里没有线框原图，没有连上已登录的服务端逐条对 Network。
