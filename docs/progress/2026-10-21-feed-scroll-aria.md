# 信息流重绘测试补上属性方法

2026-10-21。`#213` 合入后，`test/feed-load-more-scroll.test.js` 的「重绘时可见卡片留在原地」必现失败：`elements.feed.removeAttribute is not a function`。`3c68715` 上这条是通过的。

页面没有写错。`elements.feed` 来自 `document.getElementById('feed')`，真实元素有 `removeAttribute`。骨架画上时给信息流加上 `aria-busy`，内容画出来时再清掉。这条测试用的是自己造的节点，以前只实现了 `replaceChildren` 和位置，没有属性方法。内容重绘走到清掉 `aria-busy` 时，假节点上没有这个函数，滚动恢复还没开始就抛了。

测试桩补上 `setAttribute`、`getAttribute`、`removeAttribute`。重绘前先标上 `aria-busy`，重绘后确认它被清掉，可见卡片仍停在原来的位置。页面代码不改。

不新增 migration。当前 schema 是 96。下一号是 97。空号仍是 63、79、80、82。不要重建数据库。Web 和 Worker 都不用为这项重启。
