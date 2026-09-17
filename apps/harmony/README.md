# AI Center HarmonyOS 薄壳

这是一个 HarmonyOS Stage 模型 + ArkTS + ArkWeb 的轻客户端工程。完整业务页面仍由 AI Center Web 提供；原生层负责扫码连接、服务器地址持久化、加载失败恢复、系统返回键、系统文本/链接分享，以及有界的离线灵感收件箱。

## 已实现

- `EntryAbility` 接收 `aicenter://pair?...` 深链。
- 首次启动可直接调用 Scan Kit 扫描电脑端二维码，也保留手动输入地址作为后备。
- App 内扫码同时接受 HTTP `?pair=` 通用码和 `aicenter://pair` 深链码；其他二维码不会被打开。
- 使用 Preferences 保存服务器地址；杀进程再打开会自动恢复，不再因为一次连不上就丢掉。
- ArkWeb 启用默认 HTTP 缓存，并在页面加载后把 Cookie 显式落盘，下次用已保存登录态进入。当前 SDK 的 Web 组件没有 `incognitoMode` 属性，默认即非无痕。
- 打开时先用 `/api/v1/health` 做短超时探活（局域网 2.5 秒、公网 5 秒）。不通立即报错并保留地址；通了之后才加载业务页，数据等待不再挡住“能否登录”。
- Web 未配对页和设置页优先通过 `AICenterShell` 原生桥接直接退出 WebView；`aicenter://reset` 是后备协议。
- HarmonyOS 7（API 26）真机前台运行时，智控键上滑/下滑会驱动 ArkWeb 向上/向下惯性滚动。
- 系统返回键优先返回网页历史。
- Web 文件访问和定位能力默认关闭。
- `ShareExtensionAbility` 注册 `ohos.want.action.sendData`，接收 `general.text` / `general.hyperlink`，并用 `systemShare.getSharedData()` 读取 `SharedRecord.content`。
- 分享详情页是原生编辑页，用户点击「保存」后先写本地 Outbox 并关闭；未配对或离线也可完成。
- 主应用提供「本地灵感」页，可直接输入、查看上传状态和删除。ArkWeb 恢复授权连接后只重放待上传记录，服务端按 `clientMutationId` 去重。手机删除只清理本机副本，不删除 AI Center 内容；服务端记录也不反向灌入本地列表。

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
8. 先关闭电脑服务，在浏览器中选中文字或分享网页链接，从系统分享面板选择「存到 AI Center」，检查预填内容后点击「保存」。
9. 从主应用打开「本地灵感」，确认离线记录存在；再启动电脑服务并完成配对，检查自动上传和重试去重。删除手机本地副本后，电脑端内容应继续保留。

预期结果：

- 应用从桌面图标启动，不显示浏览器地址栏。
- 首次配对后，杀掉应用再打开会读取已保存地址并快速探活；Cookie 登录态应仍在。电脑暂时离线时提示错误，点重新连接，不必重新扫码。
- 页面内跳转后按系统返回键，优先返回上一网页，而不是直接退出 App。
- 在可滚动页面上，上滑智控键时页面向上滚动，下滑时页面向下滚动；壳层以约 60 帧/秒的小步长滚动，并逐帧衰减速度形成阻力感。
- 分享面板出现「存到 AI Center」；纯文本与链接进入原生编辑页，离线保存后详情页关闭。连接恢复时电脑端只出现一条灵感及来源链接，本地显示「已同步」。

继续自动验证所需反馈：真机安装完成确认；如果失败，请提供 DevEco Build 窗口的首个错误和手机系统版本。

## 当前边界

- 已使用本机 DevEco Studio 26 SDK 完成 ArkTS 编译、签名和打包校验；真机交互仍需用户执行。
- `build-profile.json5`、证书、私钥、HAP/APP 和构建目录均不进入 Git；仓库只保留无敏感字段的 `build-profile.example.json5`。
- 当前长期授权由 ArkWeb 的 HttpOnly Cookie 持久化。服务器 IP 改变时，第一轮仍需重新配对；把 token 独立保存到系统关键资产服务属于下一次安全增强。
- 当前不接图片、视频和文件分享；`SelectionExtensionAbility` 划词直达需升级兼容 API 基线后再评估。
- 不开放额外服务端口；鸿蒙端只保存有界的灵感 Outbox/薄投影，不复制知识库、AI 记录或服务端业务数据库。
