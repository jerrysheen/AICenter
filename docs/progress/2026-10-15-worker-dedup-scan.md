# 小时去重不再扫整张内容表，领取守住尝试上限

日期：2026-10-15

## 线上

`report.information.prepare` 大约每 30 秒跑一次。准备最近两小时的材料时，`dedupeHourlyCandidates` 对每条候选各查一次库。查询是最多 8 个 `source_url LIKE ? ESCAPE '\'`，再按 `length(source_url)` 排序。`ESCAPE` 让 SQLite 用不上 `source_url` 索引，计划落到 `idx_content_feed`，等于按工作区把 `content_items` 扫一遍。better-sqlite3 是同步的，扫的时候事件循环停住。

30 秒 CPU 采样里，主线程大约 85% 在 `listFeedByUrlPrefixes`，6.8% 在 `listMediaByUrlPrefixes`，4.5% 在 `listHiddenExternalIds`。调用链是信息准备结束之后的 `prioritizeRecentTreePreparation` → 小时候选 → `dedupeHourlyCandidates` → `find` → `loadRows`。

另外，`feed.translation.run` 的 `max_attempts` 只在失败时检查。任务已经 4/4 之后，手动改回 `queued` 仍会被领走，跑第 5 次。`attempt_count` 被清成 0、但 `job_attempts` 里已经有第 4 次时也一样。

## 决定

去重结果不变。旧行仍然不回填 `dedup_key`。查重改成两步，都走索引：

- 有钥匙的行用 migration 68 的 `dedup_key` 等值查询。
- 没有钥匙的行按规范化链接的 http/https、带不带 `www.` 做前缀范围。范围比较是 `COLLATE NOCASE`，和原来大小写不敏感的 `LIKE` 前缀一致。命中之后仍用同一把钥匙在内存里比对。

同一小时的全部候选合成一次查询，结果放在这次调用的缓存里。发布时间相差 5 分钟的标题兜底，在候选时间跨度不超过 48 小时且窗口里少于 2 万行时也只查一次，再按每条自己的 5 分钟窗口取最早 400 行。

`listHiddenExternalIds` 从隐藏行的部分索引出发，媒体和指纹各最多 1 万条。隐藏行不超过这个数时，排除名单和以前一样。

领取时如果 `attempt_count` 已经达到 `max_attempts`，或者下一次序号会超过 `max_attempts`，这条任务标成失败，错误名是 `MaxAttemptsExceeded`，不插入新的 `job_attempts`。队列里后面的任务继续领。租约中断仍把翻译任务的 `max_attempts` 加 1，被打断的那次不占 4 次额度。次数还没用完时，把 `attempt_count` 清成 0 仍按已有序号继续，避免唯一约束冲突。

## 性能

本机 5 万行 `content_items`、5 千行 `media_index_entries`、300 条候选：

- 旧的 4 个 `LIKE` 加排序，查询计划是 `SEARCH ci USING INDEX idx_content_feed`，300 次合计 2.3 秒。
- `dedupeHourlyCandidates` 现在是 18–23ms。计划是 `SEARCH ci USING COVERING INDEX idx_content_items_source_url_nocase`。

这台机器不能当成线上更大数据量的复现。线上那 30 秒采样里，扫描占了大约 85% 的主线程。

## 迁移

migration 72 `article_dedup_url_lookup` 只建三个索引：

- `idx_content_items_source_url_nocase`：`content_items(workspace_id, source_url COLLATE NOCASE)`
- `idx_media_canonical_url_nocase`：`media_index_entries(workspace_id, canonical_url COLLATE NOCASE)`
- `idx_user_item_states_hidden`：`user_item_states(workspace_id, content_item_id) WHERE is_hidden = 1`

不改行，不回填 `dedup_key`。63 仍空着。68 到 71 不变。生产库若已经先跑到 71、70 还没记上，部署后仍按单个 version 补 70，然后再跑 72。不要重建数据库。

## 重启

需要同时重启 Web 和 Worker。先起来的进程建索引；行多时这一次启动会多花一点时间。Worker 停掉全表扫描，并在领取时守住尝试上限。Web 刷新订阅也走这套去重。不要重建数据库。
