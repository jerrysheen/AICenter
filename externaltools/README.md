# Vendored host tools

## BrowserSkill CLI

`bsk.exe` 是 AI Center 在 Windows 上连接 BrowserSkill daemon 的默认 CLI。它随仓库分发，便于其他 Windows 主机直接复用；`AI_BSK_PATH` 仍可覆盖默认路径。

当前文件记录：

```text
platform: Windows
size: 14010368 bytes
sha256: 7463773AB33E9076641A994378030E59E0B785C79F6C2532C9CBBE47F60F2972
embedded version: unavailable
```

该二进制由仓库维护者明确批准 vendoring。替换时必须同时更新本文件中的大小、SHA-256、可获得的上游版本/来源信息，并重新运行 `npm run check`。不得在此目录保存浏览器 Profile、Cookie、Token、日志或其他主机运行状态。
