# HarmonyOS 系统分享进入灵感

日期：2026-09-17

## 目标

让用户从 HarmonyOS 系统分享面板把选中文字或网页链接先保存到本机，也能在原生页直接输入、查看和删除；配对或网络恢复后自动同步到 AI Center，并补齐来源、幂等和原始采集时间字段。

## 决定

- 采用官方 `ShareExtensionAbility` + `systemShare.getSharedData(want)`，不把分享接收误做成后台 Service。
- 文本与链接读取 `SharedRecord.content`；HTTPS 链接不使用文件 `uri`。
- 分享详情页改为原生编辑和本地保存；未配对或离线不阻塞记录，不新增 Native Bearer Token，不把原文塞进 URL。
- 原生层只保存有界 Outbox/薄投影；ArkWeb 使用既有 HttpOnly Cookie 重放同步，服务端 SQLite 仍是同步后的权威数据源。
- 用户点击「保存」后才写本地；默认 `wantAi=false`。
- 每次本地创建生成稳定 `clientMutationId`，服务端 workspace 内幂等；本地及同步前按完整 `body + sourceUrl` 精确去重；`capturedAt` 保留手机首次记录时间。
- 同步采用单向投递语义：只上传创建记录。本地删除不传播到服务端，服务端记录不回写本地；服务端全量列表只用于上传前精确查重。
- `sourceType/sourceId` 保留业务追溯语义，新增 `sourceUrl/sourceTitle/captureChannel/sourceApp`，避免 `sourceType=harmony-share` 同时承担来源与入口两种含义。
- `SelectionExtensionAbility` 不进入本轮：当前兼容基线为 API 12，该能力需要更高产品 API 基线和单独真机验证。

## 改动

- V18 migration 为 `notes` 增加 `source_url`、`source_title`、`capture_channel`、`source_app`。
- `CreateInspirationInputSchema` 与 `InspirationSchema` 成为灵感创建/返回的可执行字段约束。
- Web 灵感编辑器可接收鸿蒙分享草稿，提交完整来源字段，并在保存成功后关闭分享详情页。
- Harmony 工程新增分享 Extension、分享页、UTD 注册和静态结构校验。
- Harmony 工程新增本地灵感页与本地 Store，支持 pending / synced / error 状态；旧版遗留的 delete-pending 记录在加载时只从本机清理。
- 本地 Store 使用显式 ArkTS class 和字段复制函数，不依赖 TypeScript 对象展开；业务记录改用应用沙箱 RDB，以支持 ShareExtension 与主应用跨进程读取。旧 Preferences 数据在 RDB 为空时自动迁移。
- V19 migration 为 `notes` 增加 `client_mutation_id`、`captured_at` 和 workspace 内非空唯一索引。
- Web 增加原生 Outbox 同步桥：启动、回到前台和 30 秒周期触发，先重放再对账。
- 设计规则见 `docs/harmony-share-to-inspiration.md`。

## 验证

- Contract：合法字段、非法 URL、非法采集入口。
- Repository / Migration：新字段写入、读取与重启持久化。
- HTTP：`POST /api/v1/notes` 接收分享来源字段并在重启后读回。
- Harmony：脚手架校验 Extension、UTD、`getSharedData()`、本地 Store、本地页面和 ArkWeb 同步桥。
- 全量 `npm run check`。

## 用户执行

DevEco Studio 同步、签名、安装和真机分享面板验证由用户执行。操作与预期结果见 `docs/harmony-share-to-inspiration.md` 的验收章节。
