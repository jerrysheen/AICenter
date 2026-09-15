# 新仓库初始化

## 目标

建立 AI Center 独立仓库的第一版产品、架构、连接与安全文档，明确旧仓库暂不迁移。

## 决定

- 新仓库位置为 `F:\AI-Center`。
- 第一版采用本地 Web 服务、响应式页面和鸿蒙 ArkWeb 薄壳。
- 二维码只用于首次配对。
- 配对码 10 分钟有效且一次性使用。
- 设备授权默认长期有效，实时连接断开后自动恢复。
- 第一版仅支持同一局域网，不开放公网。
- 文档统一位于 `docs/`，入口记录在根目录 `AGENTS.md`。

## 本次文件

- `README.md`
- `AGENTS.md`
- `.gitignore`
- `data/.gitkeep`
- `docs/README.md`
- `docs/product-v1.md`
- `docs/architecture.md`
- `docs/connection-and-pairing.md`
- `docs/progress/2026-09-15-repository-bootstrap.md`

## 验证

- 已检查目标目录原本为空。
- 已建立文档入口和第一版验收标准。

## 下一步

搭建 Web 服务、SQLite、连接状态页和第一条本地测试信息。
