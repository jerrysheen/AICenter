# 2026-10-14 overlay 的 CRLF 把问答打停

`#92` 合并后，问答在 1 秒内失败，错误是 `Harness overlay 缺少 web.searchProvider 覆盖`。服务器 `core.autocrlf=true`，`packages/harness/aicenter.cordis.yml` 检出带 CRLF。`launch.js` 用 `\n` 匹配 `web.searchProvider`，对不上。

## 决定

- 生成 overlay 时先把 `\r\n` 和单独的 `\r` 收成 `\n`。`web` 与 `web-search-deepseek` 的匹配写成 `\r?\n`。写给 dsh 的文件是 LF。
- `.gitattributes` 增加 `*.yml text eol=lf` 和 `*.yaml text eol=lf`，以后检出不再把这两类文件转成 CRLF。

## 验证

- `node --test test/harness-runtime.test.js` 里的 CRLF 用例：把现有 overlay 换成 CRLF 再生成，搜索仍是 `elucid-grok`，DeepSeek 搜索仍禁用，写出的文本没有 `\r`。

## 重启

不新增 migration。不要重建数据库。需要重启 Worker。Web 不用为这项重启。
