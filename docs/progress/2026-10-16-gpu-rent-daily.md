# 2026-10-16 GPU 租金日历史

## 决定

GPU 租金按北京日历日写入 `gpu_rent_daily`。观测仍只在内容变化时追加。当天不入库，`GET /api/v1/compute-prices/history` 现算。来源当天检查过但没有新观测时，沿用上一次收盘，并把最低、最高写成这个收盘，`carried_forward` 为 1。已经写好的更早日期不整段重算，避免检查时间被后一次覆盖后丢掉中间的沿用。

型号和档位只放在 `config/gpu-rent-normalization.json`。RunPod 安全云、CCIR 保障、Bargo 预留和按需归入保障。RunPod 社区云、CCIR 可中断、Bargo 竞价、Vast 最低归入社区。Vast 中位和 GPU Economy 中位归入中位。Ornn 归入指数。A100 不进入这张日表。GB200 没有来源，覆盖状态是 `no_source`。

Ornn 不需要密钥。公开路径是 `H100 SXM`、`H200`、`B200`。结算时间戳换成 America/New_York 的日期。每天 06:00 抓，09:00 再抓。接口大约返回三个月，第一次运行会把这些天都写上。页面写「指数来自 Ornn，按美东结算日，仅供内部参考」。

migration 75 用 `IF NOT EXISTS` 建表，并给 `gpu_rent_observations(workspace_id, captured_at)` 和 `compute_price_snapshots(workspace_id, last_checked_at)` 加索引。历史和日汇总只读这段北京时间，当天结果在进程里缓存 60 秒。覆盖用日表里的型号加上当天观测。同一天多份快照时，规格只取最后一份。没有检查时间时不回退到 UTC 零点。73、74 是 Polymarket，合并进 main 之后本分支再 rebase，把 75 放在 74 后面。63 仍然空着。早期回填可能有缺口：检查时间只留最后一次，中间没变价的日子补不回来。

## 改动

`market.gpu-rent.daily` 默认 00:10。`market.ornn-gpu.snapshot` 默认 06:00 和 09:00。`scripts/backfill-gpu-rent-daily.mjs` 从 2026-10-11 补到昨天。只读令牌增加 `/api/v1/compute-prices/history`。持仓和个人资产仍不开放。全球行情的 GPU 租金区按型号和档位画日线，可以选来源和 30 天、90 天、全部。

## 回滚

把这次提交退回后重启 Web 和 Worker。`gpu_rent_daily` 留在库里，不删表，也不改已经执行的 migration。要停任务，把 `AI_CENTER_GPU_RENT_DAILY_SYNC` 和 `AI_CENTER_ORNN_GPU_SYNC` 设为 `0` 再重启 Worker。不要重建数据库。

## 验证

`node --test test/gpu-rent-daily.test.js test/compute-prices.test.js test/gpu-price-sources.test.js test/api-tokens.test.js test/runtime.test.js test/feed-query-perf.test.js` 通过。`npm run syntax:hardware` 通过。本机打开 `#market/global/compute`，桌面和 390px 窄屏都画出日租金：来源可切到 Ornn，30 天会重新请求，Token 页隐藏该区，空心点读出「沿用上次」，页面没有后端字段名。Ornn 三个公开地址在 2026-10-16 各返回 92 个结算点。
