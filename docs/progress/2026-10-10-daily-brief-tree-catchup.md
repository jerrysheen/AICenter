# 2026-10-10 日报 brief 改读树刊期，并修首页与简报页

## 现象

10/6 起生产走 tree-v3。首页和按日期打开的日报 brief 仍读 `daily_report_briefs`，这条表只有 legacy 写入，所以最新一份停在 10/5。`#report` 的树刊期本身有更新。

首页时间轴在重渲染后会丢掉已经取回的 reading-hour，退回索引里的一条标题，节点数和「更早 N 期」跟着变。16:00–17:00 这一期的标题应打开 `#report?hour=16`。标题被单行截断。简报页标签栏滚动时透字，从小时报切到日报后地址仍留着 `?hour=`。

日报补跑和整段会话预算这次不动。10/7 起不出刊是因为每个 Tag 的 `daily-analysis` 打在 Elucid `grok-4.7` 上，单次执行 180 秒被 `ModelExecutionTimeout` 掐断，任一 Tag 失败就把整期标成 `failed`，`published_id` 不再更新。

## 日报模型、超时和部分出刊

`daily-analysis` 未单独配置时跟小时报。生产小时报已是 `AI_CENTER_HARNESS_HOURLY_PROVIDER=google`，所以日报默认也是 Google `gemini-3.1-flash-lite`。要单独改日报，用：

| 变量 | 未设置时 |
| --- | --- |
| `AI_CENTER_HARNESS_DAILY_PROVIDER` | `AI_CENTER_HARNESS_HOURLY_PROVIDER`；小时报也未设置则仍走主模型。允许 `google` 或 `elucid-grok` |
| `AI_CENTER_HARNESS_DAILY_MODEL` | `AI_CENTER_HARNESS_HOURLY_MODEL`，再没有则 `gemini-3.1-flash-lite` |
| `AI_CENTER_DAILY_EXECUTION_TIMEOUT_MS` | `300000`。只拉长日报浓缩的单次执行，小时报仍是 180 秒 |

白名单、模型池、Key 和输出上限同样先看 `AI_CENTER_GEMINI_DAILY_*` / `AI_CENTER_HARNESS_DAILY_MAX_TOKENS` / `AI_CENTER_HARNESS_DAILY_KEY_ENV`，没有再沿用小时报。Google 准入与小时报共用同一配额账本。

部分 Tag 成功时，日报刊期记为 `partial`，只发布成功 Tag 的根节点，并写入 `published_id`。全部 Tag 失败仍是 `failed`，不替换上一份已发布刊期。小时报任一分组失败仍整期不发布。

`GET /api/v1/reports/daily/latest/brief`、`/daily/brief`、`/daily/briefs` 只读 `row.edition`（`published_id`）。未发布的 `attempt` 不会被当成当天日报。`#report` 日报标签同样只选已发布 edition。

## 页面上的处理状态

首页时间轴、小时报标题和小时列表、行情卡、全球行情、简报不再展示「命中 N」「已处理 N/N」「更新于…」「已延迟…」「N 期未生成」。保留时间段和正文。加载中仍用骨架，不写未生成计数。

## 改动

`GET /api/v1/reports/daily/latest/brief`、`/daily/brief?date=`、`/daily/briefs`：流水线是 tree-v3，或近 7 日已发布 daily tree edition 的上海日期比 legacy brief 新时，用已发布 `row.edition` 和根模块拼 brief。`reportDate` 取 `window.endAt` 的上海日期，`informationItems[].sentence` 为 `标题：正文`。指定日期没有树刊期时仍回退该日 legacy brief。首页日报卡仍走这几个接口，没有另写读取路径。

首页时间轴的链接小时取 `window.startAt` 的上海小时，不取 `endAt`。阅读小时索引不能覆盖已经带 `items` 的快照；同一份缓存下最新一期最多 5 条标题，其余最多 2 条。刊期索引还没到时只画骨架，不写「未生成」。标题按正常换行，不再单行省略。

日报条目、小时报条目和首页时间轴节点的标题去掉单行省略和行数截断，按全文换行。信息流卡片和其他排版不动。

简报标签栏和控件行贴在标题栏下，背景不透明。切到日报时去掉地址里的 `hour`。搜索按钮在简报页写「搜索简报」。手机底栏在简报页不再把「总览」标成当前页，当前项是二级栏的「简报」。官方来源和「官方来源暂不可用」改成 12px、更深的字色。「今天」与标签栏留 14px。信息流「日程 ›」贴齐右缘，空状态占满内容宽。小时报行只留时间段，不再写「已处理 N/N」或「命中 N」。

## 验证

`npm run syntax` 通过。`npm test` 1050 项：通过 1039，失败 10，跳过 1。失败数没有超过 main 基线 10：分析技能 7、信息树策略 1（`changed information policy leaves explicit pending`，改动前的提交上同样失败）、model-usage 的 zstd（本机 Node 22.14）、本机没有 Cursor CLI。新增测试覆盖日报沿用小时报 Gemini、单次超时 300 秒、部分 Tag 出刊，以及 brief 不读未发布 attempt。

用无头浏览器在 390px 量了样式：标签栏 `position: sticky`、白底；标题 `white-space: normal`；「今天」上距 14px；空状态与信息流同宽，「日程 ›」右内边距为 0。小时报行只留时间段。没有连上已登录服务端逐页点选。
