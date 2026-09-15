# AI Center Agent Instructions

## Required Reading

在规划或修改代码前，先阅读：

1. `docs/README.md`：文档总入口。
2. `docs/product-v1.md`：第一版范围和验收标准。
3. `docs/architecture.md`：进程、目录与数据边界。
4. `docs/connection-and-pairing.md`：手机直连、设备授权和安全约束。

每次完成重要开发工作后，在 `docs/progress/` 新增或更新对应的进度记录。

## Repository Scope

- 本仓库是新的产品仓库，不是 `F:\AI` 或 `F:\Fintech\AI-Hub` 的合并副本。
- `F:\AI` 是采集、转写、知识库与技能实现的参考源。
- `F:\Fintech\AI-Hub` 是金融页面、SQLite 和 Codex Bridge 的参考源。
- 第一版不得直接迁移旧仓代码；只有在手机直连与快速发布闭环通过后，才逐项接入旧能力。

## Version 1 Priorities

按以下顺序推进：

1. 本地服务和持久化。
2. 响应式网页信息流。
3. 手机扫码配对与长期设备授权。
4. 网页端和手机端快速发布。
5. SSE 实时同步和自动重连。
6. HarmonyOS ArkTS Stage + ArkWeb 薄壳。

第一版不实现抓取平台、知识库、Codex、金融行情、互联网公网访问或应用商店发布。

## Current Phase: Work Package B

第一版 Web 连接闭环完成后，当前后端阶段遵守以下边界：

1. 使用 `schema_migrations` 演进 SQLite，不删除或重建用户数据库。
2. Web 只处理 HTTP/API/SSE；长时间抓取与 AI 任务进入 `apps/worker`。
3. Worker 只执行显式注册的 handler，不接受来自 HTTP 的任意命令。
4. 外部能力通过 `packages/connectors` 适配，旧仓路径只从环境变量读取。
5. 业务写入与 `outbox_events` 同事务，SSE 支持 `Last-Event-ID` 补发。
6. HarmonyOS 源码位于 `apps/harmony`；DevEco、签名和真机安装继续由用户执行。

业务页面和功能 API 契约由前端工作包确定；后端不得让供应商字段直接成为页面契约。

## Safety and User-Executed Steps

- 服务端不得把数据库、Codex Bridge、浏览器调试端口或未来的 worker 直接暴露到局域网。
- 二维码只携带短期、一次性配对码，不携带长期设备凭证。
- 设备凭证在服务端只保存哈希；用户可以撤销已配对设备。
- DevEco Studio、鸿蒙设备开发者模式、签名和真机安装属于「用户执行」。Agent 只提供操作说明，并等待用户反馈后继续验证。
- 不使用 Computer Use 或脚本模拟桌面鼠标、键盘操作。

## Engineering Conventions

- 使用仓库相对路径，不写入机器专属绝对路径。
- API 从 `/api/v1` 开始版本化。
- 业务数据使用 SQLite；图片等文件保存在 `data/blobs/`，数据库只保存相对路径。
- 数据契约必须有运行时校验和确定性测试。
- 保留用户已有改动，不执行破坏性 Git 或文件操作。
