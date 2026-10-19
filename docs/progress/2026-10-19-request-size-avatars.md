# 请求体过大与头像地址

2026-10-19 翻译接口允许原文 200000 字，`readJson` 默认却只收 128KB。文章页打开 YouTube 正文时会把整篇原文自动 POST 到 `/api/v1/translate`。超限发生在请求体还没读完时，连接被掐断，cloudflared 报错，浏览器看到 502。行为事件的 8KB 上限走同一条读取。

现在先看 `Content-Length`。声明的长度或实际读到的长度超过上限时，把剩余请求体读完，再返回 413，消息仍是「请求内容过大」。不再中途停读。`/api/v1/translate` 的字节上限按 200000 字的 UTF-8（每字最多 4 字节）再加 16KB 信封计算，字符上限不变。YouTube（`platform` 或 `provider` 为 `youtube`）不再自动排队翻译。豆包整理不在这次改动里。

雪球头像只存了相对路径，有时是逗号连着的多个尺寸。页面会去请求站点自己的 `/community/...`。现在取逗号前第一段；以 `//` 开头的仍补 `https:`；没有协议的补 `https://xavatar.imedao.com/`。已入库的数据用手动脚本回填，可重复，`--dry-run` 不落库。脚本不进 Web 或 Worker 启动。

页面 CSP 的 `img-src` 增加 `https://pbs.twimg.com` 和 `https://xavatar.imedao.com`，没有改成通配。X 头像和补全后的雪球头像可以显示。

不新增 migration。不要重建数据库。空号仍是 63、79、80、82。88、89 不要占用。需要同时重启 Web 和 Worker，浏览器再加载一次。上线后先看会改多少行：

`node scripts/backfill-xueqiu-avatars.mjs --dry-run`

确认后再跑：

`node scripts/backfill-xueqiu-avatars.mjs`
