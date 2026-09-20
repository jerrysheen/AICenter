# AI Center Agent Instructions

## Required Reading

在规划或修改代码前，按此顺序阅读。早期阶段限制、当前实现和未来目标不要混读成同一层：

1. `docs/README.md`：文档总入口。
2. `docs/content-and-commit-guide.md`：Core / Instance / Host 内容归属、默认模板与提交规则。
3. `docs/release-readiness.md`：当前问题、验收状态与停止线。
4. `docs/architecture.md`、`docs/architecture-modules-v1.md`、`docs/architecture-agent-v1.md`、`docs/contracts-v1.md` + `packages/contracts/src`：稳定规则。Ask Agent 职责以 `architecture-agent-v1.md` 为准。
5. 专题：`docs/search-agent-v1.md`（文章阅读 / Search Agent）、`docs/connection-and-pairing.md`、`docs/public-access-security.md`、`docs/ai-development-guide.md`。
6. `.cursor/rules/`：与手册同义，不能替代上述文档。

`docs/product-v1.md`、`docs/plan/`、`docs/progress/` 是历史。不要用它们重新驱动当前开发。

实现与设计冲突时，先更新设计决定并说明兼容方案，不得绕过 Service、Repository、Contract 或 capability registry 直接完成功能。

完成重要开发后更新 `docs/progress/`；改变稳定架构时同步改设计文档。

## Repository Scope

- 本仓库是独立产品仓，不是旧 AI 或 AI-Hub 仓库的合并副本。
- 旧仓只作 Adapter 参考；路径只从环境变量读取。禁止直接复制旧代码。
- 当前是 **0.2.0 基线候选**：先完成隐私、安全和稳定性验收，不扩大功能。
- 不重写 Agent、不加 Intent Router、不多 Agent、不换数据库体系。现有分层把边界收清楚即可。

## 稳定工程边界

1. 使用 `schema_migrations` 演进 SQLite，不删除或重建用户数据库；已执行的 migration 不得删除或改写。
2. Web 只处理 HTTP/API/SSE；长时间抓取与 AI 任务进入 `apps/worker`。
3. Worker 只执行显式注册的 handler，不接受来自 HTTP 的任意命令。
4. 外部能力通过 `packages/connectors` 适配。
5. 业务写入与 `outbox_events` 同事务，SSE 支持 `Last-Event-ID` 补发。
6. HarmonyOS 源码位于 `apps/harmony`；DevEco、签名和真机安装由用户执行。
7. 页面 Contract 不暴露供应商字段。

## Safety and User-Executed Steps

- 服务端不得把数据库、Codex Bridge、浏览器调试端口或 Worker 直接暴露到局域网。
- 二维码只携带短期、一次性配对码，不携带长期设备凭证。
- 设备凭证在服务端只保存哈希；用户可以撤销已配对设备。
- DevEco Studio、鸿蒙设备开发者模式、签名和真机安装属于「用户执行」。
- 不使用 Computer Use 或脚本模拟桌面鼠标、键盘操作。
- 不要一键批准 Cursor 里与当前任务无关的旧文件补丁。

## Engineering Conventions

- 使用仓库相对路径，不写入机器专属绝对路径、真实公网 Hostname 或私人部署资料。
- API 从 `/api/v1` 开始版本化。
- 业务数据使用 SQLite；图片等文件保存在 `data/blobs/`，数据库只保存相对路径。
- 数据契约必须有运行时校验和确定性测试。
- 保留用户已有改动，不执行破坏性 Git 或文件操作。
