# 2026-10-10 简报目录改为刊期索引

## 问题与决定

`GET /api/v1/reports/tree?view=reading` 在服务端仍先逐行 `getNode` / `getEdition` 并 `JSON.parse` 全文，再丢掉信息节点正文。小时和日刊期继续带 `inputIds`、`pendingIds`、`roots` 和处理状态。七日目录因此到了约 3.3MB（gzip 760KB）。经所有者的 Cloudflare 隧道，大约 50KB/s，简报要 15 到 16 秒才开始有内容。

生成和加工继续用原来的完整 `list()` / `listInformation()`。阅读端新增 `view=index`，投影下推到 Repository：一条 SQL 取刊期编号、层级、窗口、状态、生成时间、根模块数量，以及该窗口是否已有研究稿。默认不返回信息节点。`information=1` 才按身份列返回信息节点，给「本期材料」打开时用。`view=reading` 的响应保持不变，留一个版本给旧客户端。

刊期标题仍由页面用窗口和时区生成。点开的那一期刊期走既有 `GET /reports/tree/edition`，文章走节点接口。研究稿标志为假时不再先打一次 editorial 404。

## 验证

契约测试确认索引字段白名单、`view=reading` 与无 `view` 的完整刊期不变，以及索引路径不调用 `list()` / `listInformation()`。

种子数据：192 个带正文的信息节点、24 个小时刊期、7 个日刊期。刊期 JSON 含真实 `inputIds` 和一段不重复的填充，用来代替生产刊期里的长列表。本机中位数：

| | 解压 | gzip | SQL 次数 | 本机耗时 |
|---|---:|---:|---:|---:|
| `view=reading` | 2,279,200 字节 | 1,125,816 字节 | 257 | 11.3 ms |
| `view=index` | 10,971 字节 | 814 字节 | 2 | 1.2 ms |

解压约为原来的 0.48%，gzip 约为 0.07%。带 `information=1` 的身份列表是 46,450 字节、3 次 SQL，仍远小于旧目录。SQL 次数不随节点数增加。这是种子库，不是生产 3.3MB 的复测；生产目录会按同样的字段裁剪，体积由刊期个数决定，而不是由正文决定。
