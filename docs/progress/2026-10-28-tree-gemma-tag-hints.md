# prepare 把 Gemma 标签写进信息节点

## 目标

`resource_taggings` 里已经有非空标签时，信息树 prepare 写出的节点 `tagId` 仍经常是 null。抽样里能对上「第一个标签」的大约六成。

## 决定

信息节点的 `tagId` 用 Gemma 列表里第一个当前目录仍然认识的 id。不用 `groupByTag` 的小时分组代表；那个映射继续只在小时和日报归组时使用。

已经落库、并且 `tagId` 还在这份列表里的节点保持原 id。不因为列表顺序变化改写成第一个。

新建文章节点仍沿用 2026-10-21 的规则：第一个有效 id 覆盖模型在正文里返回的 `tagId`，哪怕模型返回的 id 也在列表里。

没有 tagging 行、标签是空数组，或里面没有当前目录的 id 时，不新造标签，也不清掉节点上已有的有效 id。人工锁定优先于 Gemma。

## 改动

`tagHints` 以前在目录版本字符串不一致，或 `analyzedAt` 早于内容 `updatedAt` 时返回 `undefined`。文章整理提示要求模型返回 `tagId: null`，于是节点就空着。这条过滤去掉了。未知 id 由目录过滤。

已有节点再进入 prepare 时，以前直接复用正文，不再看 Gemma。现在 `tagId` 为空或不在列表里时补上，不重新调用整理模型。

小时生成读到的材料只有来源 id，不在那条路径上改标签。

## 验证

`node --test test/article-normalize.test.js test/information-tree-next.test.js test/information-tree.test.js`

- `prepare writes Gemma tag hints onto a null tagId and does not invent one`
- `prepare fills a null tagId from Gemma hints and does not invent or clear one`
- `tag hints keep a listed id and do not invent one from an empty Gemma list`
- `saved Gemma tags replace the article model tag on the information node`

## 遗留

已经发布的小时刊期仍指向当时的节点。下一次 prepare 会换信息头；小时要等该小时再次生成才用新的 `tagId`。这次不改小时正文，也不回填旧节点。
