# Single-user Instance 边界收束

## 目标

在保持当前单用户行为的前提下，停止把个人状态继续写进 Core，为以后复制 Instance 建立最薄边界；不实现多用户、Tenant、权限后台或 Instance Manager。

## 第 1 步：实现与兼容（待用户验收）

- 新增统一 Instance 配置与分层 `.env` 解析；Web、Worker 和相关 CLI 使用同一套 data / knowledge / config / imports / runtime 路径。
- 未配置 Instance 时保留旧目录；显式 Instance 使用独立根目录。原有 data、knowledge、workbook 环境变量继续覆盖。
- 持仓运行时只读 SQLite；移除 Web / Worker 启动时的个人持仓 seed。新增 `PortfolioImport`、文件导入命令与显式 legacy adapter，重复导入只合并稳定 ID。
- Trading Service 不再把 board 映射到个人 portfolio ID；持仓账户从 SQLite portfolios 读取，并修复同组多账户与同币种现金聚合。
- 市场观察池从运行时校验的 JSON Catalog 读取；旧 JS Catalog 入口暂时保留为只读兼容适配层，数据统一来自 `markets.default.json`，待用户验收通过后再删除适配层。
- Tag、Knowledge、个人资产工作簿与 Agent trace 路径进入 Instance 配置；Core `.default.json` 保持中立，测试使用合成知识样本。当前私有部署仓库另行版本化现有 Instance 内容，ownership 仍属于 Instance。
- BrowserRuntime 支持 Instance 默认 browserId；非 local Instance 使用隔离 Cookie 名。
- Launcher 只管理当前 Instance 状态文件记录的 Web / Worker PID；端口冲突不杀进程。BrowserSkill / SearXNG 作为 Host 服务复用，不随 Instance 停止。
- Taxonomy 新增 Instance `config/taxonomy.json` 路径、运行时校验 Contract 与中立 `taxonomy.default.json`；V16 个人分类保留为冻结的 Legacy Bootstrap，现有 Lily DB 不删除、不迁移。
- Launcher 端口遵循显式参数 → Process → Instance `.env` → Repository `.env` → `8787`；Cookie 名加入原始 instanceId 与 canonical instanceRoot 的短哈希。

## 兼容与停止线

- 没有为 Instance 边界重写任何已执行 migration，也没有新增数据库体系。
- 没有增加 User、Membership、Tenant、动态 JS Tool 或多 Agent Runtime。
- 当前数据库继续原地使用；私人旧持仓源码作为 Instance imports 备份随私有部署快照版本化，不再由 Core 运行时导入。

## 验证

- 新增 Instance path/env/port、PortfolioImport、PortfolioImport CLI、Market Catalog、Taxonomy Catalog、Browser default、Cookie 隔离、Launcher ownership 与多账户聚合测试。
- 新增 `docs/content-and-commit-guide.md` 作为内容归属与提交规则；文档索引和 Agent 必读顺序同步更新。
- 原个人 Market / Tag Catalog 保存在 Instance 配置中并随私有部署快照版本化；仓库内 `.default.json` 改为中立模板，相关测试改用合成 fixture，避免测试反向绑定个人目录。
- 完成交付前运行 `npm run check`。

## 第 2 步：用户验收

- 由用户验证旧单实例启动、持仓页面、市场页面、Tag / Knowledge、Browser 登录态和显式测试 Instance。
- 验收期间不删除旧入口，不迁移或清空现有个人数据。

## 第 3 步：验收后清理

- 只有收到用户明确的验收通过确认后，才删除旧 Catalog 兼容入口并更新最终文件清单。
- 完整 Instance backup / restore、User / Tenant / Instance Manager 仍不在本轮范围。

## 基线提交准备

- 第一次 0.2.0 基线提交按 `docs/content-and-commit-guide.md` 审计，不使用无差别 `git add .`。
- 本轮只准备提交与检查，不因准备提交而提前执行第 3 步；兼容 Catalog 入口继续保留到用户明确验收通过。
- Windows BrowserSkill CLI 经维护者明确批准 vendoring，随仓库放在 `externaltools/bsk.exe`；其哈希和更新要求记录在 `externaltools/README.md`。
- 基线提交包含当前 SQLite、Knowledge、个人 Catalog、资产工作簿与 legacy import 备份，目标是让另一台 Windows 主机恢复同一内容；`.env`、浏览器登录态和运行状态仍在新主机单独配置。
