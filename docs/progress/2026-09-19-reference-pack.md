# 引用材料包：导出 / 任务 / 问答

## 目标

用户点选的 refs 不再只属于问答。同一组材料可以导出 Markdown、放进任务框，或继续带去提问。不接云端 GPT 隧道。

## 决定

- 不新增 Pack / Bundle 领域。协议仍是 `resourceType + resourceId + revision`。
- Context Service `packReferences()` 读取当前落库内容，带上日期、来源链接和已有译文。
- `POST /api/v1/context/pack` 返回 Markdown；页面复制并下载，或写入任务投递框。
- 信息流引用优先用已落盘译文作为问答正文。
- 持仓不作为新的 ref 类型。隧道外发后置。

## 验证

- `node --test test/context-pack.test.js test/contracts.test.js test/domain-services.test.js test/ask-research-mode-ui.test.js test/reference-pack-ui.test.js`
