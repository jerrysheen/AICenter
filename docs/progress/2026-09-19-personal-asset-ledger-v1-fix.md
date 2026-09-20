# 2026-09-19 个人资产账本 V1 修正

上一轮 V1 导入真实收支草记时报「资产快照 id 不能重复」，页面看不到记录。本轮按用户拍板重做。

## 拍板

- 投资类包含券商现金：A 股 + B 股股票市值 + 券商现金，折 CNY。
- 公积金、基金单独成类。
- 改余额不自动记快照，必须点「记本期」。
- 分红先不要：不导入、页面去掉分红榜。

## 页面

上面是统计（总资产、变动、轨迹、结构），下面按来源分组记录。账户仍是银行卡1 + 备注。

## 做了什么

- V27：去掉 `personal_asset_snapshots(workspace_id, label)` 唯一约束。同月多记几次都保留。
- 导入按行生成稳定 id，不再用期间标签当唯一键。
- 真实工作簿 57 个历史点可导入，最新记录 `2026/8.1` · 1,563,354.23。
- 分红不进 Import；Dashboard `dividend` 保持空列表。
- 投资随持仓现价同步进当前总资产；曲线只留静态历史点，不再追加「现在」。
- PC 结构图改为扇形路径，避免 Windows 缩放下圆环在 12 点位置留缝。

## 验收

- `npm test -- test/personal-asset.test.js test/personal-asset-ledger.test.js test/work-package.test.js`
- `GET /api/v1/assets/personal` 不再报重复 id；分析页能看到历史点和分组账户。
