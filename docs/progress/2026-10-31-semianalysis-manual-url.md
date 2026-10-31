# 2026-10-31 SemiAnalysis 只收手动公开 URL

媒体页可以粘贴 `semianalysis.com` 的公开文章地址。保存的是公开导语，`contentLevel` 为 `partial`，并标成截断。不把这条标成全文。

不抓 Newsletter RSS / Atom，响应里如果出现 `content:encoded` 或 feed，直接拒绝。401、403 和付费墙没有可分开的公开导语时，结果是 `policy_skipped`，不保存墙后的正文。来源同步和探针都不发请求。

Research API 只返回未接入。设置页写了同样的边界。详见 `docs/semianalysis-boundary.md`。

不新增 migration。当前 schema 仍是 97。需要重启 Web 才能看到粘贴入口；Worker 不用为这项重启。不改密钥。

## 本地验证

```text
node --test test/semianalysis-manual.test.js test/arxiv-media.test.js
```

测试注入页面，不会访问 semianalysis.com。
