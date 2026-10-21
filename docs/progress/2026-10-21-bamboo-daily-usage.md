# 用量页显示 Bamboo 每天的准入调用

## 目标

本机用量页能看到 Bamboo 每天的调用次数，上限是 7000。信息流准入分类不变。

## 决定

次数仍是 `data/bamboo-usage-YYYYMMDD.json` 里的准入计数，按上海日。这个文件本来只计信息流准入，小时报、问答质量和资料召回不占这 7000。用量页只读最近 14 个上海日，不另记一次，也不改分类。

`GET /api/v1/runtime/model-usage` 多返回 `bambooDays`。每一天只有 `day`、`count`、`limit`。没有密钥、模型、地址或文件路径。文件读不了时 `count` 为 null，页面写「无法读取」。没配 `AI_CENTER_BAMBOO_DAILY_MAX` 时上限是 7000。

不新增 migration。当前 schema 仍是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Web，浏览器再加载一次。Worker 不用为这项重启。
