# 小时报导航、空壳和类目密度

## 目标

底部「简报」打开后停在小时报，空小时不要看起来像成功刊期。类目小时报要带上雪球 7x24，并以紧凑的方向要点为主，而不是让待标注的 12 条占满版面。

## 决定

- `#report` 没有 `hour`、也没有 `mode=daily` 时，简报按小时报打开，并尽量把当前上海小时写进 `#report?hour=`。点「日报」写成 `?mode=daily`，点「股民讨论」写成 `?mode=discussion`。带日期且没有小时的地址仍是日报。
- 信息树小时刊期在没有根、也没有输入、也没有未完成材料时，状态是 `empty`，不再是 `ready`。类目小时没有分类时同样是 `empty`。页面写「本小时暂无入料」。旧的 `ready` 且根数为 0 的小时，页面也按空小时说明。
- 类目候选放行雪球 7x24（`xueqiu:home:livenews`）。信息树候选、信息准备和阅读分类仍按 `config/flash-sources.json` 排除它，产业在线快讯等其它快讯两边都排除。YouTube 仍不进类目。
- 类目双栏里，信息树默认折起，类目是主栏。窄屏类目在上，树在下。类目块是方向标题、一句要点和原文链接，不再套阅读卡片。
- 待标注送给模型的不超过 8 条。模型没覆盖到的材料按标题补成短句和跳转，放在同一个默认折起的块里。正式分类仍一次最多 12 条模型事件，没被引用的材料同样按标题补上。一条分类最多保存 80 条事件。
- 收录时间窗仍是入库时刻，不改成 `published_at`。`report.hourly.failure-catchup` 保持关闭。

## 改动

- 导航：`apps/web/public/brief-page.js`、`information-tree.js`、`app.js`、`report-history.js`。
- 类目放行 7x24：`packages/domain/src/information-tree-materials.js`，Worker 类目口改用 `categoryCandidates`。
- 空壳和待标注补齐：`packages/domain/src/hourly-category.js`、`information-tree-service.js`，契约增加 `empty`，事件上限 80。
- 版式：`apps/web/public/hourly-category-view.js`、`styles.css`。

## 验证

`node --test test/hourly-category.test.js test/flash-sources.test.js test/brief-page.test.js test/report-history.test.js test/information-tree-next.test.js test/uiux-reading.test.js test/hourly-unread.test.js`

- 打开 `#report` 停在小时报，地址带 `?hour=`；`?mode=daily` 刷新仍是日报。
- 类目候选含雪球 7x24，树候选不含。
- 没有材料的小时状态是 `empty`，页面写「本小时暂无入料」。
- 待标注块默认折起，正式方向是短要点和原文链接。窄屏先看到类目。

## 遗留

信息树和阅读列表仍不收雪球 7x24。已经封好的小时不会因为这次改动自动重写；下一轮整点任务才会按新规则写类目。失败补跑没有打开。
