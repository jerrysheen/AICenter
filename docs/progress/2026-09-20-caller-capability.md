# 2026-09-20 公网 Agent 与 Host 能力平面

生产执行器已经是 DeepSeek Harness。HTTP 桌面管理隔离挡不住「已配对公网设备驱动本机改代码」。

## 决定

- 配对只表示可以使用 Instance，不是本机编码 Agent。
- 增加调用方能力平面：`device-operate`（已配对设备）与 `desktop-host`（loopback 且非公网代理）。
- 工作包记录可从已配对设备创建；`work-package.dispatch`、手动重启、Harness bash/fs/subagent 只允许 `desktop-host`。
- dsh Session 只在同一能力剖面内复用。不建设 User / Tenant。
- 本文只改设计文档，不改代码。当前实现仍允许公网 `notify` 与 `runtime/restart`。

## 验证

- 稳定文档已同步：`docs/public-access-security.md`、Agent / modules / architecture / contracts。
