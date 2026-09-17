# 灵感来源链接打不开

日期：2026-09-17

## 目标

鸿蒙分享进灵感的两条知乎链接可以点开；点击不得被左滑手势吃掉，也不得把外站载入 ArkWeb。

## 决定

- 来源标题本身就是链接；点击走 `openExternalHttpUrl()`，优先 `AICenterShell.openExternalUrl()`。
- 左滑 `pointerdown` 在 `a` / `button` 上不 `setPointerCapture`。
- ArkWeb 外站导航拦截后用系统浏览器打开，避免 `target=_blank` 在壳内无窗口。
- 知乎未登录墙属于对方站点，不在本仓绕过。

## 改动

- `apps/web/public/app.js`、`markdown.js`、`styles.css`、`index.html`
- `apps/harmony/entry/src/main/ets/pages/Index.ets`、`module.json5`
- `scripts/validate-harmony-scaffold.js`、`test/markdown.test.js`
- `docs/harmony-share-to-inspiration.md`

## 验证

- 电脑灵感列表点来源标题，新窗口打开对应知乎 URL。
- `npm run check`。
- 鸿蒙需用户重新安装后，点链接应唤起系统浏览器。
