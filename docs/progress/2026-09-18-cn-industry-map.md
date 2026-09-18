# A 股产业地图种子与总览按时切换

## 目标

把 nano-ai 2026-09-17 国产半导体研究底库收成 AI Center 的 A 股观察池，并让股票总览按北京时间在 A 股 / 美股之间切换。

## 决定

- 这是 IndustryMap 种子，不是重新筛选后的推荐池。网站自己也标明尚非全市场穷尽名单，大量公司待核验。
- 同一公司可以跨模块重复出现；Catalog 唯一键是 `symbol::group`，报价按 symbol 去重。
- 新增独立 `market.cn` 看板，不覆盖现有亚洲 KR/JP/TW 观察池。
- 种子落在 Instance `config/markets.json` 的 `cn` 段；`markets.default.json` 只保留空 A 股模板。
- 股票总览按 `Asia/Shanghai`：工作日 17:00 前显示 A 股观察，17:00 后及周末显示美股观察。未聚焦的那一侧本轮不拉行情。
- A 股报价走现有 `market.quotes` 路由（雪球优先）。页面 Contract 不暴露供应商字段。

## 验证

- `npm run check`
- 股票页出现 `总览 / A股 / 美股 / 亚洲`；A 股可按 10 个产业组筛选。
- 北京时间白天打开总览应看到上证/深成/创业板和 A 股宽度；17:00 后看到美股观察。
