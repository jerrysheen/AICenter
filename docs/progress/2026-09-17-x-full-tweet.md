# X 长帖补全文

首页时间线 DOM 只含折叠后的 `tweetText`。本批拉取到的折叠帖（Show more / 省略号）全部打开 `/status/:id` 补全文，不再设 15/50 条上限。

发给翻译等模型的请求由 Domain `packFeedAiBatches` 标注字数并按约 5000 字分组；超长条目只把模型输入截到预算，入库哈希仍对全文。
