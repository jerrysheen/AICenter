# 从小时报打开原文后，站内返回回到这一小时

## 目标

在 `#report?hour=N` 点「原文」进入 `#article/feed:…` 或 `#article/media:…` 后，阅读页的返回写成「返回信息流」，点下去落到 `#feed`，简报不再高亮。浏览器后退仍能回到原来的 `#report?hour=N`。从信息流打开文章再返回，仍要回到信息流。

## 决定

小时报里的「原文」是地址链接。浏览器先推进一条新历史，再发 `hashchange`。这条历史没有 `aiCenterPrevious`，阅读页就把文章的退路写成信息流。

现在只在进入 `#article/` 时，用 `hashchange` 的旧地址补上这一条历史的来源。浏览器自己的前进后退不改写。站内返回仍调用 `history.back()`，小时参数留在原来那一条上。按钮文案按来源页面取：简报是「返回简报」，信息流是「返回信息流」。直接打开文章、没有来源时，仍退回信息流。

不改类目小时的链接，也不改信息流打开文章的路径。

## 改动

- `apps/web/public/app.js`：进入文章时记下旧地址；阅读页的返回按钮和失败、读取中的按钮跟来源走。
- `test/article-back-referrer.test.js`：小时报回来仍是这一小时，信息流回来仍是信息流，浏览器后退不改历史。
- `test/article-read-restore.test.js`：读失败时，没有来源仍写「返回信息流」，来自小时报则写「返回简报」。

## 验证

`node --check apps/web/public/app.js`

`node --test test/article-back-referrer.test.js test/article-read-restore.test.js test/uiux-reading.test.js`

不新增 migration。当前 schema 仍是 98。下一号是 99。空号仍是 63、79、80、82。不要重建数据库。

## 部署

需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。

## 遗留

没有旧地址的文章，例如新开的标签页直接打开 `#article/…`，站内返回仍去信息流。
