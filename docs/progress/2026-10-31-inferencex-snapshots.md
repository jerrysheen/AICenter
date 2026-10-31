# 2026-10-31 InferenceX 跑分快照

InferenceX 不进媒体文章。Worker 在 `AI_CENTER_INFERENCEX_SYNC=1` 时每天拉公开 `GET /api/v1/availability`，以及可选的 `GET /api/v1/benchmarks?model=`。benchmarks 只带官方要求的 `model`，不另加会返回 400 的参数。两次请求至少间隔 3 秒。

缺模型、硬件、框架、精度、isl、osl、disagg、spec_method、benchmark_type、日期或原始链接的行不入库。页面和 `GET /api/v1/inferencex` 只读这些条件。带 tokens/s 的行标记 `investmentUse=not_a_conclusion`，不能当成投资结论。周摘要进 `#report` 这次没有做。

新表是 `inference_availability_snapshots`、`inference_benchmark_observations`、`inference_source_checks`。migration 98。当前 schema 是 98。下一号是 99。空号仍是 63、79、80、82。不要重建数据库。默认定时关闭。打开后需要重启 Worker；页面要重启 Web 并再加载一次。

## 本地验证

```text
node --test test/inferencex.test.js
```

测试注入响应，不会访问 inferencex.semianalysis.com。
