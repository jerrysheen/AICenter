# 2026-09-26 订阅自动采集

信息流后台采集接到现有 `job_schedules`。没有新的 cron。

全局任务 `feed.subscriptions.sync` 每分钟检查一次哪些 subscription 到期。真正的抓取间隔仍是每条 subscription 的 `refreshIntervalMinutes`。领取时先把 `nextSyncAt` 推后 10 分钟，成功后再按间隔推进，失败则 5 分钟后重试。单个来源失败不让整批退出。

来源如何重抓写在 `source_accounts.metadata` 的 `sourceId`、`sourceInput`、`autoRefresh`。X 的关注和为你推荐、雪球的关注、精选和 7x24 默认每 30 分钟抓一次；Worker 启动时补齐这五条订阅。库里如果还是上一版 X 的 60 分钟，会改成 30 分钟。已经改成其他间隔的保留。TrendForce 仍是 120 分钟。B 站链接导入 `autoRefresh` 为 false，不生成自动订阅。手动刷新只在订阅不存在时创建，不再覆盖用户改过的间隔、优先级和通知策略。

新内容入库后入队 `feed.items.enrich`，只翻译非中文并打 Tag。Worker 创建 Feed 时带上翻译端口，不依赖打开网页。
