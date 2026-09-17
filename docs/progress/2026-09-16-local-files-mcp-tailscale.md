# 本机 Local Files MCP + Tailscale Funnel 流程落盘

## 目标

把「Tailscale Funnel → Local Files MCP」写成可复用配置提示，避免把本机 Origin 写进仓库。

## 决定

- 通用隧道步骤留在 Local Files MCP 自己的文档；AI Center 只写边界和「从本机状态抄配置」。
- 真实 Origin / Connector URL / 安装路径不写入本仓库。
- 与 AI Center 公网（Cloudflare → Web 端口）分开；Funnel 不要指到 AI Center。
- 该链路不是 AI Center 0.2.0 发布范围。

## 当时验证过的现象（不含私人标识）

- Funnel 必须转到 MCP 实际监听的本机端口；以 `tailscale funnel status` 为准。
- 公网 DNS 能解析 Funnel 边缘；个别解析器可能超时。
- 本机请求有时会走 Tailscale MagicDNS，ChatGPT 走的是公网 DNS 和 Funnel 边缘。
- 安装脚本会装虚拟环境并打开 GUI；日常只需 Funnel + GUI Start Server。
