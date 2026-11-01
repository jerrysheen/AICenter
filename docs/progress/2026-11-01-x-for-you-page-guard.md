# 推荐流不再因整页变动失败

## 目标

关注流刚成功时，推荐流在同一分钟失败，约 26 秒，新增 0。错误是 `The action's observed content changed; synchronize and replan`。

## 决定

BrowserSkill 0.4 未带 `--depends-on` 时核对整页。推荐流一直在插入新帖，同步快照马上过期，三次拒绝后整轮抛出。关注流变动少，所以同一分钟能过。

X 首页的导航、脚本、点击和填写改为只核对左侧 Home 链接。时间线文字继续变，不再挡住这次动作。这个选择器还不在页面上时，去掉收窄再试一次，登录墙仍走整页。

页面仍在动时，第一次拒绝就先 wait 再同步，并在命令时限内继续，最多 6 次。缺上下文的拒绝仍是先同步、第二次才 wait。

## 改动

- `packages/connectors/src/browser/browserskill-client.js`
- `packages/connectors/src/x/home-browser.js`
- `test/browser-runtime.test.js`
- `test/twitter.test.js`

## 验证

`node --test test/browser-runtime.test.js test/twitter.test.js`

不新增 migration。当前 schema 仍是 98。下一号是 99。空号仍是 63、79、80、82。不要重建数据库。

## 部署

只需要重启 Worker。页面没有改，Web 不用为这项重启。

## 遗留

扩展没连上时，这次收窄解决不了连接问题。
