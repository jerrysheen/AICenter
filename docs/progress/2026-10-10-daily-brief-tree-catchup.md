# 2026-10-10 日报 brief 改读树刊期，并修首页与简报页

## 现象

10/6 起生产走 tree-v3。首页和按日期打开的日报 brief 仍读 `daily_report_briefs`，这条表只有 legacy 写入，所以最新一份停在 10/5。`#report` 的树刊期本身有更新。

首页时间轴在重渲染后会丢掉已经取回的 reading-hour，退回索引里的一条标题，节点数和「更早 N 期」跟着变。16:00–17:00 这一期的标题应打开 `#report?hour=16`。标题被单行截断。简报页标签栏滚动时透字，从小时报切到日报后地址仍留着 `?hour=`。

日报补跑、重试和生成预算这次不动。

## 改动

`GET /api/v1/reports/daily/latest/brief`、`/daily/brief?date=`、`/daily/briefs`：流水线是 tree-v3，或近 7 日已发布 daily tree edition 的上海日期比 legacy brief 新时，用已发布 `row.edition` 和根模块拼 brief。`reportDate` 取 `window.endAt` 的上海日期，`informationItems[].sentence` 为 `标题：正文`。指定日期没有树刊期时仍回退该日 legacy brief。首页日报卡仍走这几个接口，没有另写读取路径。

首页时间轴的链接小时取 `window.startAt` 的上海小时，不取 `endAt`。阅读小时索引不能覆盖已经带 `items` 的快照；同一份缓存下最新一期最多 5 条标题，其余最多 2 条。刊期索引还没到时只画骨架，不写「未生成」。标题按正常换行，不再单行省略。

简报标签栏和控件行贴在标题栏下，背景不透明。切到日报时去掉地址里的 `hour`。搜索按钮在简报页写「搜索简报」。手机底栏在简报页不再把「总览」标成当前页，当前项是二级栏的「简报」。手机上「命中 N」、官方来源和「官方来源暂不可用」改成 12px、更深的字色。「今天」与标签栏留 14px。信息流「日程 ›」贴齐右缘，空状态占满内容宽。手机小时报把「已处理 n/n · 命中 n」放到下一行。

## 验证

`npm run syntax` 通过。`npm test` 1046 项：通过 1035，失败 10，跳过 1。失败数没有超过 main 基线 10：分析技能、信息树策略、model-usage 的 zstd、本机没有 Cursor CLI。新增测试覆盖 16:00 窗口链接到 `#report?hour=16`、加载中不写「未生成」，以及索引刷新不覆盖已有 reading-hour 快照。

用无头浏览器在 390px 量了样式：标签栏 `position: sticky`、白底；「已处理 · 命中」`flex-basis: 100%` 换到下一行；标题 `white-space: normal`；「今天」上距 14px；「命中 N」12px、`#4e5968`；空状态与信息流同宽，「日程 ›」右内边距为 0。没有连上已登录服务端逐页点选。
