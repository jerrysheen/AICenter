# 静态信号数据修复与首页聚合

## 范围

完成第一阶段静态信号收口：修复四个数据正确性问题，补齐中国重要会议/发布会来源，并把总览从 Source 目录改为投资者可直接阅读的确定性事实看板。

## 数据修复

- BEA `To Be Announced` 保留为 `status=tba`、`scheduledAt=null`。
- Census `Suspended` 保留为 `status=suspended`、`scheduledAt=null`。
- NBS 单月单元格支持多个日期与多个时间顺序配对；2026 日程使用具体官方页面，并去除页面重复表格产生的重复事件。
- GACC 必须找到请求年度的官方 Release Calendar 才返回日程；找不到 2026 页面时返回 unavailable，不按往年规律生成。date-only 条目的 canonical timestamp 改为当地 00:00，UI 不显示虚构小时。

## 新来源

- `calendar.cn.scio`：从国新办 Notices 标题读取已公开的发布会日期与时间。
- `policy.cn.gov-news`：从中国政府网公开要闻 JSON 中筛选国务院会议与中央政治局会议正式发布。
- Source 总数由 15 增至 17。当前主机访问 GACC 仍遇到官网证书链异常并按 Contract 降级。SCIO 英文站 HTTPS 证书与域名不匹配；经产品所有者明确接受后，仅该官方 Notices URL 改用 HTTP，不关闭全局 TLS 校验。

## 聚合与展示

- 新增 `StaticSignalBoard` 运行时 Contract 和 `/api/v1/static-signals/board` 只读接口。
- `packages/source/src/static/board.js` 并发读取低层 Source，确定性 merge、dedupe、sort；FOMC 专门 Source 优先于 Fed 综合日历。
- `focus-events.json` 只定义个人首页默认关注目录，不写入事件字段；“全部日程”仍读取完整低层日历。
- 首页主体改为市场 ticker、今日/未来日程、最新官方发布；原 Source 卡降级为底部数据源状态表。
- 链接按钮按事实语义显示“官方日程”“规则依据”或“原文”。

## 验证

- 新增解析、失败降级、聚合去重、关注投影和 Source API 测试。
- 本机实时烟测确认 BEA TBA、Census Suspended、NBS 3 月 4 日/31 日双日期、中国政府会议新闻、SCIO 27 条预告与聚合看板可读。
- 未使用 Computer Use；页面视觉验收仍由用户在浏览器中执行，自动语法与 Contract 测试覆盖本轮行为。

## 保持不变

- 不新增数据库 migration，不持久化 SourceSnapshot，不把日程写入 Feed。
- 不增加 AI importance、预期、影响、多空或摘要。
- 非政府聚合经济日历仍作为后续 coverage backstop，本轮停止继续扩 Source。
