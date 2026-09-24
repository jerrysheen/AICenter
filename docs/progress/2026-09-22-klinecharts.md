# 2026-09-22 报价 K 线换成 KLineChart

报价页不再手绘 canvas。历史行情仍走 `/api/v1/markets/history` 的 OHLCV，页面用 KLineChart 10.0.3 画蜡烛、十字线和缩放。周期是日K、周K、年K：日K 取近两年日线，周K 取五年周线，年K 把最长月线按公历年收成一根。年K 用对数坐标，避免早期低价把近期蜡烛压成一条线。图表随容器宽高重算每根蜡烛的宽度。默认打开 MA、成交量、MACD，可再切换 BOLL、KDJ。红涨绿跌沿用页面的 `--data-up` / `--data-down`。

浏览器包是 Apache-2.0 的 UMD 构建，放在 `apps/web/public/klinecharts.js`。更新库版本后执行 `npm run vendor:klinecharts`。
