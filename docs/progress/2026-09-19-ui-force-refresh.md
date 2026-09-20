# 远端界面强制刷新

日期：2026-09-19

## 目标

改了阅读页图标后，公网/鸿蒙仍吃旧的 JS/CSS。右上角「刷新」只重拉数据，不换静态资源。

## 决定

- 服务端按 public 文件指纹改写 HTML/JS 的 `?v=`，不再手改版本号。
- 公开 `GET /api/v1/ui/revision`；`GET /api/v1/health` 带同一 `uiRevision`，不含主机名。
- 刷新发现指纹变化则整页重载；长按强制重载。鸿蒙探活后把指纹写进页面 URL。
- 打开页面先跑不缓存的 `ui-boot.js` 问 `/api/v1/ui/revision`；不一致则整页换新 HTML/CSS/JS。
- SSE `ready` 带 `uiRevision`，本机重启后客户端重连即可热更新，不必手点。
- 后续：一次改多个 public 文件会连刷，已改为等指纹稳定后再重载，见 `2026-09-19-ui-revision-settle.md`。

## 验证

- `npm run check`
- 本机改 CSS 后，远端点刷新或重开 App 应看到新界面。鸿蒙需用户重新安装后，冷启动才会带新 URL。
