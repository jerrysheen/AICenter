# 入库按原文链接和发布者去重

日期：2026-10-15

## 线上

同一篇报道会进两次。媒体索引写成 `media:` 条目，订阅源写成 `feed:<uuid>`。2026-10-15 的订阅源 460 条里有 148 条和媒体重复。小时报里同一小时有 22 对，另外 4 条落在相邻小时。例如 BBC 报道 Anthropic 三季度营收：`media:bbc` 在 11:34 入库，`feed:8c74e34e` 在 11:36 入库。

## 决定

新数据入库前先查重。查到已有条目就补上缺的字段（例如正文），不另建一条。已经在库里的重复行不删除、不改写、不回填，已发布的小时刊期也不重做。

去重钥匙是「规范化原文链接 + 来源」。

链接规范化：去掉协议、`www.`、`?` 后面的参数、`#` 锚点、末尾 `/`。只把主机名改成小写，路径保持原样。

来源按发布者归一，不用 `media:bbc` 和 `feed:<uuid>` 这两种编号：

- 媒体源登记里，同一个 `publisherKey` 的栏目算同一个发布者。`bbc`、`bbcworld`、`bbctech` 都是 `bbc`。
- `articleHosts`、`redirectHosts`、`channelUrl`、`probeUrl`、`allowedHosts` 上的主机名都指向这个发布者。所以 `bbc.com`、`bbc.co.uk` 和 `feeds.bbci.co.uk` 都是 `bbc`。
- 媒体条目用自己的 `publisherKey` / `sourceKey`（`media:` 前缀会去掉）。
- 订阅条目用订阅站点地址（`profileUrl`、feed 地址，或 externalId 里的 http 地址）和原文链接的主机名查同一张表。
- 登记里没有的站点，用来源主机名，前面加 `host:`，不和别的站点并在一起。

链接对不上时，还有一条兜底：同一发布者、发布时间相差不超过 5 分钟、原文标题高度相似，也算同一篇。相似度默认 0.82，用 `AI_CENTER_ARTICLE_DEDUP_TITLE_THRESHOLD` 调整（大于 0 且不超过 1）。标题先去掉标点和空白再比二字组。规范化后不足 18 个字的标题不走这条兜底。

小时报生成候选时用同一把钥匙再滤一次，包含别的小时里已经有的那篇。同一把钥匙只留一条，`media:` 优先于 `feed:`。这条只影响之后生成的小时报，不改已经发出的刊期，也不改库里的旧行。

## 迁移

migration 68 `article_dedup_keys`：给 `media_index_entries` 和 `content_items` 加可空的 `dedup_key`，并加上钥匙、媒体发布时间、订阅原文链接的索引。不更新旧行。新入库和合并命中的那一条才会写下钥匙。

## 重启

需要同时重启 Web 和 Worker。Web 刷新订阅、Worker 同步媒体和订阅、Worker 生成小时报，都走这套去重。
