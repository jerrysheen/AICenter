# 2026-10-12 静态 JS 版本与缓存

## 目标

总览白屏。`share-card.js` 引用 `./markdown.js` 和 `./qr-code.js` 时没有 `?v=`。边缘把无版本静态文件缓存一年，送出的仍是 10/10 的 `markdown.js`，里面没有 `markdownShareBlocks` / `stripSharePlaceholders`。`app.js` 因此加载失败。

## 决定

- 本地 JS 引用沿用 `?v=dev`。静态服务已有的替换会把它改成当前 public 指纹。
- 同一处还补上 `index.html` 的 `ui-boot.js` 和 `etf-whale.html` 的 `etf-whale.js`。`ui-boot.js` 仍在送出 HTML 时内联，源标记可以带 `?v=`。
- 请求里没有 `v` 的 JS，若原来会给一年 `immutable`，改为 `Cache-Control: no-cache`。带 `v` 的 JS 仍是 `public, max-age=31536000, immutable`。HTML、`ui-boot.js` 和原来 `no-store` 的脚本保持 `no-store`。CSS 的缓存不变。

## 改动

- `apps/web/public/share-card.js`、`index.html`、`etf-whale.html`
- `apps/web/src/http/static-files.js`
- `test/static-module-whitelist.test.js`、`test/static-files.test.js`

## 验证

- `node --test test/static-module-whitelist.test.js test/static-files.test.js`

## 遗留

需要重启 Web，缓存头在静态文件服务进程里。只换 public 文件时，`?v=` 会随指纹改写，但没有 `v` 的 JS 仍按旧进程给一年缓存。Worker 不用重启。边缘上已经钉住的无版本 `/markdown.js` 要等该缓存条目失效；新页面走带指纹的地址。
