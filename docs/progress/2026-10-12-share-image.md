# 2026-10-12 分享图

## 目标

信息流、阅读页、小时报单条、日报单条，以及原来的问答卡，都能生成同一张分享图。长文始终是一张 PNG，不拆成多张。

## 诊断

分享图只有一处实现：`apps/web/public/share-card.js`。它不用 html2canvas，也不用 dom-to-image。页面把离屏 DOM 的行框读出来，再用 Canvas 2D 自己描字（`paintTree`）。入口原先只有问答卡上的「分享」，信息流、阅读页、小时报和日报都没有。

长图发糊主要有这几处：

- 导出倍率被写死成不超过 2，3 倍屏会把 2 倍图画大。
- 超长回答先裁到约 4000 CSS 像素。若再乘 2，画布高度到 8000，超过 iOS Safari 大约 4096 的边长，浏览器会把位图缩小，文字就糊。
- 预览用宽 540、质量 0.8 的 JPEG data URL。手机长按保存的是这张预览，不是原来的 PNG。
- 离屏容器用了 `translate3d`，但描字读的是 CSS 像素行框，再按倍率画到画布上，这层位移本身不缩放文字。

Chrome 单边可以到 32767。这里单边不超过 16384，设备若更小就用探测到的边长。总像素不超过 iOS 约 1677 万。

## 决定

- 仍用这一套 Canvas 描字，不引入 html2canvas。
- 始终一张 PNG。不按页切开，也不出多张。
- 卡片 CSS 宽固定 540，落在 375–540。2 倍时像素宽是 1080，落在 750–1080。
- 倍率是 `min(3, 单边上限/内容宽, 单边上限/内容高, sqrt(16.7M/(宽×高)))`，再和 `clamp(devicePixelRatio, 2, 3)` 取更小的。放进 2–3 就用这个值。放不下 2 倍、但 1.5 倍还放得下，就降到不低于 1.5。1.5 倍仍超出边长或面积，就用放得下的最大倍率，仍然只出一张。
- 统一模板：标题、来源、时间、正文或要点、TradingPlus 水印、`tradingplus.cn` 文字，以及离线二维码。二维码在 `qr-code.js` 里生成，不请求外部服务。
- 预览和下载都用 PNG。手机能用 Web Share API 分享文件时直接分享这一张，否则打开预览，长按保存，或点保存下载。
- 问答卡不再克隆原来的 DOM，改成同一张模板。

## 改动

- `apps/web/public/share-card.js`
- `apps/web/public/qr-code.js`
- `apps/web/public/app.js`、`news-list.js`、`brief-page.js`、`styles.css`、`index.html`
- `apps/web/src/http/static-files.js` 增加 `/qr-code.js`
- `test/share-card.test.js`、`test/static-module-whitelist.test.js`

## 验证

- `node --test test/share-card.test.js test/static-module-whitelist.test.js test/static-files.test.js`

## 2026-10-12 验收回补

- 日报单条在列表和详情都有「分享」。研究日报的方向卡旁、打开后的标题旁，以及没有成稿时的模块列表和详情，都走同一张卡。
- 小时报每一条直接有「分享」，不用先打开阅读器。卡片用这条自己的标题和摘要。标题点击展开本条正文，不再打开第一条引用的原帖。`[未抓取]`、`图片 ×N`、`[图片]` 这类占位会从分享文案里去掉。
- 问答分享的时间用回答的 `completedAt`，没有则用这条记录的 `createdAt`。Markdown 表格画成网格，链接只保留链接文字。分享按钮在回答顶部，阅读长回答时粘在上面。
- The Next Platform 列表写着「已验证正文」、阅读器却是「无正文」：列表项带翻译状态和 `bodyHash`，但 `body` 为空、也没有段落。阅读会话把这层列表壳当成已译全文留住，随后的全文因为标题不同被当成另一版。现在没有可读正文的列表壳不能占住会话。快照若只把段落放在 `article.paragraphs`、`bodyText` 为空，读取时用段落拼回正文。
- 手机上 `#ask` 历史卡片超出右缘：卡片和标题、预览、底栏使用 `min-width: 0`、`max-width: 100%`、`word-break: break-word`。

页面脚本改动重载 Web 即可。`media-ingestion-service.js` 的正文回退要重启 Web 进程后，下一次打开文章才走新的读取。Worker 不用重启。

## 2026-10-12 阅读与日期

- 分享预览打开时就把 PNG 和下载链接准备好。「保存」在同一次点击里下载；iPhone / iPad 能分享文件时走系统分享，取消分享不会再下载。不再在点击里等待脚本加载。
- 问答分享按钮改成回答卡片右上角的小按钮，正文留出上边距，滚动时不再盖住回答。
- 阅读页正文、媒体段落和小时报展开正文去掉 `[未抓取]`、`图片 ×N`、`[图片]`，用的是分享卡同一套过滤。小时报展开后，有来源地址时多一个「原文」链接。
- 日期和钟点分开格式化，避免手机把 `hourCycle: h23` 和日历日放在一起后把日期拨偏。日报标签在窗口正好结束于上海时间 0 点时，用结束前一瞬间，手机和桌面都落在窗口里的那一天。08:00 截止的日报日期不变。

这些都是页面脚本和样式。重载 Web。Worker 不用重启。

## 遗留

- 二维码只做 byte 模式、纠错 M、版本 1–6。`https://tradingplus.cn` 用版本 2，已与 `qrcode@1.5.4` 的矩阵对照。纯大写字母会走 byte 而不是 alphanumeric，矩阵不必和自动选模式的库一致。
- 新增白名单后，Web 要重载一次才会提供 `/qr-code.js`。Worker 不用重启。
