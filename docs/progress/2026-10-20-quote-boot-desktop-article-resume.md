# 电脑端个股首帧骨架，文章回到离开的段落

## 目标

电脑上强制刷新 `#quote/代码`，第一帧就是个股骨架，侧栏旁边不是空白。YouTube 文章（`#article/youtube:视频`）用浏览器后退或页内「返回」离开后再打开，回到离开时的段落。

## 现象

手机上骨架大约 0.3 秒就出现。电脑上前大约 2 秒只有左侧「AI Center / 个人信息中枢」，主栏是空的。已记住登录时，外壳在就绪前被写成整块排版，盖过了宽屏的左右分栏。侧栏高度是一屏，骨架在它下面，窗口里看不见。

文章路由 id 是 `youtube:视频`，和阅读位置用的是同一个 id。位置原先主要等滚动停 120 毫秒再记。后退时浏览器先把滚动拉回作者列表，这次滚动把刚记下的段落盖成页顶，再进来就从标题开始。

## 决定

宽屏下，已记住登录、页面还没就绪时，外壳仍用左右分栏，个股骨架留在侧栏旁边。`quote-boot` 直接显示个股页，不再只在 `data-view=sources` 时生效。

打开文章就把浏览器滚动恢复改成手动。阅读中的段落立刻记在内存里，离开时写入本地；滚动一下跳过大约一整屏，视为后退拉回，不覆盖这段落。`youtube:视频` 走和雪球、B 站相同的正文读取。`setView` 里锁住滚动的标志放进 `try/finally`，中途出错也会放开。

## 改动

- `apps/web/public/styles.css`：宽屏首帧分栏；`quote-boot` 显示个股骨架。
- `apps/web/public/app.js`：文章手动滚动恢复；`youtube:` 正文 id；`restoringViewScroll` 用 `try/finally`。
- `apps/web/public/article-read-position.js`：路由 id 与保存 id 对齐；离开时保存；大跳不覆盖。
- 测试见 `test/quote-detail-page.test.js`、`test/article-read-position.test.js`。

没有新的前端文件，不用改静态白名单。不新增 migration。

## 验证

`node --test test/quote-detail-page.test.js test/article-read-position.test.js test/quote-card-align.test.js test/hour-scroll.test.js test/uiux-reading.test.js test/overview-home-p0.test.js`

## 遗留

不新增 migration，schema 版本不变。不要重建数据库。需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。
