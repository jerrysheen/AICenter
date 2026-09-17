# BrowserRuntime 与 B站迁移

> 收束：`legacy-cdp`、9222 和 `bilibili/chrome.js` CDP 实现已删除，见 `2026-09-17-legacy-browser-removed.md`。下文保留当时决策。

## 目标

在 Connector 基础设施层新增统一 `BrowserRuntime`，并增加 BrowserSkill/`bsk` Provider。只把 Bilibili 已登录浏览器访问迁过去。不给 Agent 增加 Browser Tool，不改 Source ID，不加 migration。

## 决定

- BrowserRuntime 只存在于 `packages/connectors/src/browser/`。Source、Domain、Runtime、Agent Tool 不知道 BrowserSkill。
- `withSession` 统一 start / callback / finally stop。业务 Connector 不自己管理 session 生命周期。
- Provider 由 `AI_BROWSER_PROVIDER=bsk|legacy-cdp` 显式选择。默认 `bsk`，失败不自动 fallback。
- `bsk` 通过 `execFile(..., { shell: false })` 调用；Worker/Web 设置 `BSK_AUTO_START=0`，不在业务请求里偷偷拉 daemon。
- 旧 `bilibili/chrome.js`、`.ai-data/chrome-profile`、`AI_CHROME_*` 保留给 `legacy-cdp`。
- 本轮不迁 X，不删 9222 / Chrome PID 逻辑。

## 调用链

```text
Composition Root（web / worker）
  → createConfiguredBrowserRuntime()
  → createSourceModuleRegistry({ browserRuntime })
  → BilibiliService
  → browserRuntime.withSession({ purpose: 'bilibili.subtitle' })
       provider=bsk → bsk CLI → daemon → Extension → 已登录 Chrome
       provider=legacy-cdp → 现有 CDP 9222
```

## 改动

- 新增 `packages/connectors/src/browser/*`
- Bilibili `subtitle.js` 改为依赖注入的 `browserRuntime`
- Web / Worker Composition Root 创建一次 Runtime
- `scripts/start-ai-center.ps1` 增加 `AI_BROWSER_PROVIDER` 与 `BSK_AUTO_START=0`；Chrome 环境变量仍写入
- `system.healthcheck` 把 `browserRuntime.health()` 写入 `provider_health`（id=`browser`）
- 测试：`test/browser-runtime.test.js`

## 运行前置

1. 仓库随附 Windows `externaltools/bsk.exe` 作为默认 CLI，方便其他 Windows 主机直接复用；也可设 `AI_BSK_PATH` 覆盖。
2. 先在本机启动 BrowserSkill daemon（本轮启动器不代管）。
3. Chrome 安装 BrowserSkill 扩展，并连接到 daemon。
4. 目标站点登录态留在该 Chrome Profile 中。

临时回滚路径已取消：`AI_BROWSER_PROVIDER` 只接受 `bsk`。

## 验证

见本轮 `npm run check`。

## 后续

- 已完成：X 迁入 BrowserRuntime；启动器代管 daemon；拆除 Chrome CDP。
