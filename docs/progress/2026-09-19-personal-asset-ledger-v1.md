# 2026-09-19 个人资产账本 V1

接着 `2026-09-19-personal-asset-ledger-design.md` 落地第一版。用户确认后按讨论默认拍板：投资类不含券商现金；公积金/基金保留为独立类型；改余额不自动记快照；分红榜仍只读导入。

## 做了什么

- Contract：类型 / 账户 / 快照 / Import；Dashboard `source` 可为 `ledger`。
- V26：`personal_asset_types` / `accounts` / `snapshots` / `snapshot_lines` / `dividends`。
- Trading Service → Repository：空账本首次 GET 从收支草记导入；页面改备注/余额；「记本期」追加快照。
- 历史点保持导入记录；当前值随账户和持仓股票市值变。有持仓批次时，投资类只读账户取 A 股 + B 股市值，不含券商现金。
- 分析页按类型列出账户（银行卡1 · 交通银行），不再把机构名当成类型。

## 验收

- 导入后最新总资产与工作簿记录一致。
- 改账户金额后出现「现在」点，历史期间总额不变。
- `npm test -- test/personal-asset.test.js test/personal-asset-ledger.test.js`。
