# 简报首包先要这一份

## 目标

打开 `#report`、小时报或日报时，第一笔请求应是这一小时或这一期日报，不要先把 7 日信息索引拉下来。

## 决定

- `#report` 和带 `?hour=` 的小时报，先请求这一小时的 `reading-hour`。类目开关打开时，同一小时的 `hourly-category` 紧跟着发出。最近几小时的刊期索引可以并行，但不含 `information=1`。7 日刊期索引和 7 日阅读索引要等这一小时的阅读稿回来再补。
- `#report?mode=daily` 先请求 `latest-daily`。有刊期就接着要这一窗的研究日报，挂上页面之后才补 7 日索引。
- `#report/日期` 先按上海 08:00 截止窗请求这一期 editorial，索引只覆盖这一天，不对上再按索引里的窗口重取。7 日索引仍在这一份之后。
- 「本期材料」仍可读信息索引，但只取当前这一期的窗口，最长两天。不再对首屏发 `view=index&information=1` 的 7 日请求。
- 不新增 migration。只改 Web 静态脚本。需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。

## 验证

`node --test test/brief-manifest-fetch.test.js`

小时入口的第一笔是 `reading-hour`，日报入口的第一笔是 `latest-daily` 或当日 editorial。这些路径在阅读稿或日报正文回来之前不请求 7 日 `information=1`。
