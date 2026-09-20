# 启动器拉起可选公网隧道

## 目标

双击 `start-ai-center.bat` 时，本机已配置的 `cloudflared` 一并探活或启动，不必再单独跑隧道脚本。

## 决定

- 隧道仍是 Host Service：不写入 Instance `processes.json`，Ctrl+C 不停止。
- 仅当本机已有 token 或 `.ai-data/cloudflare/config.yml` 且 `cloudflared` 已安装时才拉起。
- Web 健康检查通过后再启动，避免 Origin 未就绪。

## 改动

- `scripts/cloudflared-process.ps1` 增加 `Test-CloudflaredConfigured` / `Start-AiCenterCloudflaredProcess`
- `scripts/start-ai-center.ps1` 与 SearXNG / Browser 一样探活或拉起
- `test/launcher-boundary.test.js` 锁定 Host 边界
