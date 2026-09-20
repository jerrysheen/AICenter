# 界面指纹稳定后再整页刷新

日期：2026-09-19

## 目标

远端改了 public 文件后，手机/公网客户端会强制换成新界面，但一次改多个文件或 SSE 重连时会连刷三四次。

## 决定

- 指纹仍按 public 文件 mtime/size 计算，不改 Contract / Service / Repository。这是 HTTP 静态资源层，不是领域写入。
- `ui-boot.js`、初始化 `maybeReloadStaleShell` 和 SSE `ready` 共用「先等指纹连续相同，再 `location.replace`」。进行中只允许一次重载，只提示一次「界面已更新」。
- 打开页面先等 boot 结果；boot 已经在换页时初始化不再重刷。长按刷新仍立即强制重载。

## 验证

- `npm test -- test/ui-revision-settle.test.js test/static-files.test.js test/event-stream.test.js`
- 连续保存多个 `apps/web/public` 文件时，远端应只整页刷新一次（或等写完后再一次），不应连刷三四次。
