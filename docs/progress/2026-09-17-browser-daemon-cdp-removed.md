# Browser daemon 接入与拆除 Chrome CDP

## 目标

1. 把 BrowserSkill daemon 纳入 `start-ai-center.ps1`，Worker 连接同一 daemon。
2. 用真实 `bsk` session 探测 B站 / X 登录连通性。
3. 删除 AI Center 内旧 Chrome CDP（9222 / profile / spawn / legacy-cdp）。

## 决定

- 启动器优先复用已在运行的 daemon；没有才 `bsk daemon start --foreground --daemon-idle 7d`。
- Worker / Web 仍设 `BSK_AUTO_START=0`，只连接不偷启。
- 扩展未连接不阻止 Web/Worker 启动，启动器打印明确警告。
- 关闭 AI Center 时只停我们拉起的 daemon，不杀用户自己的 BrowserSkill。
- X 不再 `require` 旧仓 `pull-Twitter`；页面解析迁入 `packages/connectors/src/x/home-browser.js`，走 `browserRuntime.evaluate`（DOM，不再做 CDP Network.getResponseBody）。
- `AI_BROWSER_PROVIDER` 只接受 `bsk`。

## 连通性

```text
node scripts/probe-browser-runtime.mjs
```

依次打开 B站、X，只报告 `loggedIn` 布尔值，不打印 Cookie。扩展未连接时退出码 1。

## 验证

`npm run check`。
