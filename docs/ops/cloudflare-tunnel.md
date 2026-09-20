# 本机 cloudflared 公网隧道

这是 AI Center 的可选公网入口。安全边界、配对规则和验收清单以 `docs/public-access-security.md` 为准。

真实 Hostname、Tunnel token、Tunnel ID 只放在本机 `.ai-data/cloudflare/` 或未提交的 `.env`，不要写入 Git。

## 本机基建

1. 运行 `scripts/setup-cloudflared.ps1`。脚本会安装 `cloudflared`，并创建 `.ai-data/cloudflare/`。
2. 在 Cloudflare Zero Trust 创建 Named Tunnel，Public Hostname 只绑定一个精确主机名，Service 填 `http://127.0.0.1:8787`。
3. 把控制台复制的 token 写入 `.ai-data/cloudflare/tunnel.token`，或执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-cloudflared.ps1 -Token <token>
```

4. 未提交的 `.env` 填写 `AI_CENTER_PUBLIC_URL=https://center.example.com`（换成你的主机名，不要带路径）。
5. 本机已有 token 或 `config.yml` 后，双击 `start-ai-center.bat` 会在 Web 健康检查通过后探活或拉起隧道。也可单独运行 `scripts/start-cloudflared.ps1`。Ctrl+C 停止 Web/Worker 时不拆隧道。
6. 重启 AI Center，桌面配对页应优先显示公网 HTTPS 二维码。

Quick Tunnel 不支持 SSE，不能当正式入口。

## 不要做

- 不要把 Tunnel 指到 Worker、Search、浏览器调试口或 Local Files MCP。
- 不要使用泛域名。
- 不要把 token 或真实 Hostname 贴进聊天、Issue 或仓库。
- 不要用 Tailscale Funnel 替代这条入口。
