# AI Center

AI Center 是本机信息中枢：网页与鸿蒙共用同一套 Web UI，数据在本地 SQLite，后台任务由 Worker 执行。

当前版本是 **0.2.0 基线候选**。连接闭环已经可用，现阶段进入隐私、安全和稳定性验收，不继续扩大功能。

当前仓库按**私有代码与 Instance 配置仓库**维护：除 Core 代码外，还版本化当前单用户 Instance 的 Knowledge 文件、个人 Catalog、必要导入资料和附件。运行中的 SQLite 数据库只保存在本地，持续接收采集、翻译、标签及其他业务写入，不提交 Git，也不启用 LFS；换机恢复业务数据需另外迁移一致数据库备份。`.env`、API Key、Token、Cookie、浏览器 Profile、WAL/SHM、PID 和运行日志仍只在各主机本地配置或生成。未来抽取只含工具的通用 Core 是另一项独立工作。

## 文档入口

```text
README
  → docs/README
  → docs/release-readiness   当前问题与验收状态
  → architecture / modules / contracts
  → 专题文档
```

- [文档索引](docs/README.md)
- [发布门槛](docs/release-readiness.md)
- [架构](docs/architecture.md)
- [连接、配对与安全](docs/connection-and-pairing.md)

`docs/plan/` 与 `docs/progress/` 保留历史，不驱动当前开发。

## 当前状态

已具备、需按发布门槛验收：

- 本地 SQLite；重启后信息、设备授权和采集结果仍在。
- 本机一次性配对二维码、长期设备授权与撤销。
- 桌面和手机快速发布；SSE 实时同步与自动重连。
- 独立 Worker、单 Agent 问答、信息流/行情 Adapter（雪球优先，同花顺回退）。
- 鸿蒙薄壳；系统分享先写入本机 Outbox，授权恢复后再上传。

旧 AI / AI-Hub 仓库只作 Adapter 参考，不作为本仓副本；参考路径只从环境变量读取。

## 启动

需要 Node.js 22.13 或更高版本。

Windows 推荐直接双击仓库根目录的 `start-ai-center.bat`。启动器会结束旧的 AI Center Web/Worker 实例、后台启动当前仓库的两个服务、执行健康检查，并显示电脑和手机访问地址。本机已配置 `cloudflared` 时也会探活或拉起公网隧道，但不会在 Ctrl+C 时拆掉。它不会结束其他 Node 服务；如果端口 `8787` 被无关程序占用，会提示后停止。BrowserSkill 扩展还没连上、且专用用户目录的 Chrome 没在运行时，启动器会用该目录拉起 Chrome（默认 `.ai-data\chrome-profile`，不打开调试端口）；可用 `AI_CENTER_SCRAPE_CHROME_PROFILE_DIRECTORY` 指定 `Default`、`Profile 1` 或 `Profile 2`。目录设成日常 Chrome 的 User Data 时，已经打开、且命令行没有 `--user-data-dir` 的那只 Chrome 算正在使用，不再另开。这个窗口每约 60 秒再查一次，连续约 3 次仍没有浏览器就再拉起一次。

运行日志和进程记录保存在本机 `.ai-data/`，不会进入 Git；`data/ai-center.db` 同样只在本地保存，数据库结构和前向 migration 随代码版本化。

首次运行仍需安装依赖：

```powershell
npm install
```

也可以用两个终端手动启动：

```powershell
npm start
npm run start:worker
```

启动后在本机打开 `http://127.0.0.1:8787`。页面会显示当前局域网二维码，手机和电脑需连接同一网络。

运行验证：

```powershell
npm run check
```

## 迁移到另一台 Windows 主机

私有仓库克隆后包含 Knowledge 文件、个人 Catalog、资产导入资料和 `externaltools/bsk.exe`，不包含当前业务数据库。新主机先完成机器相关配置：

```powershell
npm install
Copy-Item .env.example .env
```

随后在 `.env` 中填写该主机需要的 API Key、服务地址和可选路径，再运行 `start-ai-center.bat`。浏览器扩展、BrowserSkill 连接、站点登录态、鸿蒙/浏览器重新配对和可选 SearXNG 环境需要在新主机重新建立；Cookie、浏览器 Profile、`.ai-data`、WAL/SHM、PID 和日志不会通过 Git 迁移。

要恢复已有文章、译文、标签、笔记、持仓及任务状态，应在源主机使用 SQLite 在线 backup 生成一致备份，在目标主机启动服务前恢复到其 Instance 数据库路径。不要直接复制运行中的 `.db` 并遗漏 WAL，也不要把运行目录整体上传 Git；没有恢复备份的新主机会通过既有 migration 初始化空库。
