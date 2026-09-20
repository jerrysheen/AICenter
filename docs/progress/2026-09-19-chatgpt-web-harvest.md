# 2026-09-19 ChatGPT 网页发出与回收

## 目标

用已登录的 BrowserSkill Chrome 给 ChatGPT 发一条问题，记下 `/c/<id>`，之后可以重新打开同一条对话抓正文。不模拟登录，不给 Agent 加 Browser Tool，不接云端隧道。

## 决定

- ChatGPT 首页输入框是 `#prompt-textarea`（ProseMirror DIV），没有豆包那种 `el.editor.commands.setContent`。写入走分块 `execCommand('insertText')`。
- 空输入时没有发送键；有字之后出现 `[data-testid="send-button"]`，文案是「发送提示词」。发送优先 `bsk click`。
- 同一条对话的稳定地址是 `https://chatgpt.com/c/<id>`。BrowserSkill session 关掉之后，用同一个已登录 Chrome 再 `navigate` 这个地址即可，不必重新登录。
- 正文节点是 `[data-message-author-role="user"|"assistant"]`，助手正文在 `.markdown`。页面水合大约要几秒，harvest 要等到角色节点出现。
- `dispatch` 只等到对话 URL 出现就返回，不等完整回答。`harvest` 再打开同一条 URL 读正文。已发出只再读，不重发。
- 发送前打开输入框旁的 `__composer-pill` 菜单：先点「聊天」而不是「工作」，再把思考滑条拨到「极高」（第 4 格），拨不到再退到「高」（第 3 格）。不进工作台。

## 入口

```text
  node scripts/ask-chatgpt.mjs --inspect
  node scripts/ask-chatgpt.mjs --prepare
  node scripts/ask-chatgpt.mjs --dispatch "问题"
  node scripts/ask-chatgpt.mjs --harvest https://chatgpt.com/c/<id>
```

## 验证

- `npm test -- test/chatgpt-chat.test.js`
- 真机：对已登录 ChatGPT 打开既有 `/c/<id>`，harvest 能读到助手正文。
