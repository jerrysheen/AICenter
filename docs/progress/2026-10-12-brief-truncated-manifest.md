# 弱网截断响应不再打开旧版简报

只改前端。不改接口、数据库和生成。

截断的 gzip 仍可能以 HTTP 200 到达。`api()` 原来把 JSON 解析失败收成 `{}`，简报把这份空清单缓存 30 秒，`pipeline` 对不上 `tree-v3` 就进入旧版 `build()`，页面上出现「三层浓缩树」。

- `apps/web/public/app.js`：200 的响应解析失败时抛出「响应不完整，请稍后重试」。非 200 的非 JSON 错误体仍按状态码报错。
- `apps/web/public/brief-page.js`：只有带 `pipeline` 的清单写入 30 秒缓存。读取失败或清单没有 `pipeline` 时，保留上一份有效清单；没有上一份就显示骨架和「重试读取」。只有服务端明确返回非 `tree-v3` 的 `pipeline` 才进入旧版简报。滚动升级时没有 `pipeline`、但有 `tree-response-v3.1.0` 信息头的清单仍进树，且不缓存。旧版入口按钮改为「旧版简报」。

## 验证

`node --check` 覆盖 `app.js`、`brief-page.js` 和树页面脚本。`node --test` 1134 项：通过 1122，失败 11，跳过 1。新增的 `api-json` 与 `brief-manifest-fetch` 通过。这 11 项失败都不在本改动里：分析技能 7 项（已发布文本与登记哈希不一致）、信息树策略 1 项、工作包启动器 1 项、`model-usage` 因当前 Node 22.14 没有 `node:zlib` 的 zstd、工作包因本机没有 Cursor CLI。
