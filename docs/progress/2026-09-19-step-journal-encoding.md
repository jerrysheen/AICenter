# 2026-09-19 步骤拆解乱码

上一轮 CLI 用 PowerShell `Add-Content` / `>>` 按系统 ANSI（GBK）追加 `steps.jsonl`，Node 再按 UTF-8 读，步骤拆解出现替换字符。`parent-trace.json` 快照也把乱码写进去了。

## 决定

- 读 `steps.jsonl` 按行：合法 UTF-8 先用；无效则按 GBK。不改已有行。
- `GET /trace` 的 `parentTrace` 若摘要含 `U+FFFD`，回读父目录原文件。
- 提示词要求后续追加必须 UTF-8 无 BOM；可见窗口把 `Add-Content` 默认改成 utf8。

## 验证

`npm test -- test/work-package.test.js`
