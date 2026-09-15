# AI Center

AI Center 是一个从零开始的本地信息中枢。

第一版只验证一条最小链路：

```text
本地服务器 -> 手机直连 -> 信息展示 -> 快速发布 -> 两端实时同步
```

本仓库暂不迁移 `F:\AI` 或 `F:\Fintech\AI-Hub` 的既有功能。旧仓库仅作为后续能力接入时的参考来源。

## 文档入口

- [文档索引](docs/README.md)
- [第一版产品范围](docs/product-v1.md)
- [目标架构](docs/architecture.md)
- [连接、配对与安全](docs/connection-and-pairing.md)

## 当前状态

第一版连接原型已经可以运行：

- 本地 SQLite 信息流。
- 本机生成 10 分钟一次性配对二维码。
- 手机长期设备授权与撤销。
- 桌面和手机快速发布。
- SSE 实时同步与自动重连。
- 24 小时用户行为验证指标。

## 启动

需要 Node.js 22.13 或更高版本。

```powershell
npm install
npm start
```

启动后在本机打开 `http://127.0.0.1:8787`。页面会显示当前局域网二维码，手机和电脑需连接同一网络。

运行验证：

```powershell
npm run check
```
