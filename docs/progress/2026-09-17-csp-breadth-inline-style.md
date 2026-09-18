# 行情宽度条去掉内联样式

## 目标

交易页「观察池宽度」在 `style-src 'self'` 下不再写 `style="flex-basis:…%"`，避免控制台 CSP 报错和条带宽度被拦。

## 决定

- 不放宽 CSP，不加 `unsafe-inline`。
- 宽度用 SVG `rect` 的 `x`/`width` 属性表达，与个人资产分析图同一套路。
- 浏览器扩展注入的 `data:font` 和 `chrome-extension://` 加载失败不是本仓资源，不为此放开 `font-src data:`。

## 验证

- `npm run check`
- 打开交易页，确认涨/平/跌条带仍按比例显示，控制台不再出现 `renderBreadth` 的 inline style 违规。
