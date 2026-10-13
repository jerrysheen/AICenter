# 2026-10-13 首屏少发请求

## 目标

冷打开 tradingplus.cn 时，浏览器和 Cloudflare 隧道里大约有 77 个同时请求。`GET /api/v1/reports/reading-hour` 五分钟里能打到 32 次。看板和简报在服务端不到 100 毫秒，到浏览器却要 5–6 秒，时间耗在排队，不在查询。

## 决定

- 页面请求走 `client-request.js`。同一个 GET 地址共用一个进行中的 Promise。成功结果按接口缓存几秒到 30 秒。`reading-hour` 按 `scope + startAt + endAt` 合成一把小时键，首页和简报小时共用这一次读取。`refresh=1` 和显式刷新不读缓存。调用方自己的超时或取消不会掐掉还被别人等着的那次请求。
- 同时进行的 API 最多 6 个。数字越小越先走。总览先排树目录、小时索引、行情总览、日报简报和官方看板。看得见的 3 或 4 个小时报快照随后。更早的小时、最新消息（手工 / X / 雪球）以及配对、用量、鸿蒙同步放到空闲时，优先级更低。
- 首屏只预加载总览要用的模块：`client-request.js`、`app.js`、`mock.js`、`icons.js`、`markdown.js`、`home-timeline.js`、`shanghai-time.js`、`html-text.js`、`news-list.js`，都带 `?v=`。简报、信息树、分享卡、媒体、硬件、算力、量化、模型用量和点赞改到进入对应页面或空闲时再拉。
- `/favicon.ico` 以前不在静态白名单里，浏览器会 404。现在 `/favicon.svg` 和 `/favicon.ico` 都返回同一张 SVG。
- 翻译轮询不再每秒打 150 次。按退避等待，最长约 90 秒。任务 404、失败、取消、重新排队，或排队超过约 25 秒仍无人领取，或 `availableAt` 已经超出这次等待，都停止。`GET /api/v1/translate/jobs/:id` 在 `queued` 时多返回 `availableAt`。

## 翻译任务为什么会一直像 pending

库里的任务状态是 `queued` / `running` / `completed` / `failed` / `cancelled`，没有 `pending`。页面上的「正在翻译」有两处：轮询把非终态都当成还在进行；信息流投影在没有译文、也没有终态失败行时把 `status` 写成 `pending`。

任务会停在 `queued`：

1. Worker 按 `priority DESC, created_at ASC` 全局领取。翻译任务优先级是 0。小时报、信息准备等更高优先级的任务一直有货时，翻译排不上去，也不会写 `feed_translation_failures`，投影就一直是 `pending`。
2. 失败后 `failJob` 把状态设回 `queued`，`available_at` 最多推到 5 分钟后。在这之前 Worker 不会领。旧页面每秒再问，看到的仍是 `queued`。
3. `requestTranslation` 会复用同输入、尚未结束的任务。再点一次还是挂在这条还没到点的任务上。

`localizeCollected` 在 `wait: true` 时会吞掉翻译异常，条目保持 pending。页面这条链路走的是 `translateMany`，失败会让 Job 重试，不是页面轮询停不住的原因。这次不改领取顺序，避免翻译挤掉小时报。

## 改动

- `apps/web/public/client-request.js`、`favicon.svg`、`app.js`、`information-tree.js`、`index.html`
- `apps/web/src/http/static-files.js`、`apps/web/src/routes/feed-routes.js`
- `test/client-request.test.js`、`test/static-files.test.js`、`test/translate-api.test.js`

Cloudflare Web Analytics 信标不在当前 `main` 的页面里。PR #71 会从静态 HTML 去掉它，这里不再改。

## 验证

`node --test test/client-request.test.js test/static-files.test.js test/static-module-whitelist.test.js test/translate-api.test.js`

## 重启

需要重启 Web。静态白名单和翻译任务响应在 Web 进程里；只换 `public` 文件不会带上新的 `/favicon.ico` 和 `availableAt`。Worker 不用为这项重启。浏览器要重新打开页面，才会换上新的模块图。
