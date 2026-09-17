# 文档收束：0.2.0 发布门槛入口

## 目标

消除早期阶段限制、当前实现和未来目标混写。不另建一套文档体系，不重写 Agent。

## 决定

- 入口改为：README → `docs/README` → `release-readiness` → architecture / modules / contracts → 专题。
- `plan/`、`progress/`、`product-v1` 保留为历史，不删除已执行迁移记录。
- 从 ops 文档去掉真实 Tailscale Hostname、本机路径和 Funnel 验收里的私人标识。
- 本轮只改文档。Cursor 里更早的 Agent 补丁（`feed.tagged` 等）不要一键批准。

## 对照已写入稳定文档

见 `docs/release-readiness.md` 表格：同花顺已有适配、单 Agent 已实现、分享走本地 Outbox、豆包队列仅实例内串行、下一步是发布验收而不是 B4 关注同步、持仓仍是手工批次账本。
