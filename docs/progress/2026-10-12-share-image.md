# 2026-10-12 分享图

## 目标

信息流、阅读页、小时报单条、日报单条，以及原来的问答卡，都能生成同一张分享图。长文保持清晰，不把整张图缩小。

## 诊断

分享图只有一处实现：`apps/web/public/share-card.js`。它不用 html2canvas，也不用 dom-to-image。页面把离屏 DOM 的行框读出来，再用 Canvas 2D 自己描字（`paintTree`）。入口原先只有问答卡上的「分享」，信息流、阅读页、小时报和日报都没有。

长图发糊主要有这几处：

- 导出倍率被写死成不超过 2，3 倍屏会把 2 倍图画大。
- 超长回答先裁到约 4000 CSS 像素。若再乘 2，画布高度到 8000，超过 iOS Safari 大约 4096 的边长，浏览器会把位图缩小，文字就糊。
- 预览用宽 540、质量 0.8 的 JPEG data URL。手机长按保存的是这张预览，不是原来的 PNG。
- 离屏容器用了 `translate3d`，但描字读的是 CSS 像素行框，再按倍率画到画布上，这层位移本身不缩放文字。

Chrome 单边上限约 32767。安全上限取 iOS 边长 4096 和面积约 1677 万像素，以及 Chrome 边长里更小的那个。

## 决定

- 仍用这一套 Canvas 描字，不引入 html2canvas。
- 倍率先取 `clamp(devicePixelRatio, 2, 3)`。单页高度乘倍率放不进安全上限时，才把倍率降下来。
- 正文超过一页时按块分页，必要时切开超高的一块。每一页保持同一倍率，不把整篇缩进一张图。
- 统一模板：标题、来源、时间、正文或要点、TradingPlus 水印、`tradingplus.cn` 文字，以及离线二维码。二维码在 `qr-code.js` 里生成，不请求外部服务。
- 预览和下载都用 PNG。手机能用 Web Share API 分享文件时直接分享，否则打开预览，长按保存，或点保存下载。多页就分享或下载多张。
- 问答卡不再克隆原来的 DOM，改成同一张模板。

## 改动

- `apps/web/public/share-card.js`
- `apps/web/public/qr-code.js`
- `apps/web/public/app.js`、`news-list.js`、`brief-page.js`、`styles.css`、`index.html`
- `apps/web/src/http/static-files.js` 增加 `/qr-code.js`
- `test/share-card.test.js`、`test/static-module-whitelist.test.js`

## 验证

- `node --test test/share-card.test.js test/static-module-whitelist.test.js test/static-files.test.js`

## 遗留

- 二维码只做 byte 模式、纠错 M、版本 1–6。`https://tradingplus.cn` 用版本 2，已与 `qrcode@1.5.4` 的矩阵对照。纯大写字母会走 byte 而不是 alphanumeric，矩阵不必和自动选模式的库一致。
- 新增白名单后，Web 要重载一次才会提供 `/qr-code.js`。Worker 不用重启。
