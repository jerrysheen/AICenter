# 2026-10-10 日报 brief 改读树刊期，失败后补跑

## 现象

10/6 起生产走 tree-v3。首页和按日期打开的日报 brief 仍读 `daily_report_briefs`，这条表只有 legacy 写入，所以最新一份停在 10/5。`#report` 的树刊期本身有更新。同一天 08:30 的日报任务里，任一 tag 分组失败就把整期标成 failed，已发布 head 不动；任务最多试 2 次，第二次撞上 30 分钟冷却缓存，不再调模型，然后要等到次日 08:30。

## 改动

`GET /api/v1/reports/daily/latest/brief`、`/daily/brief?date=`、`/daily/briefs`：流水线是 tree-v3，或近 7 日已发布 daily tree edition 的上海日期比 legacy brief 新时，用已发布 `row.edition` 和根模块拼 brief。`reportDate` 取 `window.endAt` 的上海日期，`informationItems[].sentence` 为 `标题：正文`。指定日期没有树刊期时仍回退该日 legacy brief。

日报任务在抛出原错误前记一行：`reportDate`、分组数、每组 `tag` / `reason` / `retryAt`、`missingHours`。有可重试分组且本次任务次数已用完时，排队 `report.daily.generate`，`availableAt` 为各组 `retryAt` 的最大值再加 60 秒，`catchup` 从 1 计到 3。同一日期已有未完成日报任务时不重复排。生成策略和页面样式未改。

`generateDaily` 的会话预算改为 `config.dailyMs ?? 45 分钟`。`AI_CENTER_DAILY_RUN_MINUTE` 仍由实例环境配置。

## 验证

新增：tree-v3 下三个 brief 接口读最新已发布树刊期；legacy 比树旧时也改读树，树不更新时仍读 legacy；日报补跑排程、三次封顶、不可重试分组不补跑。
