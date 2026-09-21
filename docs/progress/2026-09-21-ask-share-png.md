# 2026-09-21 问答卡分享 PNG

## 目标

先打通「已完成问答卡 → 一张 PNG」。这是页面动作，不是新领域，也不走 Worker / 无头浏览器。

## 决定

- 克隆当前 `.ask-exchange`，离屏排成 720px 分享稿，去掉操作按钮和运行记录，再画成 PNG。
- 不另写 Markdown→图引擎，沿用页面已经渲染好的回答。
- 不用 SVG foreignObject 出图：Chromium 把它当图片加载时用不上本机中文字体。改为按排版用 Canvas 描字。
- 问答卡点「分享」出预览小窗，窗内点「保存」。问题在图里用普通正文，不加粗标题。不经附件上传。
- 小窗只显示缩小后的 JPEG data URL（CSP 不允许 blob 图）。保存仍用原 PNG，避免拖一张大图卡死。
- 超长回答截到约 4000px，脚注说明只截前半部分。
- 现网 Web 要重启后才会提供 `/share-card.js`。

## 改动

- `apps/web/public/share-card.js`
- `apps/web/public/app.js` / `styles.css`
- `apps/web/src/http/static-files.js` 增加 `/share-card.js`
- `test/share-card.test.js`

## 验证

- `node --test test/share-card.test.js test/static-files.test.js`

## 遗留

- 信息流详情卡还没接同一条导出。
- 信息流详情卡还没接同一条导出。
