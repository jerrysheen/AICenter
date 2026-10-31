# 类目小时的媒体要点改用已有中文

## 目标

Techmeme 等媒体条目在 `feed_item_translations` 里已经有中文，类目小时的 bullet 仍是英文标题。只读已经落库的译文，不新开翻译。

## 决定

- `#254` 只改了信息流。`feed.listHourlyCategoryTexts` 按内容 id、`provider:externalId` 和 `localizationItemId` 读中文。媒体侧 `media.listHourlyCategoryTexts` 仍只读 `media_index_entries` 的标题和摘要。
- 未核实全文的媒体标题（Techmeme 是 discovery）写在 `media:{externalId}`。标识超过 128 字时，同一条规则收成 `h:` 加哈希，和信息流用的 `localizationItemId` 相同。现在这两处有中文就优先用，没有汉字的译文行不当中文。
- 没有译文时仍用英文标题或更长摘要。截断原题不当最终 bullet 的规则不变。不为此加 Flash，不打开失败补跑，不计算 `media-block-v2` 段落哈希，也不回填 BBC、Guardian 等还没有中文行的来源。
- 信息树和日报不改。页面不改。

## 改动

- `packages/database/src/repositories/media-repository.js`：`listHourlyCategoryTexts` 带回已有中文。
- Worker 的 `excerptPort` 本来就会把这份结果交给类目小时，不用另接一条读取。

## 验证

`node --test test/hourly-category.test.js`

- `media:techmeme:zh` 有中文时，取文和模型输入都用这句中文；模型回英文时刊期仍换成译文。
- 同一条只有英文译文、或没有译文时，bullet 留英文标题。
- 只存在 `localizationItemId` 哈希键上的中文也能读到。

不新增 migration。当前 schema 仍是 97。下一号是 98。空号仍是 63、79、80、82。不要重建数据库。

## 部署

只需要重启 Worker。页面和 Web 路由没有改，Web 不用为这项重启。

已经落库的类目刊期不会自动重写。失败补跑仍然关闭，启动也不会把旧小时送进模型。下一轮 `report.hourly.extract` 只写刚结束的那一小时，那一小时才用新要点。

要让某一期已经 ready 的类目小时改成中文，用现有的桌面接口单独重跑这一小时：`POST /api/v1/reports/hourly/generate`，正文 `{"hourStart":<该小时起点的毫秒时间戳>}`。这一条会入队 `report.hourly.extract`，类目刊期在信息树之前重写。每个非空桶仍会打一次类目模型。不要连续排很多小时，也不要把 `AI_CENTER_HOURLY_NO_CATCHUP` 设成 `0` 去扫历史。不重跑的刊期保持原样。

## 遗留

正文块译文如果只存在 `media-block-v2:` 或旧的 `media-full:` 段落哈希下，这条小时报仍读不到。BBC、Guardian 等还没有中文行的来源不在这次补。
