# 重载文章后，站内返回仍回到进来的那一小时

## 目标

从 `#report?hour=N` 打开原文后，不重载时站内返回已经回到这一小时，按钮是「返回简报」。整页重载这篇文章，或在同一标签里把文章地址再打开一次之后，按钮仍写「返回简报」，点下去却落到 `#feed`，信息流被高亮。文案和去向不一致。

从信息流打开再返回，仍要回到信息流。没有来源的文章，文案和去向都是信息流。

## 决定

重载后，历史条目里的来源还在，所以按钮仍能写成「返回简报」。站内返回却调用 `history.back()`。这一跳在重载之后已经对不上记下的那一页，于是落到信息流。

这次打开文章时，把「这篇文章 ← 从哪一页来」写进 `sessionStorage`。当前这页脚本里刚刚点开的文章，返回仍走浏览器后退。整页重载之后，这次脚本没有重新点开过，就按记下的地址打开，不再调用 `history.back()`。来源是 `#report?hour=N` 时回到这一小时，简报保持高亮。

`sessionStorage` 也没有、历史条目里也没有来源时，按钮和去向都是信息流。

## 改动

- `apps/web/public/app.js`：文章来源写入 `ai-center.article-referrer`。重载后的返回按这个地址走。同一篇文章被替换地址时，留下原来的来源。
- `test/article-back-referrer.test.js`：重载后回到 `#report?hour=20`；没有来源时文案和去向都是信息流。
- `test/uiux-reading.test.js`：同一次打开仍走浏览器后退。

## 验证

`node --check apps/web/public/app.js`

`node --test test/article-back-referrer.test.js test/article-read-restore.test.js test/uiux-reading.test.js`

不新增 migration。当前 schema 仍是 98。下一号是 99。空号仍是 63、79、80、82。不要重建数据库。

## 部署

需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。

## 遗留

新开的标签页没有这一条 `sessionStorage`，也没有历史来源时，站内返回仍去信息流。
