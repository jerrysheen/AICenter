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

## 事件循环和慢接口

b184ade 上线后的访问日志：每分钟事件循环 max 仍是 1.8–2.1 秒，p99 254–1116 毫秒。同一窗口里 285 条请求的 `loopMs` 全是 0。直方图在下一轮事件循环才记下上一轮的延迟，所以请求在 `end()` 里看到的 max 增量是 0；2 秒的阻塞发生在两次请求之间。

现在 Web 每 50 毫秒看一次循环间隙。超过 50 毫秒就记一行 `[web] event-loop-block task=… blockedMs=…`，任务名是当时包住主线程的那段工作：整段 HTTP 处理、`json.stringify`、`events.flush`、`feed.x`、`feed.xueqiu`、`hardware-prices.list`。每分钟的 `[web] event-loop p50=… p99=… max=…` 写入 `data/logs/event-loop.yyyy-MM-dd.log`，访问日志的 `kind=event-loop` 行也带上同一句 `line`。请求上的 `loopMs` 改为直方图增量和这次请求期间记到的阻塞的较大值。SSE 刷新每轮最多 200 条，还有剩余就 `setImmediate` 再写。补发历史同样每 200 条让出一次，任务名是 `events.replay`，避免一次把上万条事件串完。

`GET /api/v1/feed/x` 与 `/feed/xueqiu` 在 `refresh` 未设置时走 20 秒内存缓存，过期先返回上一份再后台重读库。`refresh=1` 仍走原来的抓取，不进这份缓存。`GET /api/v1/hardware-prices` 同样缓存 45 秒。列表里每个系列只取最近 30 条观察来算涨跌和火花线，详情页仍可读更长的历史。

`GET /api/v1/agent/runs` 先前在每条任务事件、每次回到前台、以及非总览启动时都会打。不在问答页、没有进行中的问答、或页签隐藏时不再打。问答页上两次列表请求至少隔 15 秒。单条问答的 800 毫秒进度轮询在页签隐藏时暂停。

部署前（b184ade）：事件循环 max 1.8–2.1 秒，p99 254–1116 毫秒；`loopMs` 285/285 为 0；`feed/x` p50 795 毫秒、p95 2039 毫秒；`hardware-prices` p95 1.4 秒；`feed/xueqiu` p95 716 毫秒；`agent/runs` 数分钟 128 次。

这次测试能证明的变化：第二次相同的 X 列表读取不再进读取函数；80 毫秒的占线程会记到任务名上，并且该请求的 `loopMs` 至少 30。生产上的 p95 要等 Web 重启后再看访问日志。

## 首屏一份响应和本地缓存

总览冷打开原先要打 13 个数据请求：目录、小时索引、行情、日报、官方看板、看得见的 4 个小时快照、手工、X、雪球，以及消息区再打一次看板。现在先读 `GET /api/v1/home/bootstrap`。服务端用现有的树、小时报、行情快照、日报、官方看板和信息流读取拼成一份，15 秒内重复请求直接返回上一份。测试夹具整包 1285 字节；线上体积取决于快照，要等 Web 重启后看访问日志。

浏览器按「用户 + 方法 + 地址」保存成功的 GET。小响应进 localStorage，大约 48KB 以上进 IndexedDB。缓存大约 4MB、80 条，满了丢掉最旧的。退出登录或授权失效时清空。总览打开时先画这份缓存，再带 `If-None-Match` 去复核；304 不改页面。bootstrap 失败时仍回退到原来的五路请求。

会话、事件流和行为上报仍各走自己的请求。

## 重启

需要重启 Web。静态白名单、翻译任务响应、事件循环探针、X / 雪球短缓存、硬件价表列表和 `GET /api/v1/home/bootstrap` 都在 Web 进程里。只换 `public` 文件不会带上这些。没有新的 migration。Worker 不用为这项重启。浏览器要重新打开页面，才会换上新的模块图、停掉问答页以外的 `agent/runs` 列表轮询，并开始用本地缓存。
