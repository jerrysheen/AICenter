# 2026-10-10 启动按页加载

`#sources` 授权后不再挂载简报阅读器，也不再预拉 X、雪球、B 站、笔记和知识库。各页在第一次进入时加载自己的数据；已经加载过的页面复用内存结果，手动刷新和已加载数据的 SSE 补拉仍然生效。

离开简报时 `briefPage.stop()` 递增 generation，并中止简报与信息树里还在飞的读取。晚到的响应不再写入隐藏的简报面板，中止的目录也不写入 30 秒内存缓存。已经排好的简报页保留在原处，下次进入继续用；没排完的挂载会在下次进入时重新开始。

任务列表不再为每个工作包预取 `/trace`。打开任务详情时沿用原来的进度读取。新闻筛选、JEV、翻译和小时报/日报生成没有改，接口契约也没有改。

本机空库对照（Playwright，硬刷新 `#sources` 后 8 秒，不含 SSE）：`main` 发出 32 个 API 请求、104,812 字节；本分支 21 个、95,312 字节。本分支没有 `reports/tree?view=reading`、`reports/hourly/index`、`posts`、`feed/x`、`feed/xueqiu`、`feed/bilibili`、`notes`、`knowledge`、`work-packages`。这些请求在 `main` 上的空响应合计约 9.9KB；生产上树和超时中的 X / 雪球会大得多。直接打开 `#report`、`#report/history`、`#report/2026-10-09`、`#feed`、`#source/bilibili`、`#inspire`、`#knowledge` 都会读到对应数据。已经打开过的信息流和已排好的简报再进入时不再重拉整表。加载中离开简报后，被拖住的树请求不再跟出 editorial / edition。
