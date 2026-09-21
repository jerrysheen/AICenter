# 分类器 Tag 标签重新显示

## 目标

信息流粗筛 Tag 仍由 Tagging Service 写入 `resource_taggings`，但读者从弹窗改成独立文章页后不再画出标签。

## 决定

- 继续走现有 Contract → Service → Repository：`GET /api/v1/tags`、`GET /api/v1/tagging`、`resource_taggings`。
- 文章页、信息流卡片和总览时间线用 catalog 名称渲染 tag chip。
- 信息流搜索也匹配 tag 名称。不改 Job / 分类器模型。

## 验证

打开已标注的 X / TrendForce 条目，文章页和列表应出现 catalog 中文名。
