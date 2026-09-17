# 本机 Local Files MCP + Tailscale Funnel

这不是 AI Center 的公网入口。AI Center Web 仍走 `docs/public-access-security.md` 里的 Cloudflare Tunnel。本流程只给 ChatGPT Developer Mode 访问本机 `local-files-mcp`。

真实 Hostname、本机路径、Funnel Origin、Connector URL 只放在本机配置或 MCP 仓库自己的文档里，不要写入本仓库。

## 怎么配

1. 在 Local Files MCP 的 GUI 或配置里看清**本机监听地址和端口**（只绑回环即可）。
2. 用 Tailscale Funnel 把公网 HTTPS 转到**同一个端口**。在本机执行 `tailscale funnel status`，把显示的 Origin 抄下来；不要把 Origin 贴进 Git。
3. Funnel 打开后，再启动 MCP Server。只开隧道、服务没起来时，公网健康检查会失败。
4. MCP GUI 的 Public HTTPS URL 填上一步的 Origin，**不要**自己拼 `/mcp`。ChatGPT Connector 用 GUI 复制出来的完整地址。
5. 用完关掉 Funnel（`tailscale funnel --https=443 off`），再停 MCP Server。只关 GUI、Funnel 仍开着时，公网入口还在。

`tailscale serve` 只给 Tailnet，ChatGPT 到不了，需要 Funnel。免费 ngrok 每次换域名，不适合当固定 Connector。

## 不要和 AI Center 混用

- Funnel 只转到 Local Files MCP，不要指到 AI Center Web 端口。
- 不要把 MCP 接到 Cloudflare Named Tunnel 上的 AI Center Hostname。
- Funnel 打开期间，能解析该 Origin 的公网访客可以打到 MCP。
- 这条链路不列入 AI Center 0.2.0 发布验收。
