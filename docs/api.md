# 只读 API

外部机器人用 Bearer 令牌读取已经落库的简报和行情。把下面的地址换成自己的 AI Center 入口，把令牌换成设置页生成的那一串。示例域名不是真实部署。

```bash
curl -sS "https://center.example.com/api/v1/reports/daily/latest/brief" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

未带令牌、令牌错误或已撤销时返回 401。白名单之外的路径即使用了有效令牌也返回 401，原有的设备 Cookie 不受影响。查询参数带 `refresh=1` 或 `refresh=true` 返回 403，不会触发抓取。

每个令牌默认每分钟 60 次。超出时：

```http
HTTP/1.1 429
Retry-After: 17
```

```json
{ "ok": false, "error": "请求过于频繁，请稍后重试" }
```

环境变量 `AI_CENTER_API_TOKEN_RATE_PER_MINUTE` 可改这个上限。访问日志只记录令牌 id、方法、路径、状态码、时间和耗时，默认保留 14 天。

令牌在「设备与连接」里生成。名称必填，最长 40 字。明文只在生成成功时出现一次。本机桌面会话和已配对设备可以列出、生成和撤销；Bearer 自己不能调用 `/api/v1/api-tokens`。

## 日报与简报

时间用毫秒时间戳。日期是 `YYYY-MM-DD`。响应里的简报不含供应商字段。

| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/api/v1/home/bootstrap` | 可选 `refresh=1`。设备登录，不接受 Bearer。首屏字段，15 秒缓存已序列化的正文和 gzip，到期前约 5 秒后台重算，带弱 ETag |
| GET | `/api/v1/reports/daily/latest` | 无 |
| GET | `/api/v1/reports/daily` | `date` |
| GET | `/api/v1/reports/daily/latest/brief` | 无 |
| GET | `/api/v1/reports/daily/brief` | `date` |
| GET | `/api/v1/reports/daily/briefs` | `limit`，默认 60 |
| GET | `/api/v1/reports/daily/brief/window` | `date`，`revision` |
| GET | `/api/v1/reports/daily/evidence` | `date`，`revision`，`materialId`，`paragraphId` |
| GET | `/api/v1/reports/daily/tracking` | 无 |
| GET | `/api/v1/reports/daily/analysis/status` | `date` |
| GET | `/api/v1/reports/tree` | `startAt`，`endAt`，可选 `view=index`，`information=1`。目录走 migration 60 的列，15 秒进程内序列化缓存，响应仍 `no-store` |
| GET | `/api/v1/reports/tree/edition` | `id` |
| GET | `/api/v1/reports/tree/node` | `id` |
| GET | `/api/v1/reports/tree/children` | `id` |
| GET | `/api/v1/reports/tree/editorial` | `startAt`，`endAt` |
| GET | `/api/v1/reports/reading-hour` | `startAt`，`endAt`，`scope=hour` |
| GET | `/api/v1/reports/reading-hour/index` | `startAt`，`endAt`，`scope=hour` |
| GET | `/api/v1/reports/reading-hour/snapshot` | `id` |

```bash
curl -sS "https://center.example.com/api/v1/reports/daily/latest/brief" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "brief": {
    "id": "4f1c2a30-1111-4222-8333-444455556666",
    "reportId": "8aa0b7c2-7777-4888-9999-aaaabbbbcccc",
    "reportDate": "2026-10-12",
    "generatedAt": 1760270400000,
    "overview": "今天的材料集中在算力供应和存储报价。",
    "items": []
  }
}
```

没有成稿时 `brief` 为 `null`。`GET /api/v1/reports/daily/briefs?limit=60` 返回日期、概述、条数和生成时间。

## 小时报与搜索

`hourStart`、`startAt`、`endAt` 都是毫秒。小时起点必须落在整点。索引和搜索的窗口要大于 0，并且不超过 7 天。

| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/api/v1/reports/hourly` | `hourStart` |
| GET | `/api/v1/reports/hourly/index` | `startAt`，`endAt` |
| GET | `/api/v1/reports/hourly/snapshot` | `snapshotId` |
| GET | `/api/v1/reports/hourly/search` | `startAt`，`endAt`，可选 `query`，`limit`，`offset` |
| GET | `/api/v1/reports/hourly/evidence` | `snapshotId`，`materialId`，`paragraphId`，`materialHash`，`materialVersion` |

```bash
curl -sS "https://center.example.com/api/v1/reports/hourly/search?startAt=1760266800000&endAt=1760270400000&query=存储&limit=20" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "items": [
    {
      "sentence": "存储现货报价继续上行。",
      "hourStart": 1760266800000
    }
  ],
  "total": 1,
  "nextOffset": null
}
```

没有匹配时 `items` 为空数组，`total` 为 0。

## 信息流

`saved=1` 只读已经保存的条目。不要传 `refresh`。

| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/api/v1/feed/x` | `feed=for-you` 或 `following`，`limit`，`saved`，`before`。`following` 且 `limit=12` 的首页和已读头可读 Worker 快照，10 分钟内直接写出 |
| GET | `/api/v1/feed/xueqiu` | `feed=following`、`featured` 或 `livenews`，`limit`，`saved`，`before`。`limit=12` 的首页（关注含已读头）可读 Worker 快照，10 分钟内直接写出 |
| GET | `/api/v1/feed/bilibili` | `limit`，`saved`，`before` |
| GET | `/api/v1/feed/media` | `channel=tech` 或 `macro`，`view`，`sourceKey`，`limit`，`offset`，`before` |
| GET | `/api/v1/feed/trendforce` | `limit`，`saved`。响应固定为摘要列表，并带 `ETag`；`If-None-Match` 命中且没有排队抓取时返回 304。全文用 `GET /api/v1/feed/media/article` |
| GET | `/api/v1/feed/media/article` | `externalId` |
| GET | `/api/v1/content-items/:id` | 路径里的内容 id |
| GET | `/api/v1/content-items/:id/original` | 同上 |
| GET | `/api/v1/feed/items/:id/original` | 同上 |
| GET | `/api/v1/posts` | `limit` |
| GET | `/api/v1/posts/:id` | 路径里的 id |

```bash
curl -sS "https://center.example.com/api/v1/feed/x?feed=for-you&saved=1&limit=20" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "feed": {
    "items": [
      {
        "id": "11111111-2222-4333-8444-555555555555",
        "title": "一条已保存的信息",
        "summary": "摘要"
      }
    ]
  }
}
```

条目不存在时对应的单条接口返回 404。

## 股民讨论日摘

| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/api/v1/investor-discussion` | 可选 `date=YYYY-MM-DD`，省略时取今天 |

```bash
curl -sS "https://center.example.com/api/v1/investor-discussion?date=2026-10-12" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "date": "2026-10-12",
  "pending": false,
  "digest": {
    "date": "2026-10-12",
    "status": "ready",
    "generatedAt": 1760270400000,
    "error": "",
    "pending": false,
    "questionSet": "jev-v2",
    "coverage": {},
    "sections": []
  }
}
```

当天没有日摘时 `digest` 为 `null`。

`sections[].crowd` 是外部机器人要读的多空结果。方向发言达到阈值时，`shares` 是加权占比，`insufficient` 为 `false`：

```json
{
  "shares": { "bull": 0.62, "neutral": 0.2, "bear": 0.18 },
  "counts": { "bull": 5, "bear": 2, "neutral": 1 },
  "sampleSize": 8,
  "directionalCount": 7,
  "minDirectional": 5,
  "insufficient": false
}
```

方向发言少于阈值时，`shares` 为 `null`，`insufficient` 为 `true`。`counts` 和 `sampleSize` 仍保留。阈值默认 5，已落库的行若带有 `minDirectional` 则用那个数。标签仍是「偏多」也一样：例如只有 2 条看多时不要把 `shares.bull` 读成 100%。这个接口在读出时改写，不用重新生成。

```json
{
  "shares": null,
  "counts": { "bull": 2, "bear": 0, "neutral": 0 },
  "sampleSize": 2,
  "directionalCount": 2,
  "minDirectional": 5,
  "insufficient": true
}
```

## 行情

| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/api/v1/markets` | `board=overview`、`us`、`asia`、`cn` 或 `global` |
| GET | `/api/v1/markets/search` | `q` |
| GET | `/api/v1/markets/history` | `symbol`，`range=6mo`，`interval=1d` |
| GET | `/api/v1/markets/analysis` | `symbol`，`range=5y` |
| GET | `/api/v1/markets/baskets` | `index`，`range=5y`，可选 `asOf` |
| GET | `/api/v1/hardware-prices` | 可选 `category=dram`、`nand`、`ssd` 或 `other-storage`，`snapshotId`，`limit`。列表不带 `rawCells`。`limit=500` 且无分类时读 Worker 快照，响应是已序列化的缓冲区 |
| GET | `/api/v1/hardware-prices/series/:seriesKey` | 64 位十六进制系列键 |
| GET | `/api/v1/hardware-prices/snapshots/:id` | 快照 id |
| GET | `/api/v1/compute-prices` | 无 |

```bash
curl -sS "https://center.example.com/api/v1/markets?board=global" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "market": {
    "board": "global",
    "mode": "partial",
    "fetchedAt": 1760270400000,
    "indices": []
  }
}
```

```bash
curl -sS "https://center.example.com/api/v1/compute-prices" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "tokens": [
    {
      "modelKey": "example-text",
      "name": "Example",
      "quoteDate": "2026-10-12",
      "promptPerMillion": "1.25",
      "completionPerMillion": "5.00"
    }
  ],
  "gpus": [
    {
      "venue": "runpod",
      "gpuKey": "h100",
      "label": "H100",
      "lane": "secure",
      "quoteDate": "2026-10-12",
      "usdPerHour": "2.49"
    }
  ],
  "checks": []
}
```

硬件价格：

```bash
curl -sS "https://center.example.com/api/v1/hardware-prices?category=nand&limit=50" \
  -H "Authorization: Bearer aic_替换成设置页给出的令牌"
```

```json
{
  "ok": true,
  "items": [],
  "snapshot": null,
  "pages": []
}
```

持仓、个人资产、ETF 鲸鱼、信源管理、问答、知识库和任务都不在这份白名单里。

## 不能用令牌做的事

下面这些即使用正确的 Bearer 也会被拒绝：

- 任何 POST、PUT、PATCH、DELETE
- `/api/v1/api-tokens` 的生成、列表和撤销
- `/api/v1/runtime/deploy-status`、`/api/v1/runtime/access-summary` 以及其他 Runtime、设备、配对和指标接口
- `/api/v1/holdings` 与 `/api/v1/assets/personal`
- 信息流或行情上的 `refresh=1`

## 站点变慢时看的访问日志

这组接口不在 Bearer 白名单里。`GET /api/v1/runtime/access-summary` 要有设备登录会话，回环地址和 `CF-Connecting-IP` 都不能代替。参数是 `date`（上海日期，默认今天）、`since`（`30m`、`2h`、`1d` 或 ISO 时间）和 `top`（默认 20，最大 100）。返回按路径汇总的 `serverMs`、`transferMs`、`total` 的 p50/p95/max，以及 `count` 和 `bytes`。

同一份汇总也可以在服务器上只读查看：

```bash
node scripts/access-log-summary.mjs --date 2026-10-13 --since 2h --top 20
```

日志在 Instance `data/logs/access.yyyy-MM-dd.log`。`POST /api/v1/runtime/client-timing` 只接收本站页面自己的计时，不需要登录，响应是 204。请求体是 JSON 文本，`Content-Type` 用 `text/plain`。每次文档加载发一条。跨站 `Origin` 或 `Sec-Fetch-Site: cross-site` / `same-site` 会被丢掉；`Sec-Fetch-Site: same-origin`，或 Host 被隧道改成回环地址且带 `cf-ray` / `cf-connecting-ip` 时仍然记下。同一进程每分钟最多记 300 条。原始 IP、Cookie 和查询参数里的值不会写入这些日志。`POST /api/v1/behavior` 接受单条或最多 20 条 `{ events }`，需要已登录设备或本机桌面身份。`source.original` 是点原文或打开原站，`item.expand` 是展开条目。
