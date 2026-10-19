# 取消的看板不要盖掉缓存，雪球头像升到 https

2026-10-19 快照任务的 `refresh` 带 20 秒 AbortSignal。别的请求如果碰到同一个键，会复用这次进行中的读取。超时后 Yahoo 可能只返回已经到手的一部分。看板会把没到手的代码补成空价，再写进缓存，把上一版完整看板盖掉。

现在这条 signal 已经取消时，成功返回和迟到返回都不写缓存。调用方仍拿到这次的结果。下一轮没有 `refresh` 的读取继续用上一版完整看板。没有 signal 的迟到结果仍会写入，超时后到齐的完整报价不受影响。

`http://xavatar.imedao.com/...` 收成 `https://xavatar.imedao.com/...`。别的 http 地址不动。回填脚本用同一条规则，可重复，`--dry-run` 不落库。CSP 已经只放行 https，不用再改。

不新增 migration。不要重建数据库。需要同时重启 Web 和 Worker。已经跑过雪球头像回填的，再跑一次：

`node scripts/backfill-xueqiu-avatars.mjs --dry-run`

`node scripts/backfill-xueqiu-avatars.mjs`
