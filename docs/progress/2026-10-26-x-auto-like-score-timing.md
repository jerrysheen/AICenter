# 2026-10-26 X 自动点赞分数线与选条时机

配置里的自动点赞分数线一直是 0.75。Bamboo 打开时，代码又把这条线抬到至少 0.8，所以线上实际用的不是配置里的数。点赞选条则要等一整批 X 内容入库结束才跑。一条已经打完分的帖，会等到同批后面的分类都结束。

## 决定

- `config/x-focus.json` 的 `autoLike.minScore` 改为 0.8。配置缺这个字段时，默认也是 0.8。
- 去掉「只有 Bamboo 才把分数线抬到 0.8」。有分类客户端时，包括 Bamboo，分数线就是配置里的数。把配置改成 0.7，Bamboo 也按 0.7，不再暗中抬高。
- 没有分类客户端时，其他方向仍至少 0.9。主方向是企业动态时仍至少 0.9。
- 选条时机改到分数写回。一条 X 内容带着模型分或沿用分写入，并且已经有内容项时，马上选条。关键词分补写成模型分时，每写回一条就选一次。已经有模型分的帖，分类结论发生变化时也选一次；结论没变的刷新不因此再选。
- 整批入库结束后的那次选条留下，用来补上这一轮没有新分数、但间隔已经过去的帖。
- 选条规则不变：只从已经有模型分或沿用分的推文里选；排除推广、敏感和政要发言；每天最多 8 条，每小时最多 2 条，两次至少间隔 15 分钟。每条点赞仍是一条 `feed.x.like` 任务，来源记为自动。总开关或页面开关关闭、或已暂停时，不入队。
- 同一条已经有点赞任务时不再入队。已经有一条点赞、取消点赞或不感兴趣还在处理时，也不再排下一条。

## 改动

`config/x-focus.json`、`packages/domain/src/x-focus.js`、`packages/domain/src/x-auto-like.js`、`packages/domain/src/feed-service.js`、`packages/domain/src/feed-value-review-service.js`、`packages/domain/src/feed-value-refresh-service.js`、`apps/worker/src/worker.js`。不新增 migration，不改页面脚本，也不改 `static-files.js`。

## 验证

`node --test test/x-focus.test.js test/x-not-interested.test.js test/feed-value.test.js`。配置默认 0.8；Bamboo 配 0.7 时仍是 0.7；没有分类客户端时是 0.9。入库时，第一条模型分写完就选条，下一条分类还没开始；同一批再选不会把同一条再入队。页面开关关闭时不入队。关键词分不触发。关键词分补成模型分后入队一次，紧接着再选会因为已有任务而停下。分类结论从空变成有结果时通知一次，再写同一结论不再通知。企业动态 0.85 仍不选，0.9 仍选。

## 部署

不要重建数据库。当前 schema 仍是 96。下一号是 97。空号仍是 63、79、80、82。需要同时重启 Web 和 Worker。页面脚本没有改，不必为这项重新加载。确认要自动点赞时，仍需 `AI_CENTER_X_AUTO_LIKE=1`，并在推荐记录打开页面开关。
