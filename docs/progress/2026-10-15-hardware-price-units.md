# 2026-10-15 存储价格单位、当前记录与数据日期

## 决定

公开价表标题只写「未税」，数字本身保持不动。

`trendforce-tables-4` 按表补币种和单位：DRAM／NAND 现货和 DRAM 合约颗粒仍是 `USD` / `chip`。DRAM 合约里的 SO-DIMM 改为 `USD` / `module`（条）。内存条是 `module`，显存是 `chip`，晶圆是 `wafer`，存储卡是 `card`，SSD OEM 和街价是 `unit`，NAND 合约价是 `chip`。标题里的 Memory Card/UFD 不把 NAND 合约颗粒算成存储卡。

行情读取按去掉「· 日高點」之后的规格名去重，只留有单位且有报价期的当前行。`unverified:` 和无单位的旧行可以继续留在库里，但 `is_current=0`。migration 68 只改这个标记。新写入时同样把被取代的旧行从当前拿掉。旧快照链接仍打开当时的表。

列表和详情的每一项直接写官网 Last Update 的月日。合约半月期写成「8 月下半月」，避免 9 月 30 日的会员通知看起来像报价月份。数据日期早于现在超过 7 天时标「已过期」。不增加单独的更新时间行。

## 验证

`node --test test/hardware-prices.test.js` 覆盖 SO-DIMM 与各表单位、数字未改、旧行标记、migration 68 不删行，以及 `08-31`／`08-05` 的过期和「8 月下半月」。

## 部署

migration 68。63 仍空着。不要重建数据库。需要同时重启 Web 和 Worker，浏览器再加载一次。已保存的 HTML 要等下一次 `feed.trendforce.prices`，或显式 `feed.trendforce.reparse`，才会把 SO-DIMM 写成 module。
