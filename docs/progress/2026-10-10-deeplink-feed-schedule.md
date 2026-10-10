# 热修：行情单飞超时、信息流与日程首屏、重点窗口、股票页骨架

`cached()` 对同一行情键复用进行中的 Promise，但只在完成时删掉记录。一次卡死的 `markets?board=overview/us/cn/asia` 会让该板块之后的请求一直等。现在每次读取最多 20 秒，超时就清掉这条 in-flight 记录并报错，下一次请求可以重新发起。没有加服务端 TTL。

`#feed` 的列表加载原先要等 `bootstrapped`。硬刷新时 `setView` 更早，会话已经有了也不拉当前 tab。现在会话在即可 `ensureVisibleFeedLoaded()`。媒体列表在画出缓存后立刻 `readFeed`。

总览「近期日程」和 `#sources/schedule` 在还没有 `staticBoard` 时调用 `loadStaticSignalBoard()`。没有条目时 `#static-upcoming` 写一行「近期没有日程」。日程行补上时间、标题和说明。

信息流「重点」仍用原来的星标筛选。分页之后「全部」只留下第一页未读，再进「重点」会因为 `xLoaded` 不再拉，已读星标进不了这 12 条。进入「重点」时按接口允许的每次 50 条，把 X 和雪球补到合并前的 200 条窗口，并把 `isSaved` 留在列表项上，现有 `itemIsFocused` 才能看见。筛选函数没有改。

股票页切过去时先画出子页签和「--」占位，数据回来再填当前板块。某一板块失败只在该板块显示重试，不改其他板块已有数据，也不改样式。
