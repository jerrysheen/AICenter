# 公网访问与安全边界

## 当前结论

默认情况下 AI Center 仍然只有局域网入口。`192.168.x.x`、`10.x.x.x` 和 `172.16-31.x.x` 都是私有地址，
手机离开家庭网络后无法路由到这些地址，因此外网扫描局域网二维码一定失败。

禁止直接在路由器上把 8787 端口转发到公网。推荐使用：

```text
Harmony / Browser
        │ HTTPS
        ▼
Cloudflare Edge / 可选 Access
        │ 出站 Tunnel
        ▼
cloudflared（本机）
        │ http://127.0.0.1:8787
        ▼
AI Center Public Gateway
```

Cloudflare Tunnel 由本机主动向外建立连接，不要求公网 IP 或开放入站端口。公网 Hostname 只映射 AI Center Web 端口，
不能映射 Worker、SQLite、浏览器调试口、旧 AI/AI-Hub 服务、本机管理端口、只做重启的第二端口，或 Local Files MCP 的本机监听口。
远端需要弹 Web/Worker 时走已配对的 `POST /api/v1/runtime/restart`（仍是 8787）；进程挂了由本机启动器弹回，隧道不关。

ChatGPT 访问本机文件走另一条可选链路：Tailscale Funnel → `local-files-mcp`。怎么配见 `docs/ops/local-files-mcp-tailscale.md`。那条 Funnel 不要指到 AI Center Web，也不列入 0.2.0 发布验收。仓库说明里不得写入真实 Hostname 或 Origin。

官方参考：[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)、
[创建 Named Tunnel](https://developers.cloudflare.com/tunnel/get-started/)、
[保护 Self-hosted Application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、
[Windows 服务](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/windows/)。

## 为什么不能直接给原有 8787 套隧道

旧实现按 TCP 来源地址判断本机管理员。反向隧道连接 Origin 时来源可能是 `127.0.0.1`，如果不区分代理请求，
公网访客就可能被误认为桌面管理员。

当前实现已经增加公网请求隔离：

- 带 Cloudflare 代理标记或访问配置的公网 Hostname 永远不是桌面管理员。
- 未配对公网请求访问业务 API 返回 401。
- 已配对或账号登录后的手机访问桌面管理 API 返回 403。
- 账号密码登录与扫码配对签发同一类设备授权，不能把公网请求升级成本机管理员。
- `/api/v1/pairing`、设备管理、指标和 Runtime 状态不能从公网调用。
- 公网健康检查不返回电脑主机名。

这层隔离必须保留。不能通过信任任意 `X-Forwarded-*` 请求头重新获得管理员身份。

## 调用方能力平面（Agent / Host）

HTTP 桌面管理隔离解决的是「公网请求不要变成电脑管理员」。生产执行器换成 DeepSeek Harness 之后，还要挡住另一条路径：**已配对的公网设备去驱动本机高权限 Agent**。

配对只证明「这台设备可以使用这个 Instance」，不证明「这个调用方可以改仓库、跑 Shell、或当成本机编码 Agent」。工作包今天会拉起 `agent -p --force --trust`；Harness 的 `dsh-base` 默认还带 bash / 写盘 / subagent。这两类能力都作用在 Host 上，不能跟问答、信息流共用「已配对即可执行」。

不建设 User、Tenant、权限后台。继续用现有身份：未配对 / 已配对设备 / 桌面管理员。在此之上增加第三平面：

```text
网络平面     loopback / 局域网 / 公网 Tunnel
身份平面     unpaired / paired-device / desktop-admin
能力平面     device-operate / desktop-host
```

```text
公网 / 局域网手机
        │ 已配对设备授权
        ▼
  device-operate
        │ Ask / 文章阅读 / 业务写入
        ▼
  DeepSeek Harness（Ask overlay）
        │ Domain Tool Gateway + 内置 web_search / web_fetch
        ▼
持仓 / 知识 / 信息流 / memory.save / 公开网页

本机桌面（loopback，且不是公网代理）
        │ desktop-admin
        ▼
  desktop-host
        │ 工作包派发 / 进程重启 / 可选 Host Tool
        ▼
Cursor CLI --force --trust
或未来打开的 Harness bash / fs / workspace-write
```

### 能力剖面

| 剖面 | 谁 | 可以做 | 不可以做 |
|---|---|---|---|
| 未配对公网 | 无设备 Cookie | 健康检查、配对、登录、静态页 | 任何业务 API、任何 Agent Job |
| `device-operate` | 已配对设备（公网或局域网手机） | Ask、文章阅读、信息流、灵感/知识、`memory.save` | Host 作用：改代码、Shell、写盘、subagent、派发工作包、手动重启进程 |
| `desktop-host` | 本机 loopback，且请求不是公网代理 | 上面全部，外加 Host 作用 | 仍禁止 `destructive` Domain Tool；默认不要 `danger-full-access` |

`desktop-host` 只来自身份平面的 `desktop-admin`（loopback 且 `isPublicRequest=false`）。局域网已配对手机仍是 `device-operate`：人在家里不等于本机管理员。公网账号登录与扫码一样，只签发设备授权，不能升级成 `desktop-host`。

Host 作用（必须 `desktop-host`）：

- 入队或执行 `work-package.dispatch`（本机 Cursor CLI `--force --trust`）
- 为 Ask / 文章阅读打开 Harness 内置 bash、pwsh、fs、skill、subagent、workflow
- 把某次 dsh Session 调到 `workspace-write` / `danger-full-access`
- `POST /api/v1/runtime/restart` 以及读取 Runtime / Job / 指标
- 生成配对码、列出或撤销设备（现有桌面管理 API）

Instance 作用（`device-operate` 允许）：

- `ai.agent.run` / `ai.article.analyze`，可见 Domain Tool 经 Gateway；公开互联网使用 Harness 内置 `web_search` / `web_fetch`
- `memory.save` 以及灵感、知识、信息流等业务写入
- 创建或查看工作包记录、读取 `/trace`
- 不能把「写下一条任务」自动变成「在这台电脑上改代码」

工作包拆成两步：已配对设备可以创建/继续一条 Knowledge 工作包；**派发**（`notify` → `work-package.dispatch`）只允许 `desktop-host`。Worker 退出后写 `runtime/restart.request` 仍由本机启动器执行，不需要公网再调重启接口。

### 执行点

安全边界按执行点强制，不靠提示词。

1. **Web 入队**：创建 Job 时写入本次 `callerCapability`。`device-operate` 不得入队 Host 作用 Job。
2. **Worker 失败关闭**：handler 读取 Job 上的能力字段；不足则失败，不执行 Cursor CLI，也不拉起带 Host Tool 的 dsh。Job 入参不能把能力写高。
3. **Harness overlay**：`device-operate` 继续用当前 `aicenter.cordis.yml`，禁用 bash / fs / subagent。公开互联网是基建，不关 `@deepseek-ai/dsh-tool-web`。这不是 dsh 的 `read-only`：`read-only` 仍可能暴露读盘。公网 Ask 不要注册 Host 工具。
4. **Tool Gateway**：本机 loopback + 单次 token 之外，还要按本次 Run 的能力拒绝 Host Tool；目录泄漏也不能执行。
5. **Session 复用**：dsh 子进程只在同一能力剖面、同一可见 Tool 集合内复用。剖面或 allowlist 变化则重启子进程。禁止把公网 Ask 接到刚跑过 Host Tool 的 Session。

System Prompt 里的「不要调用 shell」只是产品说明，不是边界。Cloudflare Access 仍然推荐，但它挡的是未登录访客；Access 通过之后仍是 `device-operate`。

### 与 DeepSeek Harness Permission 的关系

Harness 自己的预设是 sandbox 模式 × 审批策略，例如 `workspace-write` + `ask`，或 `danger-full-access` + `never`。那是 **Host 编码 Agent** 的旋钮，不是 AI Center 公网授权。

- 公网 / 已配对设备 Ask：**不要**进入 Host Permission 预设。用 AI Center overlay 关掉 bash / fs / subagent，保留内置 web，Domain 走 Gateway。
- 本机以后若要把 Ask 当编码 Agent：只允许 `desktop-host`，默认最多 `workspace-write` + `ask`。`danger-full-access` + `never` 不作为产品默认，更不能从远端打开。
- 不把 dsh Permission 选择器暴露给公网页面。
- 不 fork Harness core；能力收缩放在 profile patch、Session 隔离和 Job 入队。

### 现状与兼容

当前实现仍允许已配对公网设备 `POST /notify` 派发工作包，以及 `POST /api/v1/runtime/restart`。Ask overlay 已经关掉 Harness Host 工具，但工作包这条 Host 路径还开着。本文是冻结目标；落地时只收 Host 作用，不收回公网问答、信息流和知识。

## 公网配对

配置 `AI_CENTER_PUBLIC_URL` 后，桌面生成二维码时公网地址排在第一位：

```text
https://center.example.com/?pair=<一次性随机凭证>
```

安全规则：

- 公网凭证使用 32 字节随机数，不使用六位码。
- 默认 2 分钟过期。
- 使用一次后立即失效。
- 非本机来源 5 分钟最多尝试 10 次。
- 公网接口拒绝用六位局域网码兑换授权。
- 长期设备 token 只通过 HttpOnly Cookie 下发，数据库只保存哈希。
- 公网同时下发 `__Host-` Cookie 和一份同值的 `Secure` 设备 Cookie。
- 公网入口必须是 HTTPS。Cloudflare 打开 Always Use HTTPS；源站在看到 `X-Forwarded-Proto: http` 时把页面 308 到配置的 `https` 域名。
- 公网稳定域名不随家庭 IP 改变，因此正常重启或宽带换 IP 不需要重新扫码。

公网一次性凭证会短暂出现在二维码 URL 中，因此 Cloudflare 和 Origin 日志不得记录完整 Query String；凭证使用后应视为失效，
但仍不应把它复制到聊天、Issue 或 Git。

## 两种防护等级

### 推荐：Cloudflare Access + AI Center 设备授权

第一层由 Cloudflare Access 只允许你的邮箱或身份提供商通过，第二层再执行 AI Center 扫码配对。

优点：

- 未通过 Cloudflare 身份验证的请求到不了应用。
- 可以在 Cloudflare 侧撤销登录和查看访问记录。
- 即使一次性配对 URL 泄露，也需要先通过 Access。

代价：首次使用以及 Access Session 到期后，鸿蒙 ArkWeb 需要完成一次 Cloudflare 登录。必须用真机验证登录跳转、Cookie 和 SSE；
Access 登录不是 AI Center 重新配对，两者生命周期独立。

### 简洁模式：Tunnel + AI Center 设备授权

无需 Cloudflare 登录，扫码后直接进入应用。安全性依赖高熵配对凭证、设备 token、限速和 Cloudflare 边缘防护。
体验更顺，但对所有互联网用户开放静态页面、健康检查、`/api/v1/ui/revision` 和配对兑换入口。界面指纹接口只返回哈希，不含主机名。

金融数据长期使用时优先选择双层防护。

## 用户执行：Cloudflare 配置

以下步骤需要用户在 Cloudflare 控制台和 Windows 管理员终端执行，Agent 不接管桌面：

1. 准备 Cloudflare 账号和一个托管在 Cloudflare 的域名。
2. 在 Zero Trust / Networking / Tunnels 创建 Named Tunnel，例如 `ai-center-home`。
3. 添加精确的 Public Hostname，例如 `center.example.com`。
4. Service URL 设置为 `http://127.0.0.1:8787`。
5. 只配置这一个精确 Hostname，并保留最终 `http_status:404` catch-all；不要使用泛域名把其他本机服务带出去。
6. 推荐先创建 Cloudflare Access Self-hosted Application，只允许自己的邮箱。
7. 本机先跑 `scripts/setup-cloudflared.ps1`：安装 `cloudflared`，并准备 `.ai-data/cloudflare/`。把 Zero Trust 复制的 token 写入 `.ai-data/cloudflare/tunnel.token`，或使用本机 Named Tunnel 的 `config.yml`。之后 `start-ai-center.bat` 会在 Web 就绪后探活或拉起隧道。也可单独跑 `scripts/start-cloudflared.ps1`。Tunnel token 是敏感凭证，不能写入仓库、截图或聊天。
8. 启动 AI Center 前设置：

```powershell
$env:AI_CENTER_PUBLIC_URL = 'https://center.example.com'
```

9. 重启 AI Center，桌面配对页应优先展示公网 HTTPS 二维码。

不要使用 Quick Tunnel 作为正式方案：随机域名每次可能变化，并且官方文档明确 Quick Tunnel 不支持 SSE；AI Center 的实时信息流依赖 SSE。

## 验收清单

必须在手机关闭 Wi-Fi、使用移动网络时验证：

1. 公网二维码打开 `https://` 稳定域名。
2. 未配对时只能看到配对状态，读取 `/api/v1/posts` 返回 401。
3. 公网无法访问 `/api/v1/pairing`、`/api/v1/devices`、`/api/v1/runtime`。
4. 扫码或账号登录后可以读取信息、发布并收到 SSE。账号登录不能调用桌面管理 API。
5. 已配对公网设备可以问答和创建工作包记录，但不能 `notify` 派发 Cursor CLI，也不能手动重启进程。
6. 公网 Ask 的 dsh Session 看不到 bash / fs / subagent，但可以使用 `web_search` / `web_fetch`；本机若打开 Host Tool，不得把该 Session 复用给公网问答。
7. 重启 Web、Worker 和 cloudflared 后仍可连接，不重新扫码。
8. 撤销手机设备后，公网 Cookie 立即失效。
9. 错误配对超过限制后返回 429。
10. Cloudflare Tunnel 停止后公网不可达，但局域网功能仍然正常。

## 仍需外部决定

真正启用公网入口前必须确定：

- 公网域名，例如 `center.example.com`。
- 是否启用 Cloudflare Access 双层身份验证。
- Access Session 时长。
- cloudflared 作为 Windows 服务运行，还是开发阶段手工运行。

这些属于外部账号和部署状态，不能写死在代码或提交敏感 token。
