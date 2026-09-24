# 2026-09-22 调度、日报时间窗与确定性统计

## 目标

在现有 `jobs` / JobRunner 上增加持久化调度，统一日报时间窗口，并把 Feed、官方发布、日程和行情收成一份可追溯的日报快照。同时补上 A 股指标历史和纯函数因子引擎，供单股统计 API 与 Agent Tool 读取事实。

## 决定

- Scheduler 只创建已注册 Job。`enqueueDueSchedule` 在同一个 SQLite 事务里入队并推进 `next_run_at`。停机补跑采用 latest-only。第一版只有 `daily` 和 `interval`。
- 日报窗口是配置时区里的左闭右开 cutoff 区间。新闻时间用 `publishedAt ?? createdAt`，抓取时间不改变归属。行情快照标明是生成时能取到的最新状态。
- `report.daily.generate` 幂等写入已有 `daily_reports`。手工重跑只在本机桌面创建这一个固定任务。
- `market.metrics.history` 把 Tushare `daily_basic` / `adj_factor` 转成与供应商无关的序列。缺失值保持 null。因子引擎不访问网络或数据库；负 PE 不参与估值百分位；价格收益优先复权。

## 验证

`npm run check`
