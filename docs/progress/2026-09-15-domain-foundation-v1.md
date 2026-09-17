# 领域底座 V1

## 目标

在继续接入 B站、交易和 AI 能力前，冻结可插拔模块边界、核心数据类型和数据库演进方式。

## 完成

- 拆分 Feed、Trading、Knowledge、Runtime Contract，并加入 Zod 运行时校验。
- 增加 TypeScript 类型视图和独立类型检查。
- 数据库新增 V6：采集节点、凭证引用、股票别名、JobAttempt、知识版本与全文索引。
- 金额、价格、数量、汇率新增 Decimal 权威字段，旧 REAL 字段仅保留兼容。
- 新增 Feed、Trading、Knowledge 分域 Repository。
- 新增 capability registry，拒绝未声明或重复的任务 handler。
- 新增领域底座确定性测试。

## 边界决定

- 领域内部允许外键，跨领域使用稳定 ID、关系表或版本事件。
- Connector 不直接写页面 DTO，也不把平台凭证写入业务数据库。
- V1–V5 migration 不修改，所有对齐从 V6 继续演进。
- 旧 Web 接口继续工作；B3 再把业务行为迁入 Domain Service。

## 下一步

1. B4：实现 B站 Subscription -> Capture -> ContentItem -> SSE 真实链路。
2. B5：用 Transaction 投影第一版持仓快照。

## B3 补充交付

- `packages/domain` 已建立 Identity、Feed、Trading、Knowledge、Runtime Service。
- `apps/web/src/routes` 已按领域拆分，路由只做协议转换和访问控制。
- `apps/web/src/http` 已拆出 Router、响应、静态文件和 SSE Hub。
- `server.js` 缩减为进程启动与依赖组装入口。
- 新增架构依赖检查，阻止 Domain/Routes/Connectors 产生逆向依赖。
- 新增 `docs/ai-development-guide.md`，并加入 `AGENTS.md` 强制阅读清单，供后续 AI 延续设计。
- 将手册落地为 `.cursor/rules/`（alwaysApply 阅读顺序 + 分层/契约/Job/UI 分规则），保证 Cursor 会话能加载设计思路与接口规范。
