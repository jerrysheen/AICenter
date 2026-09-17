# 拆除 legacy Chrome CDP 残留

## 目标

连通性验证通过后，清掉旧采集栈在代码、页面文案和导出面上的残留，只保留 BrowserRuntime / `bsk`。

## 决定

- B站公开 HTTP 辅助从 `bilibili/chrome.js` 改名为 `http.js`，不再暗示 CDP。
- Feed `source` 改为 `browser_runtime_home` / `browser_runtime_player`。旧 Capture 行若仍写 `chrome_cdp_*` 不回写。
- 删除 `resolvePullTwitterHomeApi` 与对旧仓 `pull-Twitter` 的路径探测。
- 删除 `closeAfter` / `closeBrowser` / `debugPort` 采集开关。
- 页面只说已登录浏览器 / BrowserSkill，不再引导独立采集 Chrome + 9222。
- 不删除用户本机 `.ai-data/chrome-profile`；代码已不再读取它。

## 验证

`npm run check`。
