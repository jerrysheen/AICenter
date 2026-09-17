# Source Foundation

## 目标

把 Yahoo/同花顺行情、X 首页、B站链接与 SearXNG 搜索从分裂端口收到统一 SourceHub，
同时保留现有 HTTP、Feed 持久化和 Agent Tool 兼容行为。搜索迁移在并行改动结束后作为同日后续补齐。

## 决定

- 扩展现有 Capability Registry 为 Module Registry；保留旧函数名兼容。
- Module Contribution 同时支持 `sources` 与 `jobHandlers`，且 Source 必须在 manifest 的 `sourceIds` 中声明。
- SourceHub 对每个 Source 的 input/output 做 Zod 校验，并负责 TTL、并发合并、Snapshot 与 AI Projection。
- Market Board 聚合从 Connector 移到 `packages/source/src/market`；旧导出只作兼容转发。
- Feed 的 `SourceAccount -> Capture -> ContentItem` 不变；FeedService 不再出现 X/B站条件分支。
- 不新增数据库迁移或 `source_snapshots` 表。

## 改动

- 新增 Source Contract、SourceHub、Market/Content Source Definition 与 Human/AI Projection。
- 注册 `market.overview/us/asia/global/quotes/history/search`、`content.x.home`、`content.bilibili.import`。
- 注册 `search.web`，SearXNG Connector 不再直接注入 Tool；`web.search` 改为只读 SourcePort。
- TradingService 与 FeedService 只依赖 Source Port。
- 新增 `/api/v1/sources`、`/api/v1/sources/:id`；旧 `/markets`、`/feed/*` 保留。
- 市场页看板目录从 Source Manifest 生成，失败时回退现有静态目录。
- Capture metadata 保存标准 `authorHandle`，移除 Feed Domain 对 X URL 的解析。

## 验证

- SourceHub 输入/输出校验、缓存、AI Projection、未声明 Source 与 Source API 有确定性测试。
- 现有 Market、X、B站、持仓、Agent 与 Search 测试继续运行；Search 覆盖成功、不可用、`publishedAt`、Source API 与 `webMode`。
