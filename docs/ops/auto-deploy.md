# Windows 守护脚本自动部署

`scripts/start-ai-center.ps1` 在服务健康之后，于原来的守护循环里检查部署引用。日志仍按天追加并保留 7 天。`-WorkerOnly` 和 `restart.worker.request` 仍只重启 Worker。自动部署如果需要重启，会同时重启 Web 和 Worker。Search、Browser、Tunnel 不跟着停。

自动部署不读取、不修改 `.env`。`.env` 里的配置变化不会被拉下来，也不会从 `.env` 里取下面这些变量。变量要放在启动守护窗口的进程环境里。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_CENTER_AUTO_DEPLOY` | 开启 | `0`、`false`、`off`、`no` 关闭自动部署 |
| `AI_CENTER_DEPLOY_INTERVAL_SECONDS` | `90` | 两次 `git fetch` 的间隔，限制在 60–120 秒 |
| `AI_CENTER_DEPLOY_REF` | `origin/deploy` | 要跟上的引用。`origin/<分支>` 跟踪远端分支；`deploy-*` 这种带 `*` 的值改取最新匹配标签；`deploy-2026-10-12` 这种没有 `*` 的名字跟踪这一枚标签 |
| `AI_CENTER_DEPLOY_BACKUP_KEEP` | `7` | 保留最近几份备份目录，范围 1–50 |
| `AI_CENTER_DEPLOY_LOCK_MINUTES` | `30` | 锁超过这个分钟数就视为过期并接管，范围 5–240 |

## 一次部署会做什么

1. `git fetch`。引用和当前 `HEAD` 相同就什么都不做。
2. `git status --porcelain` 有输出就放弃。`package-lock.json` 被 `npm install` 改过也放弃，并且不会自动还原。
3. 对比文件列表里出现 `.env` 就放弃。`.env.example` 可以部署。
4. 当前 `HEAD` 必须是目标提交的祖先，然后 `git merge --ff-only`。不能快进就放弃，不用 `reset` 把工作区拨过去。
5. 快进前，把数据库、`*-wal`、`*-shm` 和 `.env` 复制到 Instance `data/deploy-backups/<时间戳>/`。这是文件副本，服务当时还在跑。
6. `package-lock.json` 变了才运行 `npm ci`。
7. 变更如果都在 `apps/web/public/` 下面，不重启。其他文件会重启 Web 和 Worker。
8. 用启动器已有的健康检查轮询，最长 90 秒。失败就 `git reset --hard` 回到上一个提交，需要的话再 `npm ci`，重启后再检查一次。
9. 把结果写入 Instance `data/deploy-status.json`。相同的失败不重复追加。历史最多 20 条。

部署用当前 Instance 的 `runtime/deploy.lock`（旧布局是 `.ai-data/deploy.lock`）保证同一时间只有一个。锁文件里是 PID 和 UTC 时间。PID 对应的进程不存在、进程不是 `powershell` / `pwsh`，或锁超过 `AI_CENTER_DEPLOY_LOCK_MINUTES`，这次检查会接管。守护进程自己的 PID 可以重入。部署结束时在 `finally` 里释放。守护循环在部署期间看到进程退出，不会把它当成崩溃再拉起一轮。

状态字段：`commit`、`previousCommit`、`ref`、`startedAt`、`finishedAt`、`ok`、`restarted`、`rolledBack`、`reason`、`npmCi`。`reason` 不含路径或密钥。自动部署抛出的异常另记 `state`（`error`）、`error` 和 `at`。`error` 保留异常消息、脚本行和调用栈，并去掉 URL 里的账号密码和 `password` / `token` / `Bearer`。

`GET /api/v1/runtime/deploy-status` 返回这份文件。要有登录或配对得到的设备会话。本机回环地址、`X-Forwarded-For` 和 `CF-Connecting-IP` 都不能代替登录。文件不存在或读不出来时返回 `{ "ok": true, "current": null, "history": [] }`。

## 第一次启用

在 Windows 服务器上，先手动把仓库更新到包含本脚本的提交，再关掉旧的守护窗口，重新打开。已经开着的窗口不会自己换成新脚本。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-ai-center.ps1
```

在要发布的机器上创建 `deploy` 分支，指向这次已经手动部署好的提交：

```powershell
git push origin <commit>:deploy
```

以后发布同一条历史上下一个提交：

```powershell
git push origin <commit>:deploy
```

服务器大约 90 秒内 fetch 到新提交。不能快进的推送会被放弃，例如把 `deploy` 拨到另一条历史上。

改用标签时，在守护进程环境里设置：

```powershell
$env:AI_CENTER_DEPLOY_REF = 'deploy-*'
```

然后推送 `deploy-` 开头的标签。守护脚本选创建时间最新的一枚；时间相同则按标签名倒序。

要关掉自动部署：

```powershell
$env:AI_CENTER_AUTO_DEPLOY = '0'
```

这些赋值要在启动脚本之前执行，或者写进启动该窗口的系统环境。不要写进 `.env`。
