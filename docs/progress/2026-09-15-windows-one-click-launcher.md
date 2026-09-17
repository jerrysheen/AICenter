# Windows 一键启动器

## 目标

用一个可双击的批处理文件清理 AI Center 旧实例，并启动当前仓库的 Web 与 Worker，减少重复终端和端口冲突。

## 行为

- `start-ai-center.bat` 是用户入口，内部调用可维护的 PowerShell 启动逻辑。
- 双击后启动 Web、Worker 和 Search Worker；再次双击会先结束同类进程再拉起。
- 只停止命令行明确指向 `apps/web/src/server.js`、`apps/worker/src/worker.js`，或 `.ai-data\searxng` + `searx.webapp` 的进程；也会结束上次写入 `.ai-data/processes.json` 且仍占用 8787/8888 的 PID。
- 如果 8787 端口仍被无关程序占用，不结束该程序，直接提示用户。
- 双击 bat 时会新开一个 PowerShell 窗口（避免 cmd 收到 Ctrl+C 后整窗退出）。
- 启动成功后窗口保持打开；`Ctrl+C` 只停 Web / Worker / Search，然后在同一窗口按 Enter 即可再拉起。输入 `q` 后停在仓库目录，可用 `sa` 再启动。
- 不把服务留在后台然后立刻退出 PowerShell。
- PID 和日志写入被 Git 忽略的 `.ai-data/`。

## 安全边界

- 不按 `node.exe` 进程名批量结束进程。
- 不提交数据库、运行日志、PID、HarmonyOS 签名配置或构建产物。
