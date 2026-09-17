# 豆包网页聊天 Connector

## 目标

在已登录的 BrowserSkill Chrome 里向 `https://www.doubao.com/chat` 发一条消息，等到可见回复稳定后把文本收回来。不模拟登录，不给 Agent 加 Browser Tool，不恢复 Chrome CDP。

## 决定

- 登录仍由用户在扩展所连 Chrome 完成，与 X / B站相同。
- 由环境变量定位的旧仓 `skills/ask-sider` 只借鉴流程：写入输入、确认已发出、轮询到文本不再增长。不复制 CDP 客户端。
- 豆包输入是 TipTap / ProseMirror（`el.editor.commands.setContent`），不是 textarea。空输入时右侧是语音，有字之后才出现 `.send-btn-wrapper button`。
- `element.click()` 在豆包上不可靠（非可信点击）。发送改走 BrowserRuntime 的 `bsk click --selector`。`bsk fill` 对 ProseMirror 会报 not focusable，所以写入仍用 TipTap API。
- 结束信号优先 `[data-streaming="true"]` 消失，以及 `.md-box-root` 文本连续多次不变；`停止生成` 作为补充。用户气泡用 `[class*="send-msg-bubble"]`。
- `status=send_not_confirmed` 才允许重发；`reply_not_observed` 只再读，不重发。
- 发消息必须经 `createDoubaoAskQueue`：一次一条、回收回复。当时写法曾暗示翻译 / CLI / API 共用一条队列；现行边界是**各进程实例内部串行**，见 `docs/release-readiness.md`。

## 入口

```text
node scripts/ask-doubao.mjs --inspect
node scripts/ask-doubao.mjs "请只回复：OK"
node scripts/ask-doubao.mjs --as-json "请只回复：OK"
```

## 验证

- `npm test -- test/doubao-chat.test.js`
- 真机：`ask-doubao.mjs` 对已登录豆包发出测试句并回收回复。

## JSONL 信封

发给豆包的是**一条 JSONL 记录**（`custom_id` + `messages` + `input_template`）。信息流翻译已按同一规则接入：`task=translate_feed_items`，输出 `feed_translate_output.v0.1`，验收失败走 Gemini。见 `2026-09-17-doubao-translate-jsonl.md`。
