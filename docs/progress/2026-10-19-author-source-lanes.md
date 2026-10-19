# 作者页：平台标签、官方和媒体、按发布时间排序

2026-10-19。信息流「按作者」加上官方来源和媒体栏目，作者列表和作者详情改按原文发布时间排序。手机上的平台标签改成一行横滑。

## author_id

来源作者不占用社交平台的 `x:`、`xueqiu:`、`bilibili:`、`youtube:`。标识按 `config/media.json` 的 `sourceKey` 生成，同一来源的不同栏目不合并：

- `sourceId` 匹配 `^policy\.` 的来源是官方：`official:<sourceKey>`。现有六条是 `official:fed`（美联储）、`official:federalregister`（Federal Register）、`official:whitehouse`（白宫）、`official:govcn`（国务院政策文件库）、`official:govnews`（中国政府重要会议发布）、`official:pboc`（中国人民银行）。
- 其余媒体来源和发现源是媒体：`media:<sourceKey>`。显示名用栏目名，没有栏目名再用出版方。`media:bbc` 是 BBC Business，`media:bbcworld` 是 BBC World，两条分开，全部已读不会混在一起。The Next Platform 是 `media:nextplatform`。
- 雪球 7x24 从隐藏的系统作者改挂到 `media:xueqiu7x24`。它的 sourceId 是 `xueqiu:home:livenews`，不在 media.json 的 sources 里，目录里单独补这一条。
- 美国能源信息署（EIA）没有 policy sourceId，继续算媒体：`media:eia`。日历源不是作者。
- 仓库目录里没有发改委。现有中文官方来源是国务院政策文件库、中国政府重要会议发布和中国人民银行。要出现发改委，需要先加来源，再按同一个 `official:<sourceKey>` 规则生成。

官方发布仍写成 `provider=media` 的内容条目，外部 id 与现有文章 id 相同，不新增 provider。作者页因此能打开这些条目。正文已经存在时只补发布时间并重新挂作者，不覆盖正文。媒体索引写入本身不新建内容条目，只给已有 capture 补 `sourceKey` 和 `authorId`。历史索引里还没有内容条目的，由回填脚本补建。

官方看板镜像的 `metadata.lane` 是 `official`，作者 id 以 `official:` 开头。这些行只出现在作者页。信息流「媒体」读媒体索引，「全部」读社交条目加看板，都不读镜像，所以不会和看板各出现一次。小时报窗口、可打标列表和阅读材料按 `lane=official` 或 `official:` 排除；信息流过滤的刷新队列本来就不含 `provider=media` 的内容条目，媒体索引扫描也扫不到看板镜像。回填脚本调用同一套写入，不调用过滤、小时报或分类。

## 出现门槛

社交作者仍是未关注时近 30 天至少 2 条，已关注的始终出现并排在最上面。官方和媒体是有限目录，一条就显示，不套用「近 30 天至少 2 条」。安静一个月的美联储、Federal Register 仍留在列表里。

## 排序

作者列表按该作者最新一条的原文发布时间倒序。已关注单独一组在最上面，组内同样按发布时间倒序。作者详情的未读、已读各自按发布时间倒序。

`item_authors.sort_at` 的取值顺序是：正数 `publishedAt`，否则能解析的 `publishedAtRaw`，否则 `capturedAt`，否则内容的 `createdAt`。没有时间就记 0，不用当前时钟。已有关联只有在新时间来自原文发布时间且和旧值不同时才改 `sort_at`。历史行里发布时间晚于收录时间写上的，用回填脚本按同一规则改回来。

## 手机标签

平台顺序是全部、X、雪球、B站、YouTube、官方、媒体。窄屏下一行横滑，右侧渐隐，选中的标签滚进可见区域。列表本身不左右滑切换平台：iOS 边缘返回和 Android 预测返回会吃掉从屏幕边缘开始的水平滑动，列表又是纵向滚动，和标签横滑叠在一起容易误触。

## 上线

migration 90 只建 `idx_author_stats_published`，`CREATE INDEX IF NOT EXISTS`，不改已有行。88 是北向 `northbound_flow`。89 是 YouTube 正文 `youtube_podcast_article`（#152），本分支不登记，也不把它写成永久空号。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker。

历史回填不要放进 Web 或 Worker。部署后在实例目录执行：

```text
node scripts/backfill-source-authors.mjs --dry-run
node scripts/backfill-source-authors.mjs
```

脚本按 500 行一批，默认定批之间停 20 毫秒，可以重复跑。已挂上的作者不会多计一条，发布时间已经正确的行不会再改。干跑只计数。媒体索引和官方看板快照也会补挂。大约每 1 万行 10 到 30 秒；官方看板最多 200 条，这一步不到 1 秒。中断后从头再跑即可。新抓取和官方看板快照会在入库时挂作者，不必把脚本放进启动流程。原有的 `backfill-authors.mjs` 仍只处理社交作者。
