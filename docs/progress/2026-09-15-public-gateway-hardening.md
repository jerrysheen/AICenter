# 公网 Gateway 安全加固

## 目标

在不默认开放公网的前提下，为稳定 HTTPS Tunnel 准备安全的服务器入口，并消除反向代理请求被识别为桌面管理员的风险。

## 已完成

- 增加可选 `AI_CENTER_PUBLIC_URL`，未配置时保持局域网行为。
- 公网 Host 和 Cloudflare 代理请求不再获得 loopback 桌面身份。
- V8 增加公网一次性配对凭证哈希。
- 公网二维码使用 32 字节随机凭证，局域网保留六位码。
- 公网配对默认 2 分钟失效，同一来源 5 分钟最多 10 次。
- 公网 Cookie 使用 `__Host-`、Secure、HttpOnly、SameSite=Strict。
- 公网健康检查隐藏主机名。
- 增加公网权限、配对、Cookie 和限速测试。

## 未完成

- Cloudflare 账号、域名、Named Tunnel 和 Access Policy，需要用户确定并执行。
- 鸿蒙 ArkWeb 对 Cloudflare Access 登录的真机验证。
- Cloudflare 日志隐藏 Query String 和边缘限速规则。
