# AI Center HarmonyOS 薄壳

这是一个 HarmonyOS Stage 模型 + ArkTS + ArkWeb 的薄壳工程。业务页面仍由 AI Center Web 提供，原生层负责扫码连接、服务器地址持久化、加载失败恢复和系统返回键。

## 已实现

- `EntryAbility` 接收 `aicenter://pair?...` 深链。
- 首次启动可直接调用 Scan Kit 扫描电脑端二维码，也保留手动输入地址作为后备。
- App 内扫码同时接受 HTTP `?pair=` 通用码和 `aicenter://pair` 深链码；其他二维码不会被打开。
- 使用 Preferences 保存服务器地址。
- ArkWeb 加载页面并保留自己的 HttpOnly 配对 Cookie。
- 旧地址加载失败或 12 秒未完成时，自动删除失效地址并回到扫码连接页。
- 系统返回键优先返回网页历史。
- Web 文件访问和定位能力默认关闭。

AI Center 的 `/api/v1/pairing` 同时返回两种载体，但当前电脑页面默认展示一个通用 HTTP 码：

- `qrDataUrl`：鸿蒙 App 内扫码和手机相机都能使用的 HTTP 二维码。
- `appQrDataUrl`：可由系统相机直接唤起已安装薄壳的 `aicenter://pair` 二维码，作为后续入口备用。

二维码只含服务器局域网地址和一次性配对码，不包含长期设备凭证。默认扫码流程是：先打开 App，点击“扫描电脑端二维码”，再扫描电脑账户页中的同一个码。

## 用户执行：DevEco Studio 真机验证

1. 首次克隆时，将 `build-profile.example.json5` 复制为 `build-profile.json5`。后者是本机配置，已被 Git 忽略。
2. 在 DevEco Studio 中打开本目录 `apps/harmony`。
3. 如果 IDE 提示升级 Hvigor 或 SDK 配置，接受 IDE 生成的兼容版本；业务源码位于 `entry/src/main`，不依赖固定构建版本。
4. 在 Signing Configs 中启用自动签名。证书路径和签名口令只会保存在被忽略的本机 `build-profile.json5` 中。
5. 手机与电脑连接同一 Wi-Fi，开启开发者模式和 USB 调试。
6. 选择 `entry` 模块并运行到真机。
7. 启动 AI Center Web 与 Worker，在应用中点击“扫描电脑端二维码”，扫描电脑账户页中的二维码。

预期结果：

- 应用从桌面图标启动，不显示浏览器地址栏。
- 首次配对后，杀掉应用再打开仍保持登录。
- 电脑 IP 变化、服务未启动或断网时，最多等待 12 秒后自动回到扫码页，不停留在加载状态。
- 页面内跳转后按系统返回键，优先返回上一网页，而不是直接退出 App。

继续自动验证所需反馈：真机安装完成确认；如果失败，请提供 DevEco Build 窗口的首个错误和手机系统版本。

## 当前边界

- 已使用本机 DevEco Studio 26 SDK 完成 ArkTS 编译、签名和打包校验；真机交互仍需用户执行。
- `build-profile.json5`、证书、私钥、HAP/APP 和构建目录均不进入 Git；仓库只保留无敏感字段的 `build-profile.example.json5`。
- 当前长期授权由 ArkWeb 的 HttpOnly Cookie 持久化。服务器 IP 改变时，第一轮仍需重新配对；把 token 独立保存到系统关键资产服务属于下一次安全增强。
- 不开放公网，不在鸿蒙端保存业务数据库。
