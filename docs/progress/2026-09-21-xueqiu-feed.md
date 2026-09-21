# 2026-09-21 雪球信息流

## 目标

信息流增加雪球栏目，抓取首页「关注」「关注精选」和「7x24」，与 X / B站 / TrendForce 同一套 Source → Capture → ContentItem。

## 决定

- 不扒雪球首页 DOM。X 那种点 Tab 抽卡片在雪球上更脆，也更容易抓错栏。
- Connector 走现有 BrowserSkill：打开 `https://xueqiu.com/`，用已登录页的 cookie 打站点 JSON。
- 关注：`/v4/statuses/system/home_timeline.json?source=user&usergroup_id=-1`
- 精选：同一接口 `usergroup_id=-2`
- 7x24：`/statuses/livenews/list.json`
- 关注 / 精选必须采集浏览器已登录；7x24 仍经同一 session，避免另开匿名 HTTP。
- `SourceProvider` 增加 `xueqiu`。Source `content.xueqiu.home`，Job `feed.xueqiu.sync`。页面 `GET /api/v1/feed/xueqiu?feed=following|featured|livenews`。

## 验证

- `node --test test/xueqiu-feed.test.js test/contracts.test.js`
- 关注 / 精选未登录时返回中文提示，不写空条目冒充成功。
