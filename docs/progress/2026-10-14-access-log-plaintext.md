# 访问日志补上明文来源

日期：2026-10-14

## 决定

- 每个 HTTP 请求仍在结束时追加一行 JSON 到 Instance `data/logs/access.yyyy-MM-dd.log`。日期仍按 Asia/Shanghai。
- 原有字段保留：`client` 仍是 `cf-connecting-ip` 的进程内 sha256 前 16 位，没有这个头就不记；`ua` 仍是 mobile / desktop / bot / other；`cfRay` 仍是合法的 `cf-ray`。
- 同一行增加 `ip`、`country`、`userAgent`。`ip` 优先采用合法的 `CF-Connecting-IP`，否则采用 `X-Forwarded-For` 逗号前的第一段，否则采用套接字 `remoteAddress`。不像 IP 的值跳过。`country` 是两位 `CF-IPCountry`，含 `T1`。`userAgent` 去掉换行和控制字符后截到 300 字。
- 不新增接口。`GET /api/v1/runtime/access-summary` 仍只返回按路径汇总的耗时，不返回 IP、国家或 User-Agent。`client-timing` 日志仍不写原始 IP。Cookie 和查询里的令牌仍然不写。

## 改动

- `apps/web/src/http/access-log.js`
- `test/access-log.test.js`
- `docs/api.md`、`docs/ai-development-guide.md`、`docs/release-readiness.md`、`docs/README.md`

## 验证

`node --test test/access-log.test.js`

## 重启

需要重启 Web，运行中的进程才会把这三项写入访问日志。Worker 不用为这项重启。不新增 migration。不要重建数据库。
