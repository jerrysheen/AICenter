# 工作包 B：架构层与鸿蒙薄壳

## 本轮目标

在不改变现有前端信息架构的前提下，把单进程原型升级为可以承载抓取、行情和 AI 任务的本地运行架构，并交付可由用户导入 DevEco Studio 的 HarmonyOS ArkWeb 薄壳。

## 已交付

1. 版本化 SQLite migration，现有数据原地升级。
2. 默认 workspace 和信息、交易、知识领域表。
3. 持久化 jobs、原子领取、失败重试和 provider health。
4. outbox event 与 SSE `Last-Event-ID` 回放。
5. 无 shell 的 JSON 子进程 Adapter，供旧 Skill 接入。
6. 独立 Worker 入口和基础 healthcheck handler。
7. HarmonyOS Stage + ArkWeb 工程、Preferences、深链、原生错误恢复。
8. 浏览器配对二维码和鸿蒙 App 深链二维码并存。

## 尚未包含

- B站、X、同花顺或全球行情的真实 handler。
- 前端的鸿蒙二维码切换控件。
- 鸿蒙系统分享、通知和安全资产 token 存储。
- DevEco Studio 编译与真机结果。

这些分别属于信息/交易 P0、前端工作包和用户真机验证，不在架构骨架中伪造。

## 本地验证

```powershell
npm run check
npm start
npm run start:worker
```

Web 服务启动后，本机可创建 Worker 检查任务：

```text
POST /api/v1/runtime/healthcheck
GET  /api/v1/runtime
GET  /api/v1/runtime/jobs
```

## 用户执行：鸿蒙验证

操作步骤、预期结果和需要反馈的信息见 `apps/harmony/README.md`。在用户返回真机结果前，不能把工程结构校验当作已通过真机验收。
