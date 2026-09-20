# 灵感/任务附图交给 Cursor CLI

## 目标

先把「选图 → 落盘 → 挂到灵感/任务 → CLI `--image`」跑通。不取信息流配图，不改鸿蒙分享收图，也不给问答 API 加 multimodal。

## 决定

- 权威对象是 Attachment。字节在 `data/blobs/attachments/`，SQLite 只记相对路径和 mime / hash / 大小。
- 灵感和工作包通过 `resource_attachments` 引用，最多 4 张，JPEG / PNG / WebP / GIF，单张 8MB。
- 页面只给 `/api/v1/attachments/:id/content`。本机绝对路径只在 Worker / Connector 解析，用于 `--image`。
- 继续做默认继承上一任务附图；请求里显式带 `attachmentIds` 则以新列表为准。
- 网页从底栏 `+` 选图片或往输入框粘贴截图。鸿蒙分享仍只收文本和链接。

## 验证

- `npm test -- test/attachment.test.js test/work-package.test.js test/contracts.test.js`
- 上传后工作包 `attachments[].url` 不含盘符；dispatch 的 `imagePaths` 指向 blob 文件。
