# 个股页按地址首帧显示骨架

## 目标

强制刷新 `#quote/代码` 时，第一帧就是个股骨架。中间不出现总览。副标题在报价到达前不显示半截代码。启动时的帖子、行为和实时流不挡住这一帧，后端不稳也不弹「请求超时」。

## 现象

手机上刷新个股页，前几秒先看到总览，正文里只有「行情」标题，会话和界面版本回来后才切到个股。电脑上主区域先是白的，只剩左侧栏，骨架大约 1 秒后才出现，副标题先写成「300852.SZ ·」。

静态页面默认打开总览。已记住登录时外壳会先显示。路由要等 `app.js` 跑完，还要等界面版本和 `/api/v1/session`。这段时间总览的行情槽是空的，手机上只剩标题，电脑上主栏是空的。报价未到时，副标题先把代码和间隔号写上去，后面再补骨架。

`/api/v1/behavior` 用 `sendBeacon`，失败不提示。`/api/v1/events/stream` 在页面已经画完后才连接，断线只写「正在重连」。帖子请求跟着总览走。空闲补拉帖子以前会把失败弹成「请求超时」。

## 决定

地址已经是 `#quote/代码` 时，不等数据和启动接口。文档一开始就加上 `quote-boot`，用样式藏起总览、打开个股骨架，页头写成「行情」。骨架里不写代码、休市和「—」。

`app.js` 一执行就按这个地址切到个股，仍不等会话和界面版本。会话还没回来时只画骨架，不请求报价和 K 线，所以也不会因为这两条先弹超时。会话回来后仍走原来的加载。

空闲补拉 `/api/v1/posts` 失败不再弹提示。行为和实时流维持不阻塞、不弹超时。

## 改动

- `apps/web/public/ui-boot.js`：`#quote/代码` 给 `html` 加上 `quote-boot`。
- `apps/web/public/index.html`：页头准备「行情」；`#page-root` 放一份无文字的个股骨架。
- `apps/web/public/styles.css`：`quote-boot` 时隐藏总览并显示个股页。
- `apps/web/public/app.js`：启动先按地址进入个股；报价未到时副标题只留骨架；没有会话不拉行情；空闲帖子失败不弹提示。
- 测试见 `test/quote-detail-page.test.js`。

没有新的前端文件，不用改静态白名单。不新增 migration。

## 验证

`node --test test/quote-detail-page.test.js test/quote-card-align.test.js test/feed-scope.test.js test/hour-scroll.test.js test/uiux-reading.test.js`

## 遗留

真机强制刷新要在部署后看：1 秒内应是个股骨架，中间没有总览，副标题没有半截代码。
