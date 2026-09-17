# 工作包 B：架构层与鸿蒙薄壳

> 历史快照：记录把单进程原型升级为 Web + Worker + 鸿蒙薄壳时的交付。下文「尚未包含」写于骨架完成时，之后已有 B站/X/行情/分享/Agent 等实现，以 `docs/release-readiness.md` 和 `docs/progress/` 为准，不要把该节当成当前缺口清单。

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
9. 鸿蒙真机完成签名、安装、扫码、失败退出和重新扫码验证。
10. 模块边界、V1 数据 Contract、V6 领域迁移和分域 Repository。
11. Capability manifest 注册和任务 handler 冲突检查。
12. Identity / Feed / Trading / Knowledge / Runtime Service 与分域 HTTP 路由。
13. 自动化架构边界检查，防止路由和领域层反向依赖 Connector/SQLite。
14. 可选公网 Gateway 安全模式：代理身份隔离、高熵配对、Secure Cookie 和限速。

## 尚未包含

- B站、同花顺或全球行情的真实 handler。
- X 登录态首页、长文 Chrome 增强、订阅落库。
- 鸿蒙系统分享、通知和安全资产 token 存储。
- B站 Capture -> ContentItem 的首条真实 Worker 链路。

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

鸿蒙真机基础闭环已经由用户完成。后续涉及系统分享、通知、安全资产或重新签名安装的操作仍由用户执行，
具体步骤见 `apps/harmony/README.md`。
