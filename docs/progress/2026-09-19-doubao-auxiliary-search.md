# 豆包只做联网补充检索

## 目标

翻译和粗筛 Tag 继续走 Gemini。豆包网页慢，但适合在联网搜索时补一轮公开资讯。不要把它再接回批量任务，也不要让每次 `web.search` 干等它。

## 决定

- 恢复豆包网页聊天客户端和进程内串行队列，只给补充检索用。不恢复翻译 / 标注脚本和对应 Connector。
- 第一次 `web.search` 时并行 `begin`。SearXNG 结果仍立刻交给模型。
- Final Guard 接受终稿后，最多再等剩余时限（总预算 80 秒，终稿后最多 35 秒）。有文本就追加「补充资讯」；超时、未登录或失败只记 warning。
- 同一次 Run 只问豆包一次。页面 Contract 不增加供应商标识字段。
- `AI_CENTER_DOUBAO_SEARCH_DISABLED=1` 可关闭。

## 验证

`npm test -- test/doubao-auxiliary-search.test.js test/doubao-chat.test.js test/doubao-ask-queue.test.js test/agent.test.js test/agent-trace-log.test.js`
