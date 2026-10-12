# 2026-10-12 TrendForce NAND 解析与 B 站订阅心跳

## 目标

生产上 TrendForce 订阅大约每 30 分钟同步，当天 13:45 仍有抓取，但 NAND 序列停在 2026-09-28。需要先修解析，并让每次抓取能区分「没抓」和「页面没变」。另外查清 B 站订阅为什么一次都没有 `last_sync_at`。OpenRouter 与 GPU 租金快照本轮不实现。

## 决定

公开 `flash_spot` 的 Last Update 和 schema.org `dateModified` 就是 2026-09-28 14:40（GMT+8）。同站 DRAM 现货当天已更新到 2026-10-12。哈希去重没有把更新日冻住。价格详情和 DRAMeXchange 价格页需要登录，会员通知里的较新日期没有公开数字，不补造报价。

表头在日高／日低之后增加了盘高、盘低、盘平均。旧逻辑用最早的价格列切规格，日高／日低被写进规格，序列键随价格变化。标题不再写 `US$/chip`，只剩未税，新行缺币种和单位，有已核验行时会被行情列表藏进待核验。

`trendforce-tables-3` 把日高、日低、盘高、盘低、盘平均和涨跌都排除出规格，均价和高低优先盘列。DRAM／NAND 现货与合约、标题为未税、且不是晶圆／模组／eMMC／存储卡／SSD／街价时，保存 USD/chip。其余页面仍不按惯例猜币种。同规格已有序列在币种或单位一侧为空时沿用观测最多的序列。

抓取检查用 migration 54：快照 `last_checked_at`，页面表 `hardware_price_page_checks`。内容哈希不变时只更新检查时间；`last_changed_at` 仅在哈希变化时前移。

固定日程不新增 schedule 种类。`feed.trendforce.prices` 用最多四条 `daily`，默认上海 10:30 和 17:30。文章源 `config/media.json` 保持关闭。

B 站 `content.bilibili.import` 的 `autoRefresh` 为 false，`getFeed` 在没有链接时返回空列表。订阅同步会领到这条并推迟，却不写 `last_sync_at`，所以界面一直是从未同步。关注 UP 时间线仍不做。这条订阅改为完成一次同步，原因 `bilibili-link-only`。手动 `POST /api/v1/feed/bilibili` 仍是唯一入库路径。

## 改动

- `packages/connectors/src/trendforce-prices.js`、`trendforce.js`
- `packages/runtime/src/trendforce-price-schedule.js`、`apps/worker/src/worker.js`
- `packages/database` migration 54 与报价仓储
- `packages/contracts/src/hardware-prices.js`、`packages/domain/src/hardware-price-service.js`
- `packages/runtime/src/feed-automation-module.js`
- 行情脚本显示币种、单位和抓取提示
- `docs/hardware-prices-v1.md`

## 验证

`node --test test/hardware-prices.test.js`：20 项通过，覆盖盘列规格、USD/chip、未变化只更新检查时间、表头改名沿用旧序列，以及两档日程和关闭开关。

`test/feed-automation.test.js` 断言 B 站写入 `lastSyncAt` 且原因为 `bilibili-link-only`，并不调用 B 站读取。

没有用浏览器点开全球行情。生产库尚未用新解析重抓。

## 遗留

OpenRouter 与 GPU 租金本轮不入库。2026-10-12 只读探测：`https://openrouter.ai/api/v1/models` 无需密钥返回 200，`pricing.prompt` / `pricing.completion` 是每 token 美元，需乘 1_000_000 才是每百万 token。RunPod `https://api.runpod.io/graphql` 的 `gpuTypes { id displayName securePrice communityPrice }` 无需密钥，含 H100、H200、B200。Vast.ai `https://console.vast.ai/api/v0/bundles/` 无需密钥但只返回截断后的一批挂牌，`dph_total` 是单卡小时价，当天样本有 H100、没有 H200/B200。按 GPU 名过滤的查询返回空列表。DRAMeXchange 价格页需要登录，不接入。

已保存的旧 HTML 需要显式 `feed.trendforce.reparse`，或等下一次 `feed.trendforce.prices` / 订阅同步。Worker 重启后 migration 54 和日程才生效；Web 重载后才显示币种和抓取提示。
