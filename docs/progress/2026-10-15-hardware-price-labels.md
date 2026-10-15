# 2026-10-15 价表周高低列与空币种

## 决定

`#106` 的 `trendforce-tables-4` 已经给标题为「未税」的表补了单位，但重新解析之后，闪存页这些当前行的币种和单位仍是空的：NAND 合约价 3 项、NAND TLC 晶圆现货 3 项、MicroSD 4 项、SSD 合约 3 项、SSD 街价 5 项。内存条 UDIMM／RDIMM、显存 GDDR5／GDDR6，以及 512Gb／256Gb／128Gb TLC，规格名还带着「項目」和「週高點」。

原因有两处。週高、週低排在盘高之前，被写进了规格名。规格名没变的行在数字也没变时会沿用旧观测，旧观测的币种是空的，行情就继续显示待核验。

`trendforce-tables-5` 把項目、日高點、週高點、低點、均價这类列表头从规格名去掉。币种和单位仍按表标题：NAND 合约 `USD` / `chip`，晶圆现货 `USD` / `wafer`，存储卡 `USD` / `card`，SSD 合约和街价 `USD` / `unit`。街价的品牌、規格、系列、容量留下来。高低均价沿用盘列，数字不改。

同一规格、同一报价期、数字相同，但币种、单位或税基补上了，就再写一条修订，并把旧行的 `is_current` 改成 0。旧行不删除。带週高點的旧规格和干净规格按同一个产品名对齐，写入时把旧的当前标记清掉。不新增 migration。

## 验证

`test/fixtures/trendforce/dram-public.html` 与 `flash-public.html` 是公开价表原文。`node --test test/hardware-prices.test.js` 断言每一条当前规格都有币种、单位，规格名不含价格列，并且空币种重新解析后旧行还在。

## 部署

不新增 migration。63 仍空着，69 不变。不要重建数据库。需要同时重启 Web 和 Worker，浏览器再加载一次。已保存的 HTML 要再跑一次 `feed.trendforce.reparse`，或等下一次 `feed.trendforce.prices`。
