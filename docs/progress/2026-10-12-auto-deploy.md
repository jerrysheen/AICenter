# 2026-10-12 守护脚本自动部署

Windows 上的 `scripts/start-ai-center.ps1` 在原守护循环里增加自动部署。Web/Worker 日志仍按天追加并保留 7 天。`restart.worker.request` 和 `scripts/restart-ai-center.ps1 -WorkerOnly` 仍只重启 Worker。

默认每 90 秒 fetch `origin/deploy`。`AI_CENTER_DEPLOY_REF=deploy-*` 时改为最新的 `deploy-*` 标签。工作区不干净（含被 `npm install` 改过的 `package-lock.json`）、不能快进、或引用里有 `.env`，都放弃，不自动还原。快进前备份数据库、WAL、SHM 和 `.env`。只有 `package-lock.json` 变化才 `npm ci`。只有 `apps/web/public/**` 变化不重启，否则重启 Web 和 Worker。健康检查沿用最长 90 秒的轮询；失败则回到上一个提交并再检查一次。`runtime/deploy.lock` 保证同时只有一个部署，部署期间不把主动停止当成服务崩溃。

`.env` 只做备份，不读取、不修改、不随这次 Git 更新。部署用的环境变量也不从 `.env` 取。

`GET /api/v1/runtime/deploy-status` 返回 `data/deploy-status.json`。必须有设备登录会话，本机回环和转发头不算登录。文件不存在时是空状态。响应不含路径或密钥。

启用步骤和变量表在 `docs/ops/auto-deploy.md`。当前已经打开的守护窗口要先手动更新并重新打开，才会开始自动部署。之后发布用 `git push origin <commit>:deploy`。

`scripts/deploy-logic.ps1` 和 `scripts/test-deploy-logic.ps1` 含中文原因，必须以 UTF-8 BOM 保存。Windows PowerShell 5.1 遇到无 BOM 文件会按系统 GBK 分词，引号被吃掉后守护脚本无法启动。

同一版 PowerShell 在 `$ErrorActionPreference = 'Stop'` 时，会把 `git fetch` 写到 stderr 的进度当成终止错误。守护循环只打印 `Auto-deploy error`，部署检查没有继续。`Invoke-AiCenterGit` 在调用 git 期间把错误动作改成 `Continue`，并只保留 stderr 原文。

守护循环里 `git fetch` 的 stderr 在 Windows PowerShell 5.1 上会被收成错误记录。脚本顶层 `$ErrorActionPreference = 'Stop'` 时，成功 fetch 打出的进度也会变成终止错误。外层 catch 原先只打印固定的 `[!] Auto-deploy error.`，状态文件没有机会写上。现在 stderr 改写入临时文件，退出码照常返回；catch 会打印异常消息、`InvocationInfo.PositionMessage` 和 `ScriptStackTrace`，并写入 `deploy-status.json` 的 `state=error`、`error`、`at`。锁文件仍留下第一次窗口的 PID。PID 不存在、不是 PowerShell，或旧于 `AI_CENTER_DEPLOY_LOCK_MINUTES`（默认 30，限制 5–240）时接管；当前守护进程自己持有锁时可以重入，`finally` 释放。
