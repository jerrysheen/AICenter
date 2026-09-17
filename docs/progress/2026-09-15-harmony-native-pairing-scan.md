# 鸿蒙原生扫码与失效地址恢复

## 目标

让已安装的 AI Center 鸿蒙薄壳直接扫描电脑端现有配对二维码；电脑局域网地址变化或服务不可用时，不停留在加载页。

## 决定

- 电脑端继续展示一个 HTTP 通用二维码，不要求用户理解“浏览器码”和“App 码”。
- 鸿蒙 App 使用系统 Scan Kit 默认扫码页，仅识别 QR Code，并允许从相册选图。
- App 内扫码只接受带 `?pair=` 的 AI Center HTTP 地址或 `aicenter://pair` 深链，不打开普通网址。
- Scan Kit 默认 UI 使用系统预授权相机能力，应用不额外申请相机权限。
- 旧地址在 5 秒内最多尝试 3 次；仍未完成时删除 Preferences 中的地址并回到扫码页。

## 改动

- `apps/harmony/entry/src/main/ets/pages/Index.ets`：原生扫码按钮、配对码白名单、加载超时和自动回退。
- `apps/web/public/index.html`：电脑端扫码说明改为 App 与相机共用一个码。
- `scripts/validate-harmony-scaffold.js`：加入 Scan Kit 和超时恢复的静态校验。
- `apps/harmony/README.md`、`docs/architecture.md`、`docs/connection-and-pairing.md`：同步当前行为。

## 验证

- `npm run check`：19 项测试全部通过。
- DevEco Studio 26 SDK：`assembleApp` 编译、签名和打包成功。
- 真机扫码、配对与旧地址回退由用户执行最终验收。
