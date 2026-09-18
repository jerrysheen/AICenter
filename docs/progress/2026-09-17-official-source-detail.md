# 官方信源详情读取

日期：2026-09-17

## 本轮完成

- 保持静态信号看板为轻量列表，不向 `ScheduledEvent` / `OfficialRelease` 塞入全文。
- 新增内部 `policy.official-detail` Source，按官方 `sourceUrl` 获取标题、官方摘要和清洗后的限长正文。
- 新增 Agent 只读工具：
  - `static.signals.list`：读取官方日程和最新发布，向 AI 提供后续详情读取所需的 `sourceUrl`。
  - `official.source.get`：按需读取某条官方页面详情，不生成解释层内容。
- 详情读取限制在已登记的中美官方域名；HTTP 仅允许 `english.scio.gov.cn`，并检查跳转后的最终域名。
- SCIO 详情可以读到模板标题之外的发布会主题；Federal Register 通过官方 JSON API 和 raw text 获取摘要与正文。
- 内部详情 Source 不出现在公开 Source 清单，也不能经通用 Source HTTP 路由直接读取。

## 验证

- SCIO 2026-07-28 发布会详情成功提取官网标题、税收改革主题摘要和正文。
- Federal Register、White House、Federal Reserve、中国政府网政策、中国政府网会议和人民银行样本均完成真实官网详情探测。
- 定向 Contract、Connector、Source、Agent Tool 与 HTTP 隔离测试通过。
