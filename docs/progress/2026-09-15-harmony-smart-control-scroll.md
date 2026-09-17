# HarmonyOS 7 智控键滚动

## 目标

让 HarmonyOS 7（API 26）设备的智控键滑动手势可以控制 AI Center 鸿蒙薄壳中的 ArkWeb 页面滚动。

## 实现

- 在鸿蒙页面组件出现时，通过 InputKit 的 `inputConsumer` 分别订阅
  `KEYCODE_FINGERPRINT_SLIDE_UP` 和 `KEYCODE_FINGERPRINT_SLIDE_DOWN`。
- 使用两个独立回调满足系统功能键订阅要求，并在组件消失时注销，恢复系统默认响应。
- 应用处于前台且 Web 页面加载完成后，智控键上滑驱动页面向上滚动，下滑驱动页面向下滚动。
- 初版固定距离 `scrollBy` 已在真机验证能响应智控键，但方向相反且缺少惯性。
- 修正方向后尝试 ArkWeb `slideScroll`；真机反馈该调用没有产生可见滚动，因此不再使用。
- 最终恢复已验证可用的 `scrollBy`，以 16 ms 小步长连续滚动；初速度 1.6 vp/ms，每帧保留 92% 速度，直到低于 0.08 vp/ms，自然减速形成阻力感。
- 不增加权限，不复制 Web 业务页面，继续由 ArkWeb 加载同一套 AI Center Web UI。
- 保留 API 12 的最低兼容版本；智控键枚举与订阅能力只在 HarmonyOS 7 / API 26 设备上生效，旧设备订阅失败时静默保留原行为。
- 脚手架检查新增智控键枚举、系统按键订阅和 ArkWeb 滚动调用的防回归断言。

## 验证

- 仓库完整检查通过：60 项测试全部通过，Harmony 脚手架检查通过。
- 使用本机 DevEco Studio 26 SDK 完成 ArkTS 编译、HAP 打包和签名，构建成功。
- 编译器未报告智控键 API 或 ArkWeb 滚动错误；只有原有 Scan Kit 设备覆盖范围提示。
- 真机安装、智控键事件是否上报以及手势方向仍由用户在 HarmonyOS 7 设备上验收。
