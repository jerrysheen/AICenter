# HarmonyOS 系统分享进入灵感

## 目标

用户在支持系统分享的应用中选中文字或链接后，可以从分享面板选择「存到 AI Center」，即使尚未配对或电脑离线，也能先保存在手机；主应用也可以直接输入一条本地灵感：

```text
选中文字 / 分享链接
        ↓
HarmonyOS 系统分享面板
        ↓
ShareExtensionAbility
        ↓ systemShare.getSharedData(want)
原生分享编辑页 / 本地灵感页
        ↓ 本地 Outbox（pending）
ArkWeb 已授权并恢复连接
        ↓ POST /api/v1/notes（clientMutationId）
KnowledgeService.createInspiration()
        ↓
SQLite notes + Outbox
        ↓ 标记本地记录“已上传”
手机保留自己的本地副本
```

鸿蒙端使用应用沙箱内的轻量 RDB 保存有界离线 Outbox 和本地浏览投影，不复制 Knowledge、AI 结果或完整服务端数据库。ShareExtension 与主应用都从同一 RDB 重新查询，避免 Preferences 的多进程缓存不一致。同步后服务端 SQLite 是权威数据源；原文、来源字段和后续 AI 派生结果仍由 Knowledge 域拥有。

## HarmonyOS 实现规则

- 使用 Stage 模型的 `ShareExtensionAbility`，在 `module.json5` 中注册 `type: "share"`、`exported: true` 和 `ohos.want.action.sendData`。
- 当前接收 `general.text` 及其文本子类型，并显式兼容 `general.hyperlink`。
- 在 `onSessionCreate()` 中调用 `systemShare.getSharedData(want)`，遍历 `SharedData.getRecords()`。
- 文本和 HTTPS 链接读取 `SharedRecord.content`。`uri` 只表示文件 URI，不能把网页地址按文件 URI 处理。
- 分享目标展示原生分享详情页，不做无界面后台写入。用户可以修改原文，再明确点击「保存」。
- 分享和直接输入都先写本地薄存储，业务状态为 `pending/synced/error`；未配对、电脑离线或授权失效时仍能保存与查看。
- 本地记录生成一次 `clientMutationId`，所有重试复用；服务端以 workspace + clientMutationId 唯一索引防止重试副本。同步前还会用完整 `body + sourceUrl` 与服务端快照精确匹配，已存在同内容时直接关联；不做可能误合并的模糊去重。
- 主 ArkWeb 使用既有 HttpOnly Cookie 调 API，再通过 `AICenterShell` 只回传同步确认和对账快照；长期设备 token 不进入 Want、URL、Preferences 或页面 JavaScript。
- 灵感来源 HTTP(S) 链接不得在 ArkWeb 内打开。页面调用 `AICenterShell.openExternalUrl()`，或 `onLoadIntercept` 拦下外站导航，原生用 `ohos.want.action.viewData` 交给系统浏览器；`querySchemes` 声明 `http`/`https`。
- 同步只重放创建 Outbox。`status=all` 只用于上传前精确查重，不写入本地列表。手机删除永远只删除手机副本；AI Center 中已经上传的灵感继续保留。

官方依据：

- [ShareExtensionAbility API](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/js-apis-app-ability-shareextensionability)
- [分享详情页处理分享内容](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/share-sec-panel)
- [分享文本](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/share-utd-text)
- [预置 Uniform Data Type 列表](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V13/uniform-data-type-list-V13)

## 灵感来源字段

`sourceType/sourceId` 继续表达可追溯的业务来源；采集入口与外部网页信息使用独立字段，避免把多个含义塞进 `sourceType`。

| 字段 | 含义 | HarmonyOS 分享值 |
|---|---|---|
| `body` | 用户保存的原文，永久保留 | 选中文字；只有链接时回退为标题或链接 |
| `title` | 灵感自身标题，可为空 | 默认空，后续可由用户或 AI 整理 |
| `inspirationType` | observation / hypothesis / question / idea | 默认空 |
| `sourceType` | 业务来源类别 | `external-share` |
| `sourceId` | AI Center 内部稳定资源 ID | 外部分享默认空 |
| `sourceUrl` | 原始网页 HTTP(S) 地址 | `general.hyperlink` 的 `content` |
| `sourceTitle` | 来源页面或分享记录标题 | `SharedRecord.title` |
| `captureChannel` | 内容进入 AI Center 的入口 | `harmony-share` |
| `sourceApp` | 来源应用标识或名称；不可可靠取得时为空 | 当前为空，不从不可靠 Want 字段猜测 |
| `wantAi` | 是否立即进行 AI 加工 | 默认 `false` |
| `clientMutationId` | 手机创建动作的稳定幂等键 | `harmony-...`，重试不变 |
| `capturedAt` | 用户在手机记下内容的 UTC 毫秒时间 | 首次本地保存时间 |

示例请求：

```json
{
  "body": "智谱年底 ARR 目标 30 亿美元……",
  "sourceType": "external-share",
  "sourceId": "",
  "sourceUrl": "https://example.com/article/123",
  "sourceTitle": "文章标题",
  "captureChannel": "harmony-share",
  "sourceApp": "",
  "clientMutationId": "harmony-mutation-id",
  "capturedAt": 1789603200000,
  "wantAi": false
}
```

## 当前范围与后续

- 当前只接收文本和链接，不接收图片、视频或文件。服务端已有 `POST /api/v1/attachments` 与任务/灵感 `attachmentIds`；鸿蒙分享要接图时必须先处理临时 URI 权限、复制到应用沙箱，再上传到该接口，不能把临时 URI 直接持久化。
- `SelectionExtensionAbility` 属于更高版本的划词扩展能力，不进入当前兼容 SDK 12 的交付。以后升级产品 API 基线并完成真机兼容验证后，才评估把「存灵感」直接放进划词菜单。
- 自动同步只在主 ArkWeb 已有有效授权并运行时发生；系统后台常驻同步、小艺无界面直写仍需要独立的原生安全凭证和后台任务设计，不得通过读取或复制 HttpOnly Cookie 绕过当前身份边界。

## 用户执行：真机验收

1. 在 DevEco Studio 中同步工程、启用自动签名并安装到支持 ShareExtensionAbility 的 HarmonyOS 真机。
2. 保持未配对或关闭电脑服务，在浏览器或其他应用中选中文字并分享给「存到 AI Center」；预期原生详情页可编辑，点击「保存」后关闭且内容留在「本地灵感」。
3. 在主应用「本地灵感」直接输入一条，删除一条尚未同步的记录；预期均无需网络。
4. 启动 AI Center 并扫码配对；预期待同步记录自动出现在电脑灵感列表，本地状态变为「已同步」。重复进入或断网重连不得产生副本。
5. 删除一条已上传的手机本地记录；预期 AI Center 中的灵感继续保留，之后也不会从服务端重新下载回来。
6. 分别验证纯文本、纯链接、文字加链接；预期保留原文、来源标题与 URL。
7. 撤销设备授权后再分享；预期仍能保存在本机但保持待同步，不泄露长期凭证；重新配对后再同步。

继续自动验证所需反馈：真机系统版本、上述三类分享的结果；失败时提供 DevEco Build 的首个错误或分享详情页截图。
