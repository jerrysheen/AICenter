# 鸿蒙记住登录与快速探活

## 目标

第二次打开 App 应使用已保存地址和 Cookie，不必重新扫码；“能不能连上”要在几秒内判定，信息流加载可以继续等。

## 决定

- Preferences 继续只存服务器地址；长期授权仍是 ArkWeb HttpOnly Cookie，不把 token 写入 Preferences。
- 探活失败、主文档加载失败都不再清除已保存地址。只有用户退出、换服务器或扫新码才忘记。
- 启动先 `GET /api/v1/health`：局域网 2.5 秒、公网 5 秒。任意 HTTP 响应视为网络已通；超时或连接失败立即报错。
- 探活成功后才打开 Web；壳层不再用整页 `onPageEnd` 当作登录完成。启用默认缓存、关闭无痕，并在页面生命周期里 `saveCookieAsync`。

## 改动

- `apps/harmony/entry/src/main/ets/pages/Index.ets`
- `scripts/validate-harmony-scaffold.js`
- `apps/harmony/README.md`、`docs/architecture.md`、`docs/connection-and-pairing.md`

## 验证

- `npm run check`
- 真机：配对一次后杀进程再开应直接探活进入；电脑关机应 5 秒内报错且仍可点重新连接。需 DevEco 重新编译安装。
