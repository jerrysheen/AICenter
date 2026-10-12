# 来源名与来源入口

## 目标

日报来源行要显示出处，不要每行都写成「来源」。多个来源时，正文末尾的一串〔n〕收成一个入口。小时报单来源不再带角标。站内阅读页标题区可以打开原站。

## 决定

只改前端。树节点本身没有 publisher，小时阅读条目上的 publisher 仍由服务端 `publisherFor` 填好。来源名共用 `sourceName`：先用 publisher / publisherName / publisherKey；X 或 Twitter 用 @账号（字段或链接路径）；再没有就用作者、账号或链接域名。这些都空着时只显示标题。节点上没有这些字段时，用现有的内容条目或媒体文章接口补一次。多个来源仍全部平铺。末尾角标收成「N 个来源 ↓」，点了滚到来源列表；段落中间的单个〔n〕保留。小时报只有一个来源时不画〔n〕，点标题打开。打开后仍进站内阅读页，标题下增加「打开原站」。

## 改动

- `apps/web/public/information-tree.js`：`sourceName` / `sourceCaption`。日报和小时报的来源行都走它。多来源末尾改为「N 个来源 ↓」。
- `apps/web/public/brief-page.js`：旧简报复用同一个 `sourceCaption`，多来源同样收成一个入口。
- `apps/web/public/styles.css`：来源行和入口 13px，颜色用 `--font-secondary`。
- `apps/web/public/app.js`：阅读页标题区增加「打开原站」，新标签打开原 URL。

## 验证

`node --test test/hourly-unread.test.js` 覆盖来源名、小时单来源无角标、多来源入口，以及日报节点没有 publisher 时从内容条目补上 @账号。`npm run syntax` 通过。1280px 和 393px 各有一张静态样例。样例没有接数据库，点击路径以单测为准。

## 遗留

内容条目接口不返回订阅账号的 displayName。小时报上已有的 publisher 不变；日报在没有 publisher 时用作者、@账号或域名。静态资源更新后，已经开着的 Web 页面要刷新一次。
