# 架构

## 第一版兼容层

```text
HarmonyOS App / 手机浏览器
              |
              | HTTP（同一局域网）
              v
    AI Center Web Server
        |       |       |
        |       |       +-- SSE 实时事件（仅在线期间）
        |       +---------- /api/v1
        +------------------ 响应式网页
              |
              v
            SQLite（CREATE TABLE IF NOT EXISTS）
```

兼容接口仍在运行：

- `apps/web/src/server.js`：页面、API、配对和 SSE。
- `apps/web/public/`：无构建步骤的响应式网页。
- `packages/contracts/`：发布、配对、灵感和行为事件的请求校验。
- `packages/database/`：设备、帖子、灵感、知识库，以及向第二阶段 schema 的无损迁移。
- 对手机开放的只有 Web/API 端口。

第一版 API 和页面没有被删除，第二阶段通过兼容层继续提供这些能力。

## 第二阶段（当前已落地的运行骨架）

```text
鸿蒙薄壳 / Web
        │
        ▼
AI Center API + SSE
        │
 ┌──────┼───────────┐
 ▼      ▼           ▼
信息域  交易域      知识域
        │
        ▼
SQLite + 原始文件 + 任务/事件表
        ▲
        │
后台 Worker
 ┌──────┴──────────────┐
 ▼                     ▼
旧 AI Skills Adapter   旧 AI-Hub 行情 Adapter
B站 / X / 字幕          同花顺 / Yahoo（本机 HTTP）
```

关键变化：

- Web 只负责页面、API、配对和读取结果。
- 独立本地 Worker 负责定时抓取、重试、字幕和 AI 加工。
- 旧仓库继续运行，通过配置路径或本机 HTTP 调用，不立即迁移代码。
- 只有 AI Center 的 Web 端口对手机开放；旧服务和浏览器调试端口只监听本机。
- 用正式 `schema_migrations` 替代单纯的 `CREATE TABLE IF NOT EXISTS`。
- Worker 写入 `jobs` 与 `outbox_events`；SSE 按 `Last-Event-ID` 补发。
- 新业务数据带 `workspace_id`；P0 只有默认用户。

当前实现已经完成上述进程与数据骨架；B站、X 和行情 handler 尚未注册。

领域表边界见 `docs/plan/stage-2.md` 与 `docs/product-v2.md`。契约草案见 `docs/plan/contracts-draft.md`。

## 推荐目录

```text
AI-Center/
  apps/
    web/                 网页、API、配对和 SSE
    worker/              抓取、行情刷新、AI 后台任务
    harmony/             ArkTS Stage + ArkWeb 薄壳
  packages/
    contracts/           请求、响应和事件契约
    database/            SQLite schema、版本化迁移和数据访问
    runtime/             任务领取、重试和生命周期
    connectors/          外部进程与本机 HTTP 适配器
  data/
    ai-center.db
    blobs/captures/      原始 JSON、字幕
  docs/
```

## 运行边界

- 对手机开放的只有 Web/API 端口。
- SQLite 文件不通过网络共享。
- Codex Bridge、Chrome 调试端口、转写服务、采集 Worker、旧 AI-Hub 仅监听回环地址。
- 鸿蒙应用不保存业务数据库，只保存服务器地址和设备授权。
- API Key、Cookie 和本机路径不得返回给手机。

## 任务与事件

- `jobs` 是 SQLite 持久任务队列。Worker 使用 `BEGIN IMMEDIATE` 原子领取任务。
- 任务只允许执行 `packages/connectors` 显式注册的 handler。
- 外部进程使用 `spawn(..., shell: false)`，并要求 stdout 为单个 JSON 对象。
- 业务变更与 `outbox_events` 同事务写入。
- Web 每 250ms 转发新事件，SSE 帧携带递增 ID；客户端可以用 `Last-Event-ID` 补回短暂断线期间的事件。
- `provider_health` 保存 Worker 和未来连接器的最近成功、失败及检查时间。

本地运行使用两个终端：`npm start` 和 `npm run start:worker`。两个进程可以独立重启。

## 鸿蒙端策略

Stage + ArkWeb 薄壳已经位于 `apps/harmony`：加载同一套网页，Preferences 保存服务器地址，ArkWeb 保存 HttpOnly 授权 Cookie，并提供 Scan Kit 原生扫码、加载状态、12 秒失效地址回退和网页返回栈。不重写信息流 UI。

配对 API 同时产生 HTTP 二维码和 `aicenter://pair` App 深链二维码。当前电脑页面展示的 HTTP 码是通用码：鸿蒙 App 内扫码和手机系统相机都可识别；App 只接受带短期配对参数的 AI Center 地址，不打开任意二维码。

DevEco Studio、签名和真机安装是用户执行步骤。

## 旧能力接入方式

```text
旧平台实现 -> Adapter -> AI Center 契约 -> SQLite / blobs
```

页面和数据库不依赖旧字段。替换 Adapter 时，前端契约保持不变。
