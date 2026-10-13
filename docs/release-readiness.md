# 0.2.0 发布门槛

2026-10-13 Gemini 小时调用在两个模型之间按用量均衡：小时准入不再按固定顺序先占满 `gemini-3.1-flash-lite`。`reserve` 在模型池里挑选当天用量最少的（模型，key），分钟、日额和冷却仍按原来的桶拒绝。信息树浓缩从这一对所在的模型开始，失败后再换另一个模型。阅读分类不指定模型，走同一套挑选。文章模型池的轮换游标写入 `gemini_model_cursors`（migration 60），重启后从下一个模型继续。`model_usage_index.http_status`（migration 61）记下 429 和 503；页面明细显示这个状态码，仍不返回供应商和模型名。配额冷却、探针和显式 `googleModel` 不变。需要同时重启 Web 和 Worker，由先启动的进程建表。不要重建数据库。见 `progress/2026-10-13-gemini-model-balance.md`。

2026-10-13 首屏不再在请求里序列化大包：`GET /api/v1/home/bootstrap` 只留最近小时的命中条、去掉走势线的行情、日报前几句和最多 8 条官方发布。手工、X、雪球改由页面随后请求。缓存里放的是已经 `JSON.stringify` 并 gzip 过的缓冲区，命中时请求路径只写出这组字节。`GET /api/v1/feed/x` 与 `/feed/xueqiu` 同样缓存这份缓冲区；列表查询不再读取正文大字段，也不为规范化文章再读一遍正文。`events.flush` 每次最多写 5 条，直接用库里的 JSON 文本，没有 SSE 订阅者时只把游标拨到最新 id。`/favicon.ico` 和 `/favicon.svg` 从内存返回，`Cache-Control: public, max-age=604800`。夹具里一份撑大的旧包 1781077 字节、序列化 4.42ms，收成首屏后 20607 字节、gzip 1153 字节、组包加序列化 10.81ms。需要重启 Web。Worker 不用为这项重启。没有 migration。见 `progress/2026-10-13-bootstrap-stringify.md`。

2026-10-13 页面计时与展开 / 原文：`client-timing.js` 每次文档加载都 POST 一条，`Content-Type` 是 `text/plain`。没有 Navigation Timing 时七个阶段记 0。`load` 已结束、8 秒内还没 `load`，或从往返缓存恢复，都会发。页面开着时走 `fetch` `keepalive`，失败再用 `sendBeacon`。`?v=` 仍按内容改写。Host 被隧道改成回环地址且带 `cf-ray` 或 `cf-connecting-ip` 时仍写入 `client-timing.*.log`。`原文`、`打开原文`、`打开原站`、`前往原站` 和 `阅读站内原文` 记 `source.original`。展开阅读折页、中文正文或「展开…」记 `item.expand`。需要重启 Web。浏览器再加载一次。Worker 不用重启。没有 migration。见 `progress/2026-10-13-client-timing-behavior.md`。

2026-10-13 首屏一份响应：`GET /api/v1/home/bootstrap` 在服务端拼好总览要的目录、小时索引、最近 4 个小时快照、行情总览、日报简报、官方看板，以及最多 12 条手工 / X / 雪球。窗口与页面上的 `homeRequestPlan` 相同。15 秒内存缓存，过期先返回上一份。`refresh=1` 重读，不抓行情上游。没有快照时行情和看板带 `pending`。弱 ETag，`If-None-Match` 命中返回 304。简报去掉 `providerId` / `modelId`。这个地址不在 Bearer 只读名单里。浏览器把成功的 GET 按「用户 + 方法 + 地址」放进本地缓存，小于约 48KB 的进 localStorage，更大的进 IndexedDB，合计约 4MB、最多 80 条，退出登录时清空。总览先画缓存，再带 ETag 复核，变了才改页面。冷打开的总览数据请求从 13 次收成这一次。SSE 回放每 200 条让出一次主线程。需要重启 Web。Worker 不用为这项重启。见 `progress/2026-10-13-frontend-load.md`。

2026-10-13 事件循环归因：分钟采样的 max 仍有 1.8–2.1 秒时，`loopMs` 在已部署的 285 条请求上全是 0，因为直方图要到下一轮才更新，请求结束时差值还是 0，阻塞又发生在两次请求之间。现在每 50 毫秒量一次事件循环间隙，间隙超过 50 毫秒就写下当时的任务名。`json.stringify`、整段 HTTP 处理、`events.flush`、`feed.x` / `feed.xueqiu` 和 `hardware-prices.list` 都有名字。阻塞行和每分钟的 `[web] event-loop p50=… p99=… max=…` 写入 `data/logs/event-loop.*.log`，访问日志里的同一次采样也带上这行文字。请求的 `loopMs` 取直方图增量和这次请求里记下的阻塞的较大值。SSE 每轮最多写 200 条，剩下的让出主线程。`GET /api/v1/feed/x` 与 `/feed/xueqiu` 在不刷新时缓存 20 秒，过期先返回旧列表再在后台重读。`GET /api/v1/hardware-prices` 缓存 45 秒，列表每个系列只取最近 30 条报价，不再为火花线读出最多 5000 行。问答列表 `GET /api/v1/agent/runs` 只在问答页或已有进行中的问答、并且页面可见时拉取，两次至少隔 15 秒；页签隐藏时单条轮询也暂停。需要重启 Web。Worker 不用为这项重启。见 `progress/2026-10-13-frontend-load.md`。

2026-10-13 首屏请求：页面 GET 共用进行中的 Promise，并按接口缓存数秒到 30 秒。`reading-hour` 以小时窗口为键，首页和简报不再各打一遍。同时最多 6 个 API，总览的目录、小时索引、行情、日报和看板优先。首屏 modulepreload 只保留总览模块；简报、信息树、媒体、硬件和量化改到进入页面或空闲时再加载。`/favicon.ico` 改为返回 SVG，不再 404。翻译状态轮询改为退避，约 90 秒封顶；任务不存在、失败，或排队超过约 25 秒仍无人领，就停止。`GET /api/v1/translate/jobs/:id` 在排队时返回 `availableAt`。翻译任务仍可能停在 `queued`：Worker 按全局优先级领取，翻译优先级是 0，失败重试还会把 `available_at` 推后最多 5 分钟，投影在没有译文和终态失败行时继续显示 pending。这次不改领取顺序。需要重启 Web。Worker 不用为这项重启。见 `progress/2026-10-13-frontend-load.md`。

2026-10-13 事件循环剩余阻塞：访问日志每个请求增加 `loopMs`，汇总按路径给出这段请求里观察到的事件循环延迟；达到 200 毫秒时另打一行 `[web] event-loop`。静态文件缓存未命中时的 `gzipSync`，以及信息树 JSON 的同步 gzip，改为 zlib 异步压缩，不再占住主线程。`GET /api/v1/markets` 与 `GET /api/v1/market-native/board` 不再在 Web 请求里抓上游。Worker 每分钟跑 `market.boards.snapshot` 和 `market.native-board.snapshot`，写入已有的 `runtime_snapshots`（键 `market-board-*`、`market-native-board`）。接口内存缓存 45 秒，过期先返回旧值。`refresh=1` 只重读数据库。没有快照时返回空看板并带 `pending: true`，不访问行情源。美股 / 亚洲 / A 股的用户自选仍只补那些代码的报价，不重算整板。不新增 migration。需要同时重启 Web 和 Worker。Worker 写出第一份快照之前，这两个接口是空的并标 `pending`。见 `progress/2026-10-13-event-loop-markets.md`。

2026-10-13 信息流查询：`GET /api/v1/feed/x` 与 `/feed/xueqiu` 先按未读、已读用 migration 59 的索引取本页 id，再读这一页正文，响应字段和未读在前的顺序不变。已读游标 `1,…` 只返回已读，未读页之后仍能翻到已读。`GET /api/v1/feed/trendforce` 只返回摘要，全文仍用 `GET /api/v1/feed/media/article`；列表带弱 ETag，`If-None-Match` 命中时 304。`client-timing.js` 在 `load` 已结束或从往返缓存恢复时仍会上报，正文是 `text/plain`，隧道把 Host 改成回环地址时本站请求仍写入 `client-timing.*.log`。行为事件合并发送，`feed.loaded` 的 count 是当前可见条数，并补上页签、文章、分享、小时、展开、原文、提问和超过约 1 秒的视图。静态 HTML 去掉 Cloudflare Web Analytics 脚本。需要重启 Web 才会建索引并加载新路由。Worker 不必为这项单独重启。见 `progress/2026-10-13-feed-query-perf.md`。

2026-10-13 Web 主线程：`GET /api/v1/static-signals/board` 不再在请求里并发读取官方源。Worker 每分钟跑 `source.static-signal-board.snapshot`，把宽窗口看板写入 `runtime_snapshots`。接口只读这份快照，内存缓存 45 秒，过期后先返回旧值再在后台重读数据库。还没有快照时，空结果只缓存 5 秒。`refresh=1` 只跳过内存缓存。没有快照时返回空的 `StaticSignalBoard`，并带 `pending: true`。持仓接口不再在 Web 进程里拉行情和三个月历史；Worker 每分钟刷新 `holdings-market` 快照，报价每次都拉，历史大约 15 分钟拉一次，丢价时留下上一笔有效价。没有快照时持仓仍按账本算出，说明里写「行情快照尚未就绪」。Web 每 60 秒用 `monitorEventLoopDelay` 打一行 `[web] event-loop`，并把 p50/p99/max 追加进访问日志。汇总里的 `eventLoop` 单独统计这些采样，不混进请求路径。migration 58 只新增 `runtime_snapshots`。需要同时重启 Web 和 Worker，由先启动的进程建表。不要重建数据库。见 `progress/2026-10-13-web-main-thread.md`。

2026-10-13 访问日志：Web 对每个请求追加一行 JSON 到 Instance `data/logs/access.yyyy-MM-dd.log`（上海日期），记下收到、首字节、结束、字节、状态、方法、去掉查询值后的路径（保留 `v`）、Cache-Control / 304 / 进程内缓存命中、`cf-ray`，以及 `cf-connecting-ip` 的进程内哈希。不记原始 IP 和查询里的令牌。`serverMs` 是首字节减收到，`transferMs` 是结束减首字节。写入走缓冲追加，不挡住请求，失败也不抛进请求。`AI_CENTER_ACCESS_LOG` 默认开，`AI_CENTER_ACCESS_LOG_RETENTION_DAYS` 默认 14。`scripts/access-log-summary.mjs` 和 `GET /api/v1/runtime/access-summary` 给出按路径的 p50/p95/max；接口要设备登录，Bearer 和回环都不能代替。页面加载后 `client-timing.js` 以 20% 抽样把 Navigation Timing 和最慢的约 20 条同源资源 POST 到 `/api/v1/runtime/client-timing`，记入 `client-timing.yyyy-MM-dd.log`。需要重启 Web 才会记日志并提供这两个接口。Worker 不用为这项重启。见 `progress/2026-10-13-access-log.md`。

2026-10-12 小时补跑推进未准备来源：`pendingCount` 以前把还没变成信息节点的来源都算进去，其中大部分是 `information-not-ready`。补跑只重发已有节点，不排信息准备，所以条数不变。现在补跑和定时任务会为这些来源各入队一张准备任务，本小时优先级 30，补跑优先级 10，不压过当前小时已有的 20/30。连续失败达到 `AI_CENTER_INFORMATION_PREP_ATTEMPTS`（默认 3）后记为 `prep-exhausted`；`needs-content` 和 `stale-policy` 同样保留原因，但不再触发下一张补跑。没有失败记录的未就绪来源不会被直接记成终态。带 `followUp` 的任务写一行 `[worker] hourly-pending`，按原因计数，并写上准备队列状态。20:00 有 1 条未处理却没被回扫，是因为 `AI_CENTER_HOURLY_SWEEP_LIMIT` 默认 2 而且总是取窗口里最新的两小时，不是因为它超出默认 6 小时窗口。现在窗口内按主小时轮转。需要重启 Worker。见 `progress/2026-10-12-hourly-pending-prep.md`。

2026-10-12 旧刊期待处理回扫：主小时补跑只覆盖当次小时，所以 23:00 的 10 条和 20:00 的 1 条在下一轮定时任务里不再有任务。现在每次定时小时任务先排本小时的补跑，再为最近 `AI_CENTER_HOURLY_SWEEP_HOURS`（默认 6）小时里刊期 `pendingCount>0` 或分类延后、且没有排队或运行中任务的小时，最多再排 `AI_CENTER_HOURLY_SWEEP_LIMIT`（默认 2）张，原因是 `edition-pending-sweep`。比这个窗口更早的小时不排。这张补跑不再连环排，优先级低于本小时。`[worker] tree-hourly` 的 `finishReason` 写完整枚举（`max-tokens`、`SAFETY`、`stop` 等），只有 `body` 和 `message` 截到前 300 字。需要重启 Worker。见 `progress/2026-10-12-hourly-pending-sweep.md`。

2026-10-12 小时补跑对准主小时：00:30 的定时任务会先做最新结束的小时，再顺手回补一个更早的小时。60 秒补跑以前挂在任何一个仍有分类失败的窗口上，所以 23:00 有 10 条未就绪来源时，补跑却排到了回补的 20:00。现在补跑小时只取这次任务的主小时（显式 `hourStart`，否则是返回的第一份刊期）。该小时有分类失败、配额延后，或刊期 `pendingCount>0`，才排一次；`followUp` 已设置的补跑不再连环排。小时浓缩每次调用用 `console.log` 写一行 `[worker] tree-hourly`（种类、状态、错误信息、响应前 300 字、模型、key 后缀、输入字节、finishReason、耗时、结果），进 Node 追加的 `worker.out.*.log`。已配置多把 Google key 时，非配额失败（含 5xx）换下一把 key 再试一次，不再把同一次失败在同一模型上连打三次。需要重启 Worker。见 `progress/2026-10-12-hourly-followup-hour.md`。

2026-10-12 阅读分类和 Worker 日志：分类失败日志带上状态、错误名、响应片段、key 后缀、模型、耗时和输入大小，每次模型调用正好一行。单次调用从 90 秒改为 180 秒。非配额失败换下一把 key 再试一次，仍失败就整批延后，不拆成逐条。延后的分类会在约一分钟后再排一次小时任务；这次补跑不再连环补。过了本小时的准备槽之后，新准备好的材料也在一分钟内补进小时报，不再等到下一小时的槽。浓缩失败原因仍写在原来的失败行里，并跟 Worker 错误日志一起落盘。Web / Worker 由 Node 追加 `worker.out.yyyy-MM-dd.log` 与 `worker.error.yyyy-MM-dd.log`（Web 同理）；终端里仍打印，被重定向时不再写管道。需要重启 `start-ai-center.ps1`。见 `progress/2026-10-12-hourly-error-logs.md`。

2026-10-12 总览白屏：`share-card.js` 引用 `markdown.js`、`qr-code.js` 时没有 `?v=`，边缘把无版本 JS 缓存一年，旧模块缺少 `markdownShareBlocks` / `stripSharePlaceholders`，`app.js` 加载失败。本地 JS 引用改为 `?v=dev`，由静态服务按指纹改写。没有 `v` 的 JS 响应改为 `Cache-Control: no-cache`；带 `v` 的 JS 仍是一年 immutable。需要重启 Web。Worker 不用重启。见 `progress/2026-10-12-static-js-cache.md`。

2026-10-12 小时阅读分类按整小时攒批：同小时未分类材料凑满 `AI_CENTER_READING_CLASS_BATCH`（默认 10）才调用；来源还在准备时留下的短批不打模型。小时不再等待新的信息节点时才送出剩余短批。`AI_CENTER_READING_CLASS_BATCH=1` 仍是一条一次。每次分类调用写 `[worker] reading-class`（条数、是否逐条回退及原因、key 后缀）。浓缩失败日志补上状态、响应片段、模型、key 后缀和输入长度；模块输出契约不变。Web / Worker 日志改由队列写入并在失败后重开文件，进程活着时不再停写。`AI_CENTER_HOURLY_DISABLED=1` 时小时报仍然整段停用。需要重启 `start-ai-center.ps1`。见 `progress/2026-10-12-hourly-batch-pool.md`。

2026-10-12 小时报阅读分类可按批调用：`AI_CENTER_READING_CLASS_BATCH` 默认 10，设为 1 时仍是一条一次。提示词保留原来的阅读分类说明，并要求按 `idx` 逐项独立判断、返回 JSON 数组。解析失败或缺失、非法的条目只回退那些条；配额或冷却不拆成逐条再打，同一批在已配置的 key 上轮询并仍走原有准入。信息树浓缩不改。`AI_CENTER_HOURLY_DISABLED=1` 时小时报仍然整段停用。需要重启 Worker。见 `progress/2026-10-12-reading-class-batch.md`。

2026-10-12 阅读页与日期：分享预览打开时备好 PNG，「保存」当次点击即可下载，iPhone / iPad 改为系统分享。问答分享按钮收在回答右上角，正文留出上边距。阅读页、媒体段落和小时报展开正文去掉 `[未抓取]`、`图片 ×N`、`[图片]`。小时报展开条目在有来源地址时提供「原文」链接。日报日期不再把日历日和 `hourCycle: h23` 放在同一次格式化里；窗口正好结束于上海时间 0 点时，标签用结束前一瞬间。08:00 截止的日报日期不变。重载 Web。Worker 不用重启。见 `progress/2026-10-12-share-image.md`。

2026-10-12 小时报可整段停用：`AI_CENTER_HOURLY_DISABLED=1` 后，Worker 启动不再把 `report.hourly.default` 写成 `enabled:true`，定时、准备后的补编和手动入队都不再创建小时任务，已经排队或仍标为运行中的 `report.hourly.extract` 会被取消。启动只打一行日志。需要重启 Worker。见 `progress/2026-10-12-hourly-disabled.md`。

2026-10-12 分享图验收：日报单条在列表和详情都有分享。小时报每条直接分享本条标题和摘要，标题展开本条正文，不再打开第一条引用；`[未抓取]`、`图片 ×N`、`[图片]` 不进分享卡。问答分享用回答完成时间（没有则用记录创建时间），Markdown 表格画成网格，链接只留文字，分享按钮在回答顶部。媒体列表上的「已验证正文」不再把空列表壳留在阅读器里；快照只有段落、`bodyText` 为空时读取会拼回正文。`#ask` 历史卡片在窄屏上折行，不再超出右缘。重载 Web。正文回退随 Web 进程重启生效。Worker 不用重启。见 `progress/2026-10-12-share-image.md`。

2026-10-12 GPU 租金增加三个公开来源：CCIR 阶梯表（超大规模 / 新云 / 市场，保障与可中断，含 B300 与 A100）默认 20:30 与 21:30；GPU Economy 多供应商中位默认每 120 分钟；Bargo 按需 / 竞价 / 预留均价默认 09:00。报价日优先用页面上的日期。异常低价沿用同型号中位 40% 和下限。页面可按来源筛选，并链到出处。不新增 migration，不接入 Ornn 或 Silicon Data。需重启 Worker，并重载 Web。见 `compute-prices-v1.md` 与 `progress/2026-10-12-gpu-price-sources.md`。

2026-10-12 分享图：信息流条目、阅读页、小时报和日报单条，以及原来的问答卡，共用一张分享卡（标题、来源、时间、正文、tradingplus.cn 水印和离线二维码）。长文始终导出一张 PNG，不再分页。卡片 CSS 宽固定 540（落在 375–540，2 倍时像素宽 1080）。倍率取 `min(3, 边长/内容边, sqrt(16.7M/(宽×高)))`，平时在 2–3；放不下就降到不低于 1.5，1.5 仍超出就用放得下的最大倍率。单边不超过 16384，或设备实际更小的上限；总像素不超过约 1677 万。新增静态脚本 `/qr-code.js`，Web 要重载一次才提供这个地址；Worker 不用重启。见 `progress/2026-10-12-share-image.md`。

2026-10-12 外部机器人只读 API 令牌：设置页由本机桌面或已配对设备生成、列出和撤销。明文只出现一次，库表只存 sha256 与前缀。`Authorization: Bearer` 只能读取日报与简报、小时报、信息流与搜索、股民讨论日摘、行情（含硬件价格和算力价格）。写入、令牌管理、Runtime 和部署状态拒绝 Bearer。默认每令牌每分钟 60 次，429 带 `Retry-After`。访问日志保留 14 天，不记明文。migration 57，只新增表。需要重启 Web 才会建表并加载鉴权；不必为这项重启 Worker，也不要重建数据库。见 `api.md` 与 `progress/2026-10-12-readonly-api-tokens.md`。

2026-10-12 生产首次抓取后的过滤：Gemini Pro 不再选到出图型号，只保留 `output_modalities` 全为 text 的文本模型。RunPod 跳过无库存档，并丢掉低于同型号中位 40% 或下限的小时价，原因写入 Worker 日志。Vast 按 H100 SXM / NVL / PCIE 分开查询，计入 verified 与 unverified，样本少于 3 条不展示，页面写出条数。解析版本 `compute-prices-2`，不新增 migration。需重启 Worker，并重载 Web。见 `compute-prices-v1.md` 与 `progress/2026-10-12-compute-price-filters.md`。

2026-10-12 全球行情新增「AI Token」：OpenRouter 公开型号价换算为每百万 token 美元，RunPod 保存 H100/H200/B200 安全云和社区云小时价，Vast 公开挂牌有整卡 H100 时保存最低和中位。migration 55。`market.token-prices.snapshot` 默认每天 08:20（Asia/Shanghai），`market.gpu-rent.snapshot` 默认每 360 分钟。开关是 `AI_CENTER_TOKEN_PRICE_SYNC`、`AI_CENTER_TOKEN_PRICE_AT`、`AI_CENTER_TOKEN_PRICE_TIMEZONE`、`AI_CENTER_GPU_RENT_SYNC`、`AI_CENTER_GPU_RENT_INTERVAL_MINUTES`。需重启 Worker，并重载 Web 后 `#market/global/compute` 才显示。未在生产抓取，不宣称租金覆盖全市场。见 `compute-prices-v1.md` 与 `progress/2026-10-12-compute-prices.md`。

2026-10-12 小时报与日报可靠性：Gemini 小时调用遇到 500/503 先退避再换 `AI_CENTER_GEMINI_HOURLY_MODELS` 中的下一个模型；未知或重复输入归属先修正，修不好再换模型。同一小时失败达到上限后记终态，不再反复入队。运行超过时限的任务标失败并放开队列，Worker 启动时也会回收。日报单标签超时改为部分发布，当天没有刊期会稍后重试。补 2026-10-12：`node --env-file=.env scripts/backfill-daily-report.mjs --date 2026-10-12`。需要重启 Worker。见 `progress/2026-10-12-report-reliability.md`。

2026-10-12 TrendForce NAND 公开页本身停在 2026-09-28；解析把日高／日低折进规格，且标题去掉 `US$/chip` 后新行待核验。`trendforce-tables-3` 修正规格与盘列，DRAM／NAND 未税现货和合约记 USD/chip。migration 54 记录每次抓取与内容是否变化。Worker 默认每天 10:30、17:30（Asia/Shanghai）跑 `feed.trendforce.prices`，可用 `AI_CENTER_TRENDFORCE_PRICE_SYNC`、`AI_CENTER_TRENDFORCE_PRICE_AT`、`AI_CENTER_TRENDFORCE_PRICE_TIMEZONE` 调整。B 站订阅是贴链接，不是时间线；无自动刷新时记一次 `bilibili-link-only` 心跳，不拉新视频。需重启 Worker，Web 重载后才显示币种和抓取提示。未在生产重抓，不宣称 NAND 已有 09-28 之后的公开报价。见 `hardware-prices-v1.md` 与 `progress/2026-10-12-trendforce-nand-fetch.md`。

2026-10-10 窄屏吸顶二级标签条的背景改成整行宽度，股票横滚指数卡和全球行情表下滚时不再从「简报」右侧露出。纯前端，不需要重启。见 `progress/2026-10-10-overview-sticky-nav.md`。

2026-10-10 侧栏与手机底栏的「总览」都一律打开 `#sources`，不再按二级菜单轮换。宽度小于 1200px 时，信息流筛选行吸在总览二级标签条下面；标题栏和二级标签条用不透明底盖住股票/全球行情的横滚卡片。工具页说明文字留出上边距。纯前端，不需要重启。见 `progress/2026-10-10-overview-sticky-nav.md`。此前底栏落点见 `progress/2026-10-10-mobile-nav-chrome.md`。

2026-10-07 用户后续授权 Gemma 31B/26B 专用原文翻译，替换原翻译供应商路由且不回退其他模型。Worker 排队、原文分段、排版、缓存复用和译文事务落库已实现；912项检查通过，在线备份和安全重载完成，19条暂缓任务恢复。真实已采集原文经202→Worker→落库→回读通过，实际31B失败后26B接续成功，用量记录仅两种Gemma。31B 新适配器实测仍有 500/流内错误，不冒称31B稳定或全长文质量验收完成。中文整理、Tag、小时/日报仍用原模型；详见 `gemma-original-translation.md` 和 `progress/2026-10-07-gemma-original-translation.md`。

2026-10-07小时定时恢复：定时器正常但提前生成的空ready挡住正常partial，准备积压与历史补编争抢导致空稿/延迟。现已纠正发布完整度保护、拒绝未结束小时，单篇准备成功后有限补编，最新整点先于历史；历史模型低优先级与8分钟预算。原队列26个未领取批次已通过事务拆成142个逐篇子任务，原输入/记录及running保留。安全备份并正常重载，850/850检查通过；08—09点空稿纠正与10—11点2模块/3信息稿正式发布及390/1440px引用回读通过。最新窗仍partial、25条信息待补，原Worker继续处理，不能称积压全部清空或完整报告验收。见`progress/2026-10-07-hourly-publication-recovery.md`。

2026-10-07用量工具与社媒入口修复：只读model.usage.get已接现有Harness ToolRegistry/Gateway并在真实新问答实际调用；直接X/雪球及Web采集保存后通过信息准备Port接入三层树，保留入库JEV与原发布时间。在线备份、暂缓queued和等待running自然结束后已正常重载生产，原队列/定时恢复，新Skill/目录已加载。全仓840/840；3份定向X输入2成功1内容不足，同输入复验零新增请求；对应真实小时发布10模块、2条X消息进入直接ref，390/1440px回读版本一致。刊期partial待补7，4份X仍在原队列，不能称历史社媒或完整小时全部齐备。本轮12请求/91942已报告Token，供应商费用未知。见`progress/2026-10-07-usage-tool-social-chain.md`；该项覆盖下文“本轮后台尚未重载”的等待状态。

2026-10-07指定小时修复：tree-v3主入口、方向模块展示、自动版本接受、标题对象保护、通信/数据中心目录与受影响信息稿分类、合格短小时直通及真实Job摘要已实现；836/836与390/1440px受控自动更新验证通过。用户随后要求立即完整采集、加工和落盘，原09:10后续执行已取消；既有注册采集任务已实际执行，定向信息准备8篇成功，小时浓缩在现有Harness Worker中执行。正式入口增加滚动升级兼容，旧后台未返回pipeline时依据独立tree-v3.1信息头进入树，新稿已可读；不打断在途任务强制重载。实例及外部时钟仍为北京时间凌晨，不能把当前实际窗口冒称指定09:00—10:00。新后台策略尚未重载，真实小时结果另行记录，不宣称完整刊期验收。详见`progress/2026-10-07-tree-hour-repair.md`。

2026-10-06 tree-v3.1审核修复：完整快讯预检、主分类/阅读归组、独立信息准备、负缓存与原因、分组恢复、提示词/配置版本和事务发布约束已实现；全仓830/830、13宽度三层39项UI通过。12份A/B/C对照、18份保存完整正文17成功、三类各两次重复及两份合成语义边界实际回放完成，100实际请求/455020已报告Token，旧76次排除。长文取舍仍有超长和AIDD重复漏必要条件，日报partial，不能宣称整体语义稳定或全期覆盖。现有启动器在本轮期间尝试重启，迁移43已执行，Worker碰到临时修改中代码后退出；代码已修复；用户随后明确授权重启，23:10在线备份后通过原启动器恢复，8787健康检查通过，注册的信息准备任务已运行。新隔离稿未导入生产，旧数据及设备保留。详见`progress/2026-10-06-tree-v3-next-round.md`。

2026-10-06 用户授权三层浓缩树重构：固定三份Skill经现有封闭Harness调用，前向迁移42、独立缓存与租约、逐层版本ref、三层只读阅读入口和单一回退开关已接入。仓库默认legacy；用户后续明确要求直接接入，本机Instance已备份、迁移并启用tree-v3，正式Web/Worker已重载，正式页39项检查通过，最新小时加工已开始。真实保存材料的回放及接入记录以`progress/2026-10-06-information-tree.md`为准，不能将合成结构测试或两小时链路回放宣称全天验收，2篇缺内容及249字教程稿偏长仍保留真实限制。设计覆盖见`information-tree-v3.md`，不替代整体发布门槛。

2026-10-06用户授权模型用量账本：本地安装包原生正常/失败/同step重试验证后，复用冻结Harness的token-meter、SDK原始通知/最终事件及官方只读JSONL backend；migration41仅保存脱敏请求归因和查询索引。Elucid搜索400重发、翻译/打标回退在实际HTTP边界单独记录，本机任务页支持查询，未知费用不补零。没有生产模型调用、历史全量导入或运行库迁移/服务重启，需正常重载生效；不宣称供应商对账或所有内部插件请求全覆盖，详见 `model-usage-v1.md` 与 `progress/2026-10-06-model-usage.md`，不替代整体发布门槛。

2026-10-06小时调度与状态修复：常规任务按实际执行时钟优先最新已结束小时，旧稿仅在独立8分钟预算内补一个，失败30分钟冷却；同一Harness串行准入支持固定优先级和等待项取消，排队/执行截止及耗时分开，保留检查点与原引用。目录显示全部已结束小时及处理阶段，旧稿可读与最近失败分开，最新发布截止独立显示，首读按时间选择可读稿而非偏好旧新版。实库已确认原预算耗尽、编辑failed底稿与模型间歇PI_AI_ERROR；包装层透传实际终止错误，拒绝中止部分答，不作额度归因。781/781全仓检查、13宽度合成检查及最终真实375/390/502px回读通过；13—14点14:46已发布8条底稿/2篇文章、5组冻结引用可读，11—12点11条原底稿纯编辑恢复且引用未变，页面最新发布到14:00，本机服务已加载最终修复。仍有28份材料未完整读取，旧缺稿逐步补处理，不宣称24小时全部补齐或供应商故障消失。见`progress/2026-10-06-hourly-scheduling-and-status.md`。

2026-10-06 用户要求从方向主题列表改为方向文章：新版`brief-editorial-v3`保存稳定方向身份、独立标题/导语、小标题与逐段冻结引用，阅读主序为方向→报告期→一篇文章；同窗切方向、准确空态、整篇收藏/引用、段落依据及旧稿兼容保留。原封闭 DeepSeek Harness / Elucid Grok 完成指定19—20点96条冻结底稿的纯重编，创建新快照，不重抓/重译/重提炼；29条采用、67条底稿可查，旧稿与全部原引用不变，25组冻结引用解析通过。样本重点核对微软论点/两项指标及季度、世界模型机制、单条重大传闻不置顶、融资计划/审批与作者归属；不等于全部来源事实核验。全仓774/774、13宽度合成检查和最终真实375/390/502/768/1440px回读通过，冷缓存站内原文、返回位置及文章引用隔离通过，本机服务已加载；其余旧时段仍按常规任务补编，11份未完整读取材料继续显式保留。不新建线程、Agent或Runtime，不替代整体发布门槛；见`progress/2026-10-06-direction-articles.md`。此条覆盖下文v2主题正文的主阅读方案。

2026-10-05 用户要求小时层完成编辑：现有冻结 DeepSeek Harness 的封闭小时任务固定接 Elucid Grok，先提炼再整小时合并为总览、方向和主题；全部底稿与冻结证据保留，未采用事项不追加正文，日报可使用小时主题与全部底稿。来源直接进入站内原文，未缓存媒体按保存 ID 读取，提炼依据为次级入口。运行服务16—22点六份存量小时均已补编；19—20点96条底稿形成10个主题、37组证据校验通过，未完整读取材料显式保留。全仓770/770、13宽度合成检查及真实375/390/502px回读通过，真实媒体冷缓存9段全文恢复通过。不新建线程、Agent或Runtime，不宣称来源全覆盖或整体发布通过；见 `progress/2026-10-05-hourly-editorial-and-source-navigation.md`。此条覆盖前轮将原子事项直接作为小时正文的方案。

2026-10-05 用户纠正硬件报价体验：取消独立入口和卡片目录，改为全球行情“AI硬件”分类、统一行情行及报价均价折线；真实单期不造走势。修复日高低点误入规格并显式重解析八份已存 HTML，旧内容、状态和快照保留，当前 41 个规格（37 主硬件、4 其他存储），无错误名称或重复历史版本混排。当前真实系列没有多期历史，币种／单位仍待核验，不算可比涨跌。全仓 770/770、六宽度行情与阅读回归、当前运行服务回读通过，代码已通过启动器加载。此项覆盖前文独立目录方案及待重载状态，不替代整体发布门槛；见 `progress/2026-10-05-hardware-market-integration.md`。

2026-10-05简报后续已完成真实数据恢复与阅读减法，并加载到运行服务：16—20点四个小时187条摘选、158组冻结证据全部可读，已有7条日报及其原成稿引用保留。后续批次失败保留成功结果和未读范围，失效租约不显示为正在处理；顶部只留文字切换、日期、更多，工具/时间/管理折叠，旧V2兼容渲染简化，修复读取态闪现。全仓758/758与13宽度合成浏览器通过；真实服务375/390/502px首屏正文位置和引用验证通过。四份小时结果仍有未完整读取材料，真机及真实提炼语义验收未完成，不宣称整体发布通过。见 `progress/2026-10-05-brief-data-recovery-and-reading.md`。此条更新前一轮界面等待服务重载的运行状态。

2026-10-05 用户授权 TrendForce 按内容类型归位：文章/报告简介进入科技产业，结构化报价进入全球行情 AI硬件价格，保留来源与旧身份；migration 40 新增报价快照/修订，日报读取真实完整度。已在线备份并显式迁移 51 条旧内容（49 媒体、2 价表、41 个待核验规格），原文和用户状态指纹不变，重复导入零新增。`npm run check` 757/757、两宽度专用 UI 和既有阅读回归通过；运行中的小时简报未被中断，常驻服务待正常重载后加载新 API/Collector，不据此宣称已上线或整体验收完成。见 `hardware-prices-v1.md` 与 `progress/2026-10-05-trendforce-content-routing.md`。

2026-10-05按用户提供的设计改造日报阅读界面为「简报」：小时更新/日报精选、完整信息句、冻结来源面板、设备本地已读/收藏、只读版本检查与响应式排版。复用Report边界，新增轻量小时清单和指定成稿统计窗口读取，不改变生成预算/频率、过滤或权限。最终`npm run check`754/754及12宽度×2视图合成浏览器、既有UIUX回归通过。运行中的小时提炼尚未结束，未强制重载Web/Worker；旧Web尚未注册新模块时保留原阅读组件，不中断App启动。新界面待安全重载后生效；真机与真实内容语义仍待专项验收，见 `progress/2026-10-05-brief-reading-ui.md`。

2026-10-05 用户授权信息摘选：新增小时信息句＋逐项冻结段落引用，新日报复用事项、合并排序并保存全部清单；首页1000字符仅为展示预算。复用现有 Worker/Report Repository/Harness，前向 migrations 38/39 保存不可变版本与当前小时发布指针。旧稿兼容，未读、失败和超预算编排明确。`npm run check` 739/739 通过，真实 Harness 合成样本保留限定并成功读取证据；未向生产库写入或重启服务，实际来源语义、持续运行与移动端排版仍待专项验收。见 `information-digest-v1.md` 和 `progress/2026-10-05-information-digest.md`；不替代整体0.2.0发布门槛。

2026-10-05当前入选池已执行正式刷新：每社交来源最近200条与全部已存媒体索引，共1659条，1156 KEEP / 258 DROP / 245 REVIEW；后两者503条退出入选流，原始采集保留。330条复用相同评分，1247条请求JEV，82条预检待补。9个来源/栏目实际API回读全部符合三项>=0.60，未评分旧内容与空池快照/示例回退不能旁路，Tag不再决定显示。全仓725/725通过，见 `progress/2026-10-05-feed-current-pool.md`；这是当前阅读池刷新，不是全历史重新评分。

2026-10-05最新用户决定覆盖二选三：生产 `all-three-0.60`，保存价值/具体程度/信息充分程度三项全部 >=0.60 才进入内容库与新闻池；DROP/REVIEW/接口失败均不放行，原始Capture留底。2632条更新后1069 KEEP/579 DROP/984 REVIEW；40条输入变化不套旧分数，当前原始采集隔离待重评。既有原文及用户状态未删除。旧二选三报告保留为历史，见 `progress/2026-10-05-feed-value-all-three.md`。

2026-10-05按用户后续要求调整主导航：总览首次进入信息流，重复点击按二级菜单轮换；资产首次进入持仓，重复点击在持仓与个人资产分析间切换。用户确认末项为日报。全仓721/721与合成浏览器导航回归通过；这一明确选择覆盖上一轮总览固定落点。见 `progress/2026-10-05-primary-nav-cycle.md`。

2026-10-05完成 UIUX 评审中的阅读返回与宽度、移动阅读操作栏、导航/搜索范围、读取四态与重试、稳定工具入口、窄屏数字列及资产图表整改。全仓检查719/719与合成数据无头浏览器回归通过，当前静态资源已生效，未中断后台任务。iOS/Android 真机、真实软键盘及缩放仍待用户验收，不据此声明整体发布通过。见 `progress/2026-10-05-uiux-reading-navigation.md`。

2026-10-05后续用户明确改为生产 enforce，保存价值/具体程度/信息充分程度至少两项严格 >0.60，取消主题门槛，Tag 后处理、无 Tag 可读。社交与媒体索引/正文入口共用规则。旧 V3 校准 `productionQualified=false` 保留，新规则是用户选定策略、不冒称独立验收。2632 条相同五问评分重算为1370 KEEP / 420 DROP / 842 REVIEW，历史重分类只应用当前输入一致的2592条，其余40条输入不一致不复用评分；原文和用户状态保留。详见 `feed-value-v3.md` 与本轮进度记录。原 A/B/C 与1737/114/781分布仍为冻结历史。

2026-10-05修复媒体阅读中后台刷新导致中文自动切英文：当前阅读会话保留已载入的中文版本，换版提示后主动切换，缺段显示翻译进度；不增加持久缓存、采集任务或数据库修改。用户暂停图片功能，相关实现已撤回且未向运行库写图片。全仓检查709/709通过，现有服务已提供新阅读逻辑。见`progress/2026-10-05-media-reader-language.md`。

2026-10-05按用户研究建议扩充新闻栏目：八个新RSS入口及已有THE ELEC入口校正均经本机抽样与Service探针启用，活动额度兼容扩到24（本Instance占用22）；现有Worker首轮新增125篇索引、其中116篇已存全文，译文/Tag继续后台处理。历史ID与已读/隐藏状态保留，全仓检查693/693通过。该专项不替代整体验收，也不宣称直播、Yahoo新模块或付费全文已接入。见`progress/2026-10-05-media-source-expansion.md`。

2026-10-05：JEV入库质量V2完成昨日自然日只读shadow（2632条、200条AI辅助复核），生产V1 shadow未切换，网页媒体仅离线评估。三组初始阈值都未通过高价值保留/垃圾拦截/待定损失的整体目标，禁止将这次分布当成生产enforce验收。具体结果和边界见`progress/2026-10-05-jev-quality-shadow-v2.md`；不改日报、Tag分类和10／10／20预算。

当前工作以本文为准。`docs/plan/` 与 `docs/progress/` 是历史，不重新驱动开发。

## 当前基线

仓库版本是 **0.2.0 基线候选**。局域网连接、配对、快速发布和 SSE 已经跑通，不再把「第一版连接原型」当作当前范围。

当前要完成的是隐私、安全和稳定性验收，**不继续扩大功能**。量化实验室 V0 是单独授权的范围例外，只跑通一条 Qlib 研究基线，说明见 `docs/quant-lab-v0.md`。不加 Intent Router、不多 Agent、不换数据库体系。Ask / 文章阅读的生产执行器是冻结 DeepSeek Harness；不在这轮设计资料搜索插件。本地循环只作测试注入或显式回退。0.2.0 发布门槛仍是隐私、安全和稳定性，不因此扩大产品功能。

成功标准仍包括：重启后 Capture / ContentItem / 设备授权仍在；更换采集或行情实现不改页面 Contract。

## 已实现、待验收（不要写成「尚未开始」）

| 主题 | 文档里容易写错的说法 | 当前事实 |
|---|---|---|
| 产品范围 | 根 README / AGENTS 仍以连接原型为当前范围 | 0.2.0 基线候选，进入隐私、安全和稳定性验收 |
| 同花顺 / 雪球 | 尚未接入行情 | 沪深/港股通/B 股现价优先雪球批量行情；同花顺快照作缺票回退。延迟与风控需验收 |
| AI | AI Worker 后续接入 | 已有单 Agent / Worker；生产执行器是 DeepSeek Harness。文章阅读是 Article Analysis Skill（`ai.article.analyze`）：复用同一套执行器，不改普通问答 Tool Loop |
| 鸿蒙分享 | 分享详情页加载远端 ArkWeb | 原生分享先写本地 RDB Outbox；主 ArkWeb 恢复授权后上传 |
| 翻译 / Tag | 仍走豆包网页或手动 CLI | 自动翻译和粗筛 Tag 走 Gemini。生产 Ask 的公开互联网是 Harness 内置 `web_search` / `web_fetch`。默认启动不再创建 DeepSeek Search Provider、`search.web` 或 Domain `web.search`。这些与豆包补充检索只留给本地循环回退。SearXNG 保留代码，主链路不调用。豆包翻译 / 标注不恢复，历史译文 / Tag 行保留 |
| 下一步 | 固定做 B4 关注同步 | 先完成发布门槛，不继续扩大功能 |
| 持仓 | 加减仓都产生交易流水 | 仍是手工批次账本（`HoldingLot`），不宣称完整流水会计 |
| Instance | 已实现多用户 / 多租户 | 仅完成 single-user Instance 边界；没有 User、Tenant、权限后台或动态扩展加载 |
| 静态信号源 | 宏观日历仍只是未来占位 | 已注册 17 个中美宏观、央行、会议和政策官方源，并提供确定性聚合首页；SCIO 使用已明确接受的官方 HTTP 列表，GACC 在当前主机仍受官网证书链影响降级为 unavailable |
| 市场原生源 | 与官方日历混成一类或自动解释成预测 | 已注册 Polymarket、Kalshi、Hyperliquid、DefiLlama 只读 Snapshot；场所报价保持分离，真实网络可用性与字段漂移仍需逐源验收 |

B站贴链接抓 AI 中文字幕已接入。关注 UP 列表同步不是本轮范围。

## 本轮验收方向

2026-10-04用户授权日报V2：分来源分页与直接正文、四轮同Harness分析、追踪问题、
阶段续跑、跨来源正文与版本证据已经实现。真实回放与预算修复记录见
`docs/progress/2026-10-04-daily-analysis-v2.md`；未读量、缺正文、无追踪配置及关闭联网保持显式，
该专项验收不替代0.2.0整体发布门槛。

2026-10-02 媒体正文稳定性修复在 `docs/progress/2026-10-02-media-body-audit.md` 记录逐篇
响应、失败、预算和版本核对。DCD / Next Platform / Decoder 与已有美联储来源走同一正文闭环，
BBC / FT 继续按实际用途限制保留索引。该验收不扩大信源数量或 Agent Runtime。
随后用户明确授权全文阅读闭环，见 `docs/progress/2026-10-02-media-reading-pipeline.md`：
全文分段翻译、X标签、每小时检查和阅读排版已实测，25篇全文均完成译文和标签；
Techmeme仅接入两家登记原报道，宏观全文4篇，其他摘要/受限线索保持真实等级。
该授权不改变Agent Runtime或其安全边界。
2026-10-03按用户要求补齐媒体已读持久化与分页前下移，并把已有六类官方发布能力接入
宏观媒体正文流程；日历仍只产生日程。宏观已验证全文由4增至20，完整译文与标签均已落库，
Federal Register正文受跳转限制保持失败。来源回看窗口和轮流抓取仍受原每日预算约束；
验证及并行工作区检查结果见 `docs/progress/2026-10-03-media-read-state-official-releases.md`。
本地提交前补充处理启动器身份边界与真实工作簿集成测试：未记录进程须精确匹配入口和Instance身份，资产测试逐行核对源工作簿而不锁死历史期数。提交检查结果见 `docs/progress/2026-10-02-local-commit.md`；媒体专项测试通过仍不等于整个0.2.0发布验收完成。

2026-10-03按用户授权落地经济与国际新闻公开入口第一版，复用现有媒体链路与BrowserRuntime。
宏观可验收全文35篇（含15篇新增新闻/周报），科技37篇，全站72篇正文中文译文已完成。
新增15篇Tag受Gemini当日额度耗尽影响待补，不能宣称全文Tag全部验收通过；正文继续可读，
enrich明确报告partial。新闻API仍未申请，FT主站/WSJ/Economist未宣称已取得批量全文。
全仓检查641/641通过，范围与用户验收路径见`docs/progress/2026-10-03-media-public-news-v1.md`。

- **隐私与迁移**：当前私有仓库提交可移植的 Instance 文件内容（Knowledge 文件、个人 Catalog、必要导入资料与附件）；运行 SQLite 数据库只在本地保存和更新，通过独立的一致备份恢复，不再提交 Git，也不启用 LFS。不提交 `.env`、API Key、Token、Cookie、浏览器 Profile、WAL/SHM、PID、运行日志或真实公网 Hostname。设备凭证服务端只存哈希。停止数据库跟踪与未发布超限提交修正见 `docs/progress/2026-10-02-local-database-git.md`。
- **Instance 边界**：进程启动不灌入个人持仓；Market / Tag / Taxonomy / Knowledge / imports 通过统一 Instance 路径；V16 Taxonomy 只作 Legacy Bootstrap；Browser / Search 仍是 Host 服务。
- **安全**：对手机只开放 Web/API；Worker、SQLite、浏览器调试口、Search Worker、旧仓服务只听本机。公网模式遵守 `docs/public-access-security.md`。二维码只带一次性配对码。已配对不等于 Host 编码权限：公网 Ask 不得使用 bash / 写盘 / subagent，也不得派发 Cursor CLI。调用方能力平面已写入设计；实现收口另做，不在本轮扩功能。
- **稳定性**：`npm run check`；重启后数据与授权仍在；SSE 可按 `Last-Event-ID` 补发；换 Adapter 不改页面字段。
- **Harness 运行状态**：Ask / 文章阅读的 Job 状态继续以 SQLite 为真源；Harness `session.event` / `session.status` 只进入脱敏的 Agent Run 进度投影。`GET /api/v1/agent/runs/:id` 和 SSE 不读取 DSH 私有 JSONL、Session Query 数据库或 Host 路径。真实 Harness 事件结构必须有端到端测试，不能只用扁平假事件证明进度可用。
- **静态信号源**：BEA TBA、Census Suspended、NBS 单月双日期与 GACC 年度缺失/日期精度已有确定性测试；官方固定规则生成项必须显示为 tentative；来源不可达时降级为 unavailable/partial，不能回填第三方预测数据。SCIO 的 HTTP 例外必须保持 URL 级隔离；GACC 的真实网络可用性仍需在官网证书恢复或另一受信网络环境复核。
- **市场原生源**：逐源核对公开 API 的字段与限速；不得把两个预测市场报价合成“真实概率”，不得把 tokenized / derivative 价格当官方股票现价；Funding、OI、Volume、Supply 的单位必须在页面可辨认。

Local Files MCP / Tailscale Funnel 不是 AI Center 公网入口，也不列入本产品发布范围。操作说明不得写入真实 Hostname 或本机路径。

## 不要一键批准无关补丁

2026-10-04按用户方向修正为原生媒体频道采集，取消主题关键词/标题评分，Yahoo Economy合并入口且保留历史身份、已用额度和阅读状态。migration 36保存频道发现及策略版本，受控重新解析恢复40条媒体索引。全仓检查648/648通过；重载后的长驻Worker真实重跑新增索引/正文请求/媒体译文新增改写均为0。当天正文请求在验收前已达96/96，本轮新正文首末段原站抽检尚未完成；Yahoo未验证出版商仍待适配。不能把索引与回归通过写成新正文已全部验收。记录见`docs/progress/2026-10-04-media-native-channels.md`。

Cursor 待处理文件操作里，可能混有更早的 Agent 补丁（例如不同版本的 `feed.tagged` / `feed.tag.search`、Runtime、Contract 和测试）。部分基于旧代码。批准全部待处理操作，可能把已经调整好的单 Agent 实现覆盖回旧方案。本轮只收束文档，不应用那些补丁。

后续取消每日配额已生效：npm run check 650/650通过；长驻Worker的实际请求计数已超过旧96次限制，新增保存146篇完整正文。历史文章身份与已读/隐藏状态保留，翻译及打标仍在现有Worker后台处理。此结论验证配额解除和正文落库，不替代逐篇原站首末段抽检。

2026-10-04翻译与打标改为Gemini优先，实际429/RESOURCE_EXHAUSTED时回退Elucid Grok；DeepL/Google翻译调用已移除。全仓检查664/664通过；受控429+真实Elucid API验证译文、Tag落库及译文缓存。正常Launcher重载后Web/Worker已加载新代码，线上翻译接口实际Gemini响应正常，健康检查通过。见docs/progress/2026-10-04-gemini-grok-fallback.md。

2026-10-05修复日报最终成稿180秒反复超时与沪深A/B股行情时间失真。
成稿输入精简、截止360秒且调用期间续租；生产resume复用已完成阅读，10月5日日报已恢复。
行情保留来源报价时间，沪深按已核验2026年交易所日历及午休显示休市原因/下次交易，
没有报价时间或未核验年度保持显式未知。旧冻结行情版本不重写。
最终全仓检查680/680通过，真实API及回放结果见`docs/progress/2026-10-05-daily-recovery-market-calendar.md`。
## 三层浓缩树隔离验收补充（2026-10-06）

用户授权的新链路已接入，默认仍为legacy，生产未切换。全仓检查814项通过；真实24篇固定样本中22篇有效信息→14小时模块→9日报模块，2篇缺内容保持pending；页面13宽度×3视图共39项通过。三篇完整正文中一篇教程稿249字仍偏长，不能把本轮写成全天日报或生产验收全部完成。记录见`progress/2026-10-06-information-tree.md`。
## X 单条点赞试用（2026-10-07）

用户单独授权 BrowserRuntime 路线：已保存 X 推文阅读页的「在 X 点赞」提交固定 `feed.x.like` Worker 任务，不要求官方 API 凭证。只接受当前 workspace 的 ContentItem ID，原帖精确定位、已点赞幂等、重开原帖核验；不开放关注、批量操作或 Harness 写入工具。浏览器登录态只留 Host，结果不返回 Cookie 或执行命令。设计见 `feed-interaction-v1.md`。全仓861/861、隔离浏览器夹具与真实390/1440px阅读页显示通过，已等待运行任务完成后重载Web/Worker，242项临时延后任务全数恢复。真实只读页面定位已通过；真实点赞仍由用户指定内容点击验收，不据此声明稳定性长期验收或整体发布通过。

2026-10-07用户授权Gemini信息层接入：一次Harness生成中文标题/Tag/摘要/正文，三Key按项目配额持久化限流、显式quota冷却及Grok fallback，小时/日报正常半点生成且日报截止不变。879项检查通过，备份及原启动器安全重载完成，267个暂缓任务恢复；三Key项目关系未确认，保守共享桶，不称三倍额度或历史积压清空。见`gemini-article-normalize.md`与对应progress。
