# 官方条目补正文

2026-10-19 00:22 一次导入了 104 条 `lane=official`、正文长度为 0、没有 `filterDecision` 的条目。来源是 federalregister.gov、gov.cn、federalreserve.gov、whitehouse.gov。标题是真实政策文件，例如「商务部等9部门关于促进航空保税维修高质量发展的意见」。

这些条目不是媒体流水线写出来的。`config/media.json` 里的政策源是 `enabled: false`、`transport: existing_adapter`，媒体采集不会去抓正文。作者回填和 Worker 的 `source.static-signal-board.snapshot` 走 `syncOfficialReleases`：只把看板里的标题、机构和链接写成内容条目，`body` 留空。已有真实文章但正文为空时，也只挂作者，不回源。所以作者页能打开这些条目，正文却是空的。

现在导入和镜像都会在正文为空时用已有的官方详情读取器回到原链接取正文。Federal Register 仍走文档 API 和 `raw_text_url`，其他已登记官网走页面抽取。读到的正文写入条目；已经有正文的不覆盖，也不再请求。单条失败只记日志，作者照样挂上，下一轮或回填再试。正文达到 80 字时，如果之前被标过 `body-too-short`，这条门闩会清掉。没有这条标记的条目不写 `filterDecision`。

已经进库的空正文用手动脚本补，不放进 Web 或 Worker 启动：

```text
node scripts/backfill-official-bodies.mjs --dry-run
node scripts/backfill-official-bodies.mjs
```

`--dry-run` 只列出 `lane=official` 或看板镜像里正文为空的条目，按主机计数，不访问官网，也不写库。去掉之后才按原链接抓正文。`--sleep-ms` 默认 200，`--limit` 可限制这一次的条数。已经写上正文的会跳过，中断后直接再跑即可。

正文补完之前不要跑 `scripts/hide-short-official-items.mjs`。短正文门闩仍只作用于新导入且正文仍不足 80 字、又没有放行 KEEP 的官方条目。

不新增 migration。不要重建数据库。91 是硬件报价快照索引。下一号仍是 92。空号仍是 63、79、80、82。需要重启 Worker，下一次看板快照才会在导入时抓正文。Web 不跑这条同步，不用为这项重启。回填脚本是单独进程，用新代码执行即可。
