# X 信息流按抓取先后排序

## 目标

拉取后的列表按「这次抓下来的前后」阅读，不要按推文发布时间把旧缓存顶到最前。

## 原因

本轮库里最新一批 X Capture 是 42 条（32 条新 ContentItem，10 条正文变化后重写）。按 `published_at` 排序后，这 42 条里只有 2 条出现在列表前 20；其余掉到第 24–369 名。抓取本身按推文 ID 去重是对的。

## 决定

- Provider 列表：`captures.captured_at DESC`。
- 写入时给同一批打上递减的 `capturedAt`，保持 Chrome 时间线顺序。
- 内容 hash 未变则跳过，不刷新 `capturedAt`。

## 验证

- `npm run check`
- 再拉一次 50 条后，本批新增/更新应出现在 X 信息流顶部；卡片时间仍是发帖时间。
