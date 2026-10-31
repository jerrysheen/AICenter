# SemiAnalysis 产品边界

SemiAnalysis 这一轨只做人读公开页，或在媒体页粘贴一条公开 URL。

- 不批量抓 Newsletter 的 RSS / Atom，也不把 `content:encoded` 当成全文。
- 保存成功时 `contentLevel` 是 `partial`。导语最长约 1200 字，并标成截断。不标 `full`。
- 付费墙、401、403 记为 `policy_skipped`。不绕过登录，不保存墙后的正文。
- 公开页如果只有付费提示、没有可分开的公开导语，同样跳过，不入库。
- Research API 只留状态：`available: false`，`reason: not_connected`。代码不会去请求它。
- 来源同步是空操作。打开或关闭这个来源都不会去拉 feed。

粘贴入口在媒体页。设置里的说明与本文一致。
