# 作者列表不再被后台刷新拉回顶部

## 现象

信息流「作者」（`#feed?tab=author`）停在列表中段时，大约 1 秒内会跳回最顶部。电脑端大约三次里两次，手机上也出现过。跳回时前端正在轮询并收到 200：

- `/api/v1/feed/x?platform=x&feed=following`
- `/api/v1/feed/xueqiu?platform=xueqiu&feed=…`
- 两次 `/api/v1/tagging?resourceType=…`

作者页并不展示这些时间线。刷新结束后仍调用 `renderPosts()`，作者列表每次都 `replaceChildren()` 再整表重建，文档高度塌掉，滚动被夹到 0。平台标签再用 `scrollIntoView`，把窗口拉回这一行。

## 决定

X / 雪球加载完成时，作者页和「最近」「官方」一样不重绘信息流。作者列表本身：内容和上次画在页面上的一致就不动 DOM、也不碰滚动。有变化时按作者 id 原地改这一行；顺序变了才重排已有节点，并用视口里第一条作者把滚动补回去。平台标签只横滑自己那一行。

## 改动

- `apps/web/public/app.js`：`paintLoadedSocialFeed` 在作者页直接返回。
- `apps/web/public/author-view.js`：列表签名、原地更新、锚点恢复；去掉 `scrollIntoView`。

没有新的前端文件，不用改静态白名单。不新增 migration。

## 验证

`node --test test/author-list-scroll.test.js test/hour-scroll.test.js`

作者列表连刷 30 次位置不动；未读变化不换节点；关注把条目插到锚点上方时，锚点还停在原来的视口位置。文章页和小时报刷新不改 `scrollY`。X / 雪球轮询在作者、最近、官方页不调用 `renderPosts`，在「全部」和「社交」仍会画。

## 遗留

不新增 migration，schema 版本不变。不要重建数据库。需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。
