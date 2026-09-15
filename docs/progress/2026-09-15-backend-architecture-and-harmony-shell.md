# 后端架构与 HarmonyOS 薄壳

## 目标

执行工作包 B：替换单进程数据基础，加入 Worker/任务/事件边界，并建立 HarmonyOS Stage + ArkWeb 薄壳。

## 决定

- 现有 Web API 和用户 UI 保持兼容，不覆盖 `apps/web/public` 的在制改动。
- SQLite 继续作为本地唯一业务数据库，通过 migration 升级。
- 任务队列和 outbox 第一阶段也使用 SQLite，不引入 Redis。
- Worker 只执行注册 handler；旧 Skill 使用无 shell 的 JSON stdout 适配器。
- 鸿蒙薄壳保存服务器地址，授权 Cookie 交给 ArkWeb；安全资产 token 独立存储后置。
- 配对接口同时生成 HTTP 和 `aicenter://pair` 两种二维码。
- 产品与 Web/Harmony 版本统一提升到 `0.2.0`。

## 改动

- `packages/database/src/migrations.js`：四个 migration 和领域 schema。
- `packages/database/src/index.js`：jobs、outbox、provider health 和兼容数据访问。
- `packages/runtime/`、`packages/connectors/`、`apps/worker/`：后台执行边界。
- `apps/web/src/server.js`：持久事件转发、断线补发、runtime 诊断、App 配对深链。
- `apps/harmony/`：完整 Stage 工程骨架和 ArkWeb 页面。
- `test/runtime.test.js`：迁移、任务和进程 Adapter 测试。

## 验证

- `npm run syntax` 通过。
- `npm run harmony:verify` 通过，共检查 11 个关键工程文件。
- `npm test` 通过，共 12 项测试。
- DevEco Studio 编译、签名和真机安装等待用户执行。

## 后续

1. 前端显示 `appQrDataUrl`，提供浏览器/鸿蒙二维码切换。
2. 用户执行 DevEco 导入和真机安装，反馈首个编译错误或成功截图。
3. 注册第一条 B站同步 handler，验证真实 Capture 到信息流。
