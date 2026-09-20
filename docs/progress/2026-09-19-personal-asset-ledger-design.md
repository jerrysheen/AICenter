# 2026-09-19 个人资产账本设计讨论

本轮按工作包要求**只讨论、不改产品代码**。现行实现与页面契约不变；下文是下一轮落地前的模型草案，不是已交付能力。

## 目标

把「个人资产分析」从一张固定列的 Excel 投影，收成 **类型目录 + 账户实例 + 期间快照**。Excel 只作导入源。持仓页的市值加总进个人资产，而不是再手填一列「股票」。

## 现状

当前链路是：

```text
imports/personal-assets.xlsx
        │  Connector 认列号
        ▼
PersonalAssetDashboard（source = workbook）
        │  只读
        ▼
GET /api/v1/assets/personal
```

Adapter 把工作簿列压成 6 个固定桶：

| 现用 key | 页面名 | 来源 |
|---|---|---|
| `cash` | 银行及现金 | 多列相加 |
| `equity` | 股票(A+B股) | 手填一列 |
| `fund` | 基金与支付宝 | 手填一列 |
| `crypto` | 数字货币 | 手填一列 |
| `housingFund` | 公积金 | 手填一列 |
| `other` | 其他额外 | 手填一列 |

同时，持仓已经在 SQLite：`Portfolio` / `HoldingLot` / `Cash`。两边没有加总关系。Excel 里的「股票」是历史手填数，不是持仓页的实时市值。

架构上这和持仓已经分叉：持仓禁止启动时灌 Excel；个人资产却仍把工作簿当运行时真源。`PersonalAssetDashboard` 也把 `equity` / `housingFund` 写死在 `latest` 里，页面等于认死这张旧表。

## 用户意图（收束后）

1. 资产类型是功能里的**基础配置**（银行卡、投资、数字货币、额外资金等），不是「交通银行卡」这种机构名。
2. 实例用通用名：银行卡 1、银行卡 2；备注写交通银行、招商银行。类型以后也能改显示名。
3. 类型放在个人资产这一侧；持仓作为其中一类来源，**加总**进总资产，不在个人资产里再拆成一只只股票。
4. 页面改数、记期间；主数据进本机 SQLite，方便按 workspace 分开。Excel 不再是日常编辑面。
5. 本轮先对齐模型，不写代码。

「多用户」按现行 Instance 边界理解：每个 Instance 一份库，表上带 `workspaceId`。不新建 User / Tenant / Membership。

## 建议模型

三层，都留在 Trading，不另开领域。

```text
PersonalAssetType          类型目录（银行卡 / 投资 / 加密 / 额外…）
        │
        ▼
PersonalAssetAccount       账户实例（银行卡1 · 备注交通银行）
        │
        ├─ 当前余额（页面日常改这里）
        └─ PersonalAssetSnapshot + lines
              期间点（导入旧表行，或页面「记本期」）
```

持仓不复制成账户行。Dashboard 计算总资产时，把 `HoldingsBoard.summary` 的约定合计读进来，归到「投资」这一类。

### 1. 类型目录

Core 只给中立种子，不写任何人的银行名：

| key | 默认名 | 角色 |
|---|---|---|
| `bank` | 银行卡 | 可有多条账户 |
| `cash` | 现金 | 钱包、备用金 |
| `investment` | 投资 | 默认可挂持仓合计 |
| `fund` | 基金与余额 | 场外基金、支付宝等 |
| `crypto` | 数字货币 | 可有多条账户 |
| `extra` | 额外资金 | 借出、应收、其他 |
| `housing_fund` | 公积金 | 通常一条 |

种子对应现表 6 个桶，导入时对得上。用户可改显示名、排序、是否隐藏；V1 不必开放任意新建类型。机构名只进账户备注。

### 2. 账户实例

- 新建默认名：`{类型名}{序号}`，如银行卡 1。
- `note`：交通银行。
- 页面主文案：`银行卡1 · 交通银行`。
- 金额、币种用 Decimal 字符串；默认 CNY。
- 账户可归档，不删历史快照行。
- 特殊账户：`source = holdings`，余额只读，来自持仓合计，不能手改。

禁止把「交通银行」做成类型 key。

### 3. 当前余额和期间快照

大屏仍要增长轨迹，所以要两份数：

- **当前余额**：页面改账户时写这里，Dashboard 的「现在」用它。
- **期间快照**：一行一个日期标签（`2026/8.1`），下面按账户（或类型）记当时金额。导入 Excel 每一行变成一条快照；之后在页面点「记本期」再追加。

持仓现价天天变，**不回写历史快照**。曲线里的旧「股票」保持导入值；新快照才按当时持仓合计落一笔。现价只影响「现在」这一格。

不回写 Excel。工作簿留在 `imports/`，角色等于当年的 `PortfolioImport` 源文件。

## Excel 怎么用

做成一次（或按需再跑）的 `PersonalAssetImport`，经 Trading Service → Repository，与持仓导入同形：

```text
personal-assets.xlsx
        │  Connector 仍只认列号 / 表名
        ▼
PersonalAssetImport
        │  Trading Service 合并
        ▼
Type + Account + Snapshot（SQLite）
```

建议映射：

- 「银行及现金」多列 → 若干 `bank` / `cash` 账户；列头能辨认就进备注，辨认不了就叫银行卡 1、银行卡 2。
- 「股票(A+B股)」→ 一条 `source=holdings` 的投资账户；历史行进快照，当前值改由持仓计算。
- 基金、加密、公积金、其他 → 各类型至少一条账户。
- 「分红所得」V1 可仍作只读导入榜，或暂挂 Dashboard，不先建完整分红账本。

重复导入按稳定 ID 合并，不删用户后来在页面新建的账户。

## 持仓怎么加总

资产类型在个人资产侧；持仓是投资类的一个来源。

建议默认（需你拍板）：

- 投资类计入：持仓页 A 股（含港股通）股票市值 + B 股沪/深股票市值，折 CNY。
- **券商现金不进投资类**。它已在持仓页，若再算进银行卡会重复。
- 个人资产总资产 = 各账户当前余额 + 上述持仓股票合计。
- 场内 ETF 已在持仓批次里，不要再在「基金」账户手填同一笔。

Dashboard 的 allocation 按**类型**汇总，不再按 Excel 列。`latest.equity` 这种写死字段应改成按类型动态汇总，避免页面继续认旧列。

## 分层（下一轮才做）

仍走 Contract → Service → Repository，不换数据库体系。

1. `packages/contracts/src/trading.js`：Type / Account / Snapshot / Import；Dashboard `source` 改为 `ledger`（导入过渡期可兼容 `workbook`）。
2. 新 migration（当前最新是 V25，只能加 V26+），表带 `workspace_id`。
3. Trading Repository 拥有这些表；不让 Feed / Knowledge 来写。
4. Trading Service：列账户、改余额、记快照、导入、组装 Dashboard（读持仓投影，不抄持仓字段进资产主表）。
5. Workbook Connector 只负责 `xlsx → PersonalAssetImport`，不再直接当 Dashboard 端口。
6. Route 只做鉴权与 DTO；页面改账户走 API，不改本地 Excel。

跨域只引用持仓稳定投影（例如当时的 `totalCny` / 股票市值），不把 `HoldingLot` 行复制进资产表。

## 明确不做（本讨论与下一轮 V1）

- 本工作包不改 `packages/`、`apps/`、测试或稳定架构正文。
- 不把 Excel 当可写数据库，不从页面回写 xlsx。
- 不把持仓批次拆进个人资产账户。
- 不宣称完整复式记账或替代 `Transaction` 目标模型。
- 不建 User / Tenant。`workspaceId` 即可。
- 不把银行名、支付宝名写进 Core 常量。

## 建议落地顺序（讨论通过后再做）

1. Contract + 空账本 Dashboard（无 Excel 也能看空状态）。
2. V26 表 + Repository。
3. 工作簿一次导入，旧大屏数字对齐。
4. 持仓加总进投资类；核对不与券商现金、场内 ETF 双计。
5. 页面：类型/账户列表、备注、改余额、「记本期」。
6. 再删「必须有 xlsx 才能看分析页」。

## 请你拍板

1. **投资类默认包不包括券商现金？** 建议不包括，避免和持仓页现金、银行卡三边重复。
2. **公积金、基金是否保留为独立类型？** 建议保留，才能无损导入旧表；你点名的银行卡 / 投资 / 加密 / 额外都在。
3. **改余额时要不要自动记快照？** 建议不自动，显式「记本期」，避免曲线被日常改数打密。
4. **分红榜 V1 是否继续只读导入、先不建账本？** 建议是。

以上 4 条不定，不开始写代码。稳定文档（`product-v2` / `contracts-v1` / `architecture*`）等落地时再改，避免把草案写成已交付。
