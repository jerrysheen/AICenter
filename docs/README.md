# AI Center 文档索引

阅读顺序：

```text
仓库 README
  → 本文
  → content-and-commit-guide（内容归属与提交规则）
  → release-readiness（当前问题与验收）
  → architecture / modules / contracts（稳定规则）
  → 专题文档
```

`plan/` 与 `progress/` 保留历史，不重新驱动当前开发。旧计划与已执行迁移记录不要批量删除。

## 当前

- `content-and-commit-guide.md`：Core / Instance / Host 内容归属、默认模板和 Git 提交规则。
- `release-readiness.md`：0.2.0 基线候选、发布门槛、容易写错的现状对照。
- `architecture.md`：进程、数据与运行边界。
- `architecture.md#single-user-instance-边界`：Core / Instance / Host 的现行边界与兼容布局。
- `architecture-modules-v1.md`：模块依赖、端口、单 Agent Runtime。
- `contracts-v1.md` + `packages/contracts/src`：可执行数据契约。
- `ai-development-guide.md`：如何在现有分层上改代码；当前停止线见发布门槛。
- `product-v2.md`：现行信息架构与领域范围（已按实现校正，不是「尚未开工」清单）。

## 专题

- `connection-and-pairing.md`：二维码、授权、自动重连；鸿蒙分享走本地 Outbox。
- `harmony-share-to-inspiration.md`：系统分享字段、鉴权与真机验收。
- `public-access-security.md`：可选公网 HTTPS、隧道和管理员隔离。示例域名是占位符，不是真实部署。
- `ops/local-files-mcp-tailscale.md`：本机 Local Files MCP 经 Tailscale Funnel 给 ChatGPT 的配置提示；**不是** AI Center 公网入口，不含本机 Hostname。

## 历史（不驱动当前开发）

- `product-v1.md`：连接原型范围与验收，已完成。
- `backend-work-package-b.md`：工作包 B 骨架交付时的快照；「尚未包含」一节已过时。
- `plan/stage-2.md`：第二阶段工作包拆分。B4 关注同步不是当前下一步。
- `plan/contracts-draft.md`：冻结前草案；实现以 `contracts-v1.md` 为准。
- `plan/agent-runtime-p0.md`：单 Agent 立项计划；现行边界见 modules 与 `packages/contracts/src/agent.js`。
- `plan/ask-answer-source-footer.md`：问答脚注计划。
- `progress/`：按任务记录当时目标、决定、验证；与现行规则冲突时以稳定文档和发布门槛为准。

仓库根目录 `.cursor/rules/` 与手册对齐，改设计时同步更新。

## 旧仓库参考

- 旧 AI / AI-Hub 仓库只作 Adapter 参考，路径从环境变量读取。不得直接复制旧仓代码。
