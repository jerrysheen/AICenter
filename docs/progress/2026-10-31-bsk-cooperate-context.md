# bsk 0.4 共享页动作补上下文

## 目标

BrowserSkill 升到 0.4 之后，共享页上的导航、脚本、点击和填写会被拒绝，除非带上最近一次 `cooperate sync` 返回的 `context_id`。一次上下文只够一个动作。

## 决定

动作被拒绝，并且原因是要最新上下文或页面已变，就先同步再重试。第二次仍被拒绝时，先 `cooperate wait` 再同步。同步没有返回上下文，就留下原来的错误。安静页面不拒绝时，仍按原来的命令直接执行，不先同步。

会话开关和健康检查不走这一步。

## 改动

- `packages/connectors/src/browser/browserskill-client.js`：导航、脚本、点击和填写走共享页重试。
- `test/browser-runtime.test.js`：拒绝后先同步，页面变化后再 wait，第三次带上新的 context。
- `externaltools/bsk.exe`：本机二进制换成 0.4。

## 验证

`node --test test/browser-runtime.test.js`

不新增 migration。当前 schema 仍是 98。下一号是 99。空号仍是 63、79、80、82。不要重建数据库。

## 部署

需要同时重启 Web 和 Worker。页面没有改。

## 遗留

扩展没连上时，这次重试解决不了连接问题。
