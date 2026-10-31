# 2026-10-31 arXiv 公开 API 进入媒体索引

arXiv 按官方查询 API、`sortBy=lastUpdatedDate` 发现 `cs.DC`、`cs.AR`、`cs.CL`、`cs.LG`。不读 `rss.arxiv.org` 的类别 Atom。同一 `arxiv:<论文号>vN` 只保留一条；版本号变化才是新索引，才会再进整理。摘要写在索引摘要里，`contentLevel` 保持 `summary_only`。HTML 全文还没抓，抓取状态写成 `full_text_deferred:html_preferred`，并记下 PDF 地址，不当成全文。

`config/media.json` 的 `arxiv` 默认关闭，`transport` 是 `vendor_api`，`minRequestIntervalMs` 为 3000。全站 arXiv 请求间隔也至少 3 秒。类别可用 `AI_CENTER_ARXIV_CATEGORIES` 覆盖，默认就是这四类。许可类 `vendor_api`（路透、美联、DIGITIMES）仍然没有凭证就不请求。

探针返回论文后才能打开这个来源。打开之后，现有 `media.sources.sync` 会写入索引，随后 `media.index.enrich` 能读到摘要，小时候选走 `media:<externalId>`。不新增 migration。当前 schema 仍是 97。只需要重启 Worker。页面没有改。要实际入库，先探针，再打开 `arxiv`，不要在探针变绿之前把 `enabled` 写成 true。

## 本地验证

```text
node --test test/arxiv-media.test.js test/media-ingestion.test.js test/media-expansion.test.js test/flash-sources.test.js
```

不访问生产，不改密钥。测试用注入的 API 响应，不会打到 export.arxiv.org。
