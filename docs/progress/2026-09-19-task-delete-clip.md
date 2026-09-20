# 任务列表删除条与卡片同盒裁切

## 目标

上一轮把删除条拉满行高后，红色按钮仍从卡片上下间距里凸出来，滑开时还会盖到白色标题上方。

## 决定

- 只改 `apps/web/public` 样式。删除仍走现有灵感删除链路，不改 Contract / Service / Repository。
- `#task-list .task-row` 不再沿用通用 `.task-row` 的上下 padding 和底边；间距只留在行外 `margin`。
- 卡片和删除条共用同一裁切盒；滑开后删除条保持 `z-index: 0`，不盖住白字。

## 验证

- `test/work-package.test.js` 锁住任务行 `padding: 0`、`overflow: hidden`，以及打开态删除条 `z-index: 0`。
