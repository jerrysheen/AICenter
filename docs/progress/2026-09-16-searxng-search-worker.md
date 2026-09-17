# 本机 SearXNG Search Worker 与 web.search

## 目标

把联网检索做成 AI Center 的第三个本机进程，而不是 Docker 服务。Agent 通过稳定 Tool `web.search` 访问，Search 挂了不拖垮 Web / Worker。

## 决定

- 不使用 Docker、nginx、uWSGI、Valkey。
- SearXNG 源码和 venv 放在 `.ai-data/searxng/`，不进 Git。
- 仓库只保存 `scripts/setup-searxng.ps1`、`scripts/start-searxng.ps1`、`scripts/searxng-process.ps1` 和 `config/searxng-settings.yml`。
- 监听 `127.0.0.1:8888`。启动器按命令行同时包含 `.ai-data\searxng` 和 `searx.webapp` 识别进程，不按 `python.exe` 批量结束。
- Connector：`packages/connectors/src/searxng.js`。Source：`search.web`。兼容 Tool：`web.search`。`webMode=off` 不暴露工具。

## 改动

- 启动器与安装脚本
- `packages/connectors/src/searxng.js`、`packages/source/src/search/definitions.js`、Web/Worker 组装、`local-tools.js`、`agent-runtime.js`
- 问答页联网模式选择
- `docs/architecture.md`、`architecture-modules-v1.md`、`ai-development-guide.md`、`contracts-v1.md`

## 验证

- `npm run check`
- 未安装 SearXNG 时启动器应打印 Search unavailable，Web 仍可用
- 第一次联网前需本机 Python 3.10+，并运行 `scripts\setup-searxng.ps1`

## 后续

- 用户在本机执行一次 setup，确认 `http://127.0.0.1:8888/search?q=test&format=json`
- Windows：`git clone --config core.protectNTFS=false`（`*:socket` 模板文件）；venv 写入 `pwd.py` 垫片（SearXNG `valkeydb` 依赖 Unix `pwd`）
- 已在本机 Python 3.11.9 完成 setup，Search Worker 可启动并返回 JSON
- 已统一为 `search.web` Source；`web.search` Tool ID 与网页证据校验保持不变
