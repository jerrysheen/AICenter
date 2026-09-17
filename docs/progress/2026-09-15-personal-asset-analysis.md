# 个人资产分析页

## 目标

在交易顶层「持仓」旁增加「个人资产分析」，用本地《收支草记》工作簿复现原 Google Sheet 资产大屏的数据结构：总览、增长轨迹、结构占比、分红榜单和文字洞察。

## 决定

- 工作簿是 Connector，不是页面契约。列号、`资产明细` / `分红所得` 只留在 Adapter。
- 页面读取 `PersonalAssetDashboard`；金额用十进制定点字符串；增长率用比率。
- 默认文件 `data/imports/personal-assets.xlsx`，可用 `AI_CENTER_ASSET_WORKBOOK` 覆盖。本轮不写入持仓流水表。
- Excel 序列日期转成 `YYYY/M.D`，与表中已有文本标签对齐。
- 前端用 SVG/CSS 绘图，不引入 ECharts CDN，以符合现有 CSP。

## 改动

- `packages/contracts/src/trading.js`：`PersonalAssetDashboard`
- `packages/connectors/src/personal-asset-workbook.js` 及 xlsx 读取
- `packages/domain` / `apps/web` 路由与交易页签
- `docs/product-v2.md`、`docs/contracts-v1.md`

## 验证

- `npm run check`
- 浏览器打开交易 → 个人资产分析，确认 KPI、折线、饼图、分红榜来自工作簿最新一行
