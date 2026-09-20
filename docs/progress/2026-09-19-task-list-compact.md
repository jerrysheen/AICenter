# 任务一级列表改为主题加摘要

## 目标

灵感下的任务窗一级列表不再铺开整段正文。每条只显示主题和两句摘要，点进详情再看具体内容。

## 决定

- 列表卡从现有 `title` / `body` 派生主题和摘要，不新增 Contract 字段，不改 Repository。
- 全文、结果和步骤拆解仍在 `#inspire/tasks/:id`。
- 只改 `apps/web/public` 与文档，立刻生效，不弹进程。

## 验证

- 任务列表卡使用 `task-card-theme` / `task-card-preview`，不再 `fillNoteBody` 铺全文。
- `test/work-package.test.js` 锁住上述列表渲染约束。
