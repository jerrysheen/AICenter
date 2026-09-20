# 灵感工作包投递箱

## 目标

在灵感里留下看到的不足，外网也能持续投递；本机 Cursor 领取并实现，按改动判断是否只重启 Web/Worker。

## 决定

- 工作包属于 Knowledge，不另开领域。每条工作包挂一条 Inspiration。
- 手机走已有设备授权创建；领取/完成只对本机桌面开放。
- 重启分类看改动路径：静态页、文档、测试不重启；`apps/web/src`、`apps/worker`、`packages` 才重启。
- 启动器用 Instance `runtime/restart.request` 弹 Web/Worker，不拆 cloudflared。

## 改动

- V21 `work_packages`
- `POST/GET /api/v1/work-packages`、`POST /api/v1/work-packages/notify`（客户端说「有任务了」），以及 desktop `claim/complete/fail`
- 不使用终端轮询；Cursor 只在通知后主动领取
- 灵感页最初用「工作包」开关；已改为灵感下独立任务窗，见 `2026-09-19-inspire-task-pane.md`
- `scripts/restart-ai-center.ps1` 与启动器 watcher
- `.cursor/skills/work-package/SKILL.md`

## 验证

- `test/work-package.test.js`
- 启动器边界测试确认重启不杀隧道

## 遗留

当前已打开的 `start-ai-center` 窗口要重启一次才会开始监听 `restart.request`。
