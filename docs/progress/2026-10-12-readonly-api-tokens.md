# 只读 API 令牌

## 目标

让外部机器人在没有设备登录 Cookie 的情况下读取简报和行情。令牌不能写入，也不能管理自己。

## 决定

- 令牌前缀 `aic_`，后面是 32 字节随机数。库表只存 sha256 和用于辨认的前缀。明文只在生成响应里出现一次。
- 比较时先算 sha256，再对固定长度哈希做常数时间比较。日志和慢请求行不记明文。
- Bearer 只放行明确的 GET 白名单。`refresh=1` 拒绝，避免信息流把刷新排进任务。
- 非白名单请求不把 Bearer 当成身份。本机桌面和设备 Cookie 维持原来的权限。部署状态仍只认设备 Cookie。
- 每个令牌默认每分钟 60 次。访问日志在 SQLite，默认保留 14 天。
- migration 57 只建 `api_access_tokens` 和 `api_token_access_log`。不改 migration 56。

## 改动

设置页可以填写名称并生成、撤销、查看创建时间和最近使用时间。Domain Service 负责签发和限流，Repository 负责落库。Web 在进入路由前检查白名单。

## 验证

`test/api-tokens.test.js` 覆盖白名单、撤销、限流、只存哈希，以及设备 Cookie 在 Bearer 之外仍然有效。

## 遗留

重启 Web 后 migration 57 才会执行，只读接口才会认 Bearer。不必为这项重启 Worker，也不要重建或删除用户数据库。限速计数在 Web 进程内存里，重启后重新计算。
