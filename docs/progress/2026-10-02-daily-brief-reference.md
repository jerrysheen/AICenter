# 2026-10-02 日报观点引用

## 目标与交互

为日报每条筛选观点增加 ref，沿用现有引用栏、预览、材料包和「去问答」，让用户围绕选中的消息继续提问。

- 每条观点卡底部显示「引用」，选中后为「取消引用」。六种候选类型共用这一入口；今日日报和历史日报共用同一渲染函数。
- 复用现有 ref0 / ref1 标签，可多选、查看观点全文、删除、清空、导出材料包或带去问答；最多 8 条的既有上限不变。
- 问答会接收观点、为什么值得看、接着看、生成时保存的候选事实与来源引用。明确标记 DailyBrief 是模型筛选观点，避免把观点当作新增事实。
- 回答来源栏增加「日报」分组，点击后定位到对应日期的观点卡；已更新或不存在的引用会提示重新选择。
- 复用现有 note-foot / text-button 样式，没有新增移动端或桌面布局规则。

## 数据与分层

- 新增 `daily-brief-item` 引用类型，`resourceId = reportDate/candidateId`，`revision` 必填并等于 `DailyBrief.generatedAt`。按候选 ID 引用，不依赖卡片序号。
- 候选 ID 最长 256 字符，因此日报引用 ID 最长 267 字符。主动输入、Agent 引用持久化与 AiRunContextRef 读取均支持这一长度；其他主动引用仍最多 256 字符。
- Context Service → Report Service → Report Repository，按 workspace / 日期读取 `daily_report_briefs` 已有的 `brief_json` 与 `input_snapshot_json`；Web 与 Worker 都注入同一个 Report Service。页面只提交标识与版本，不提交事实正文。
- 沿用 `resolveReferences()`、`context/pack`、问答 Job、`ai_run_context_refs.origin=selected` 和回答来源栏，没有新增 API、Agent、数据库表或 migration。
- 日报重生成后不静默替换旧引用：版本不匹配时返回 missing，并向模型说明不得猜测缺失观点。当前只保留每日期最新 Brief，已发送的引用标识仍保存在会话，重生成后不承诺历史观点全文可以重新读取。
- 同步更新 `docs/contracts-v1.md`、`docs/architecture-modules-v1.md`。保留工作区其他已有改动，没有提交 Git。

## 验证

- `node --test test/daily-brief-reference.test.js test/context-pack.test.js test/answer-source-footer.test.js test/reference-pack-ui.test.js test/daily-brief.test.js test/domain-services.test.js`：42 项全部通过。
- 新增 7 项回归测试：引用形状与长度、六类观点、日期与 workspace 隔离、重排、去重、重生成缺失、真实材料包 HTTP、AI 上下文与来源保存、不同版本来源去重，以及真实 Worker 对 267 字符引用的持久化与会话再读。
- 本机 Chrome headless 执行实际 app.js 引用函数，390 / 768 / 1280 / 1920px 下验证引用、取消、多选、预览、删除、去问答、版本传递及清空全部通过；页面无横向溢出。
- 另在 390 / 1280px 下执行实际导航、日报读取和来源跳转函数，确认历史日期路由、对应观点高亮、仅一次读取与旧版本拒绝。测试使用临时固定数据和 DOM 事件，没有操作桌面鼠标键盘或用户数据，未增加仓库依赖。
- `npm.cmd run typecheck:contracts`、相关 JS 语法检查、`npm.cmd run harmony:verify` 通过。
- 全量 `npm.cmd test` 在新增第 7 项测试之前执行：584 项，568 通过，16 失败。12 项涉及工作区已有媒体自动补全启动任务先于测试指定任务取出（Worker 默认 schedules 分支新增 `enqueueMediaIndexEnrich`，订阅测试直接显示实际任务为 `media.index.enrich`）；其余 4 项是此前已记录的启动器进程扫描断言、两处 schemaVersion 预期 32 / 实际 33、个人资产工作簿预期 57 / 实际 58 个期间。本次实际 Worker 回归关闭默认 schedules，独立验证日报引用链路通过。
- `npm.cmd run check` 的 syntax / syntax:source / syntax:harness / Contract typecheck 通过，在 architecture:verify 停止：工作区已有 `media-ingestion-service.js` 直接依赖 Connector 的 article-html / article-url / feed-xml / http，违反 Domain 依赖方向。本次未修改这些依赖。

## 生效

服务端与 Worker 有代码变更，运行中的实例需重新启动 Web 和 Worker，再刷新页面；没有自动重启用户实例或修改用户数据库。
