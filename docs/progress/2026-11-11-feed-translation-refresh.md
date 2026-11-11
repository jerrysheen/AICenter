# 信息流译文刷新

## 目标

旧标签里官方条目先显示「无标题」，随后停在英文和「暂未翻译」。同一批在新标签里已经是中文。列表后来出现中文标题时，阅读页仍用英文原题，并停在「正在获取全文」。

## 决定

- 看板响应里的译文还是 pending、正文为空时，不写入 20 秒请求缓存。下一次读取会再问服务器。
- 合并译文时，空的 pending 或 failed 不能盖掉已经拿到的中文。后到的非空译文仍可以替换。
- 信息流再次进入，或手动刷新时，官方标题仍缺中文就绕过缓存再取一次看板。停在这一页时，pending 会按 2、4、8、15、30、60 秒再试，然后停止。失败且不再 pending 的条目不参加这轮定时重试，下次进入信息流仍会再问一次。
- 列表不再把「正在翻译…」画成「无标题」。阅读页和列表用同一份已完成的中文标题；语言切到原文时仍显示原题。全文还在获取时标题也不退回英文。
- 筛选、频道和返回路径不动。不改翻译模型，不新增 migration。

## 改动

`apps/web/public/feed-localization.js`、`apps/web/public/client-request.js`、`apps/web/public/app.js`。

## 验证

`node --test test/feed-localization-refresh.test.js test/client-request.test.js test/translation-reliability.test.js test/feed-scope.test.js`

晚到的中文会留下。更早返回的空译文不会盖掉它。阅读页在取全文时用列表上的中文标题。pending 的看板响应不会被 20 秒缓存复用。

## 遗留

定时重试大约两分钟后停止。更晚才译完的标题，要再进一次信息流或点刷新才会出现。终端失败的条目不会在当前页里反复请求。
