# 2026-10-02 媒体资讯索引

## 目标

按媒体接入交接的第一阶段，补上和社交阅读分开的媒体索引。不重做 TrendForce，不默认打开 22 家。

## 决定

- 提供者是 `media`。出版商用 `sourceKey`，传输方式用 `rss / html / vendor_api / existing_adapter`。
- 22 个来源在目录里默认 `enabled=false`。只有第一批 RSS（Next Platform、DCD、Techmeme、The Decoder、FT、BBC）在主机探针解析出条目后可以显式启用。FT / BBC 保持索引级，不抓正文。
- 索引、预算和探针状态在新 migration 33。超额记 `budget_deferred`。304 或相同 feed 哈希不新增索引。
- 没有 Key 的官方 API 返回 `needs_credentials`，不返回空的成功列表。栏目页来源返回 `needs_parser`。
- 正文只对 `contentAccess=body` 且调用方标明 `usageReviewed` 的已入选条目抓取。付费墙和过短正文不入库。

## 验证

- `node --test test/media-ingestion.test.js` 通过。
- `node scripts/probe-media-sources.mjs --sources dcd,bbc` 为 dry-run，请求数 0。
- 2026-10-02 主机直连第一批 6 个 RSS 均为 200。随后按用户要求启用索引同步：6 个源全部启用，本次写入 104 条近 48 小时索引。调度 `media-index-sync` 每 60 分钟跑一次。
- 索引同步后排队 `media.index.enrich`：开放来源（Next Platform、DCD、The Decoder）抓正文。页面 HTML 允许到订阅上限 2MB，入库正文仍截到 100KB。这三家每日正文额度提到 8，全局仍是 24。全部索引走现有 Gemini 翻译和打标，资源类型 `media-index`。FT、BBC 仍是索引，Techmeme 不跟随外链。翻译和打标不改到 Elucid Grok。
