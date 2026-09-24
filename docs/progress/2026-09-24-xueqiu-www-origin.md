# 2026-09-24 雪球时间线域名

## 问题

关注账号已登录时，雪球信息流仍返回 `TypeError: Failed to fetch`，条目为 0。

## 决定

`xueqiu.com/hq` 会落到 `https://www.xueqiu.com`。页面在 `www` 上时，再请求不带 `www` 的时间线地址会被浏览器当成跨源。关注、精选和 7x24 的 JSON 改为 `https://www.xueqiu.com`，打开的页面也改为这个主机。帖子链接仍用 `https://xueqiu.com`。

## 验证

- `node --test test/xueqiu-feed.test.js`
- 本机重启 Web 后 `GET /api/v1/feed/xueqiu?feed=following&refresh=1&limit=15` 返回 live，新增 15 条。
