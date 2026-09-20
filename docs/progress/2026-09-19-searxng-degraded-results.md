# SearXNG 降级结果不再当成有效检索

## 目标

《复杂》复跑时 Jev 拒掉 36 条奖学金站、美妆站、微软账号、NFL、WhatsApp。问题不在 Evidence Gate，而在 `search.web` 把失效上游的残渣标成 `available: true`。

## 现场

同一分钟 Search Worker 日志：Google CAPTCHA 挂起 1 小时、Brave 429、DuckDuckGo 全天验证码。配置里只剩 Bing + Wikipedia。对本机 SearXNG 复测，`unresponsive_engines` 明确列出这三家，Bing 单独返回印地语翻译站、UP 奖学金门户、扫码页、眼镜店；语言参数 `en-US` 时 DuckDuckGo 仍能给出豆瓣 / 诚品书目。Connector 原先忽略 `unresponsive_engines`，前 N 条原样交给 Agent。

## 决定

- Connector 读取 `unresponsive_engines`，丢掉登录页/应用壳、同一主域 ≥3 条的刷屏，以及 Bing HTML scrape 整批结果（本机该源经常回填无关购物/翻译/登录页）。
- 投影增加 `note`，Source Snapshot 在降级时为 `partial`；不把引擎名写进模型上下文。
- 默认 SearXNG 模板停用 Bing。Jev 仍负责语义相关性，不在 Connector 里做书目判断。

## 验证

- `node --test test/searxng.test.js`
- `npm run check` 中与 search / source 相关的用例
