# 本机 cloudflared Host 基建

## 目标

把 Cloudflare Tunnel 的本机安装和 token 落盘收成 Host 脚本，避免把真实域名或 token 写进仓库，也不把隧道绑进 AI Center 启动器。

## 决定

- `cloudflared` 是可选 Host Service：不属于 Instance，不写入 `processes.json`，不随 `start-ai-center.ps1` 自动启动。
- 运行时只使用 `.ai-data/cloudflare/`；仓库只保留安装脚本和 `center.example.com` 占位模板。
- 域名、Named Tunnel 和 token 仍由用户在 Cloudflare 控制台创建。
- ingress 只允许 `http://127.0.0.1:8787`。

## 改动

- `scripts/setup-cloudflared.ps1`、`scripts/start-cloudflared.ps1`、`scripts/cloudflared-process.ps1`
- `config/cloudflared-config.example.yml`
- `docs/ops/cloudflare-tunnel.md`，并同步 `public-access-security.md`、`architecture.md`、`content-and-commit-guide.md`

## 本机状态

- 已用 winget 安装 `cloudflared` 2026.9.1。
- 运行时目录已创建；token 仍待用户从 Zero Trust 写入。

## 后续

- 用户在 Zero Trust 建好 Tunnel 后写入本机 token，再启动隧道并填写 `AI_CENTER_PUBLIC_URL`
- 手机关闭 Wi-Fi 按 `docs/public-access-security.md` 验收
