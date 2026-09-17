# 网页图标改用 Lucide

## 目标

标题栏、底栏、排序等不再手画 path 或系统 emoji，改用现成图标库。

## 决定

- 鸿蒙官方 HarmonyOS Symbol 只能在 ArkTS `SymbolGlyph` 里用，网页/ArkWeb 不能直接调 `sys.symbol.*`。
- 网页层用 Lucide（ISC，24vp 描线，接近 Symbol 规范）。需要的图标从 `lucide-static` 抽进 `apps/web/public/icons.js`，不把整包打进浏览器。
- 新增图标：在 `scripts/vendor-lucide-icons.js` 的名单里加 Lucide 名称，跑 `npm run icons`。

## 改动

- `lucide-static` 开发依赖、`scripts/vendor-lucide-icons.js`、`apps/web/public/icons.js`
- `app.js` / `server.js` 改为按名称引用

## 验证

- `npm run icons` 写出 12 个图标。
- 设置、加号、底栏交易等走 Lucide SVG，不是 ⚙ / +。
