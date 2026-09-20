# 任务列表删除条与卡片齐平

## 目标

一级任务卡改成主题加摘要后变矮，左滑「删除」从圆角卡片背后漏出，看起来像从背景上凸出来。

## 决定

- 只改 `apps/web/public` 样式。删除仍走现有灵感删除链路，不改 Contract / Service / Repository。
- 任务行自己裁切：卡片不再单独圆角，删除条拉满行高，未滑开时红块不再从四角透出。

## 验证

- `test/work-package.test.js` 锁住 `#task-list .task-row` 的 `border-radius: 0` 与删除条 `height: 100%`。
