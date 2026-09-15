# 第一版架构

## 总体结构

```text
HarmonyOS App / 手机浏览器
              |
              | HTTP（第一版同一局域网）
              v
       AI Center Web Server
        |       |       |
        |       |       +-- SSE 实时事件
        |       +---------- /api/v1
        +------------------ 响应式网页
              |
              v
            SQLite
```

## 推荐目录

```text
AI-Center/
  apps/
    web/                 网页、API 和第一版实时事件服务
    harmony/             ArkTS Stage + ArkWeb 薄壳
  packages/
    contracts/           请求、响应和事件契约
    database/            SQLite schema、迁移和数据访问
  data/
    ai-center.db          本地业务数据库
    blobs/                后续附件目录
  docs/
```

第一版使用一个 Web 进程，避免过早拆出 API、worker 和消息队列。后续接入平台采集时，再增加独立 worker。

## 运行边界

- 对手机开放的只有 Web/API 端口。
- SQLite 文件不通过网络共享。
- 未来的 Codex Bridge、Chrome 调试端口、转写服务和采集 worker 仅监听回环地址。
- 鸿蒙应用不保存业务数据库，只保存服务器地址和设备授权。

## 鸿蒙端策略

第一版鸿蒙应用采用 Stage 模型和 ArkWeb：

- 主体加载 AI Center 响应式网页。
- 原生层保存服务器地址与设备授权。
- 原生层提供连接失败页、重新扫码、刷新和清除授权。
- 后续按需求增加系统分享入口和原生通知，不重写信息流 UI。

## 后续能力接入

第一版闭环通过后，每个旧能力都通过稳定 API 接入：

```text
旧平台实现 -> Adapter -> Capture/Post 契约 -> AI Center
```

接入顺序暂定为 B站字幕、YouTube、X、转写、知识库、金融行情。
