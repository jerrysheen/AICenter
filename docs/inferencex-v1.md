# InferenceX 跑分快照

公开只读。不进入媒体索引，也不写入 GPU 租金表。

`AI_CENTER_INFERENCEX_SYNC=1` 后，Worker 每天拉 `https://inferencex.semianalysis.com/api/v1/availability`。`AI_CENTER_INFERENCEX_BENCHMARKS=0` 可以关掉随后的 benchmarks。模型列表是 `AI_CENTER_INFERENCEX_BENCHMARK_MODELS`，默认 `DeepSeek-R1-0528`。请求只带 `model`。时刻是 `AI_CENTER_INFERENCEX_AT`，默认 07:40，时区默认 `Asia/Shanghai`。benchmarks 比这个时刻晚 10 分钟。

一行要同时有模型、硬件、框架、精度、isl、osl、disagg、spec_method、benchmark_type、日期和原始链接才保存。缺任何一项就跳过。tokens/s 可以空着；有数值时也只是该条件下的观测，接口写成 `investmentUse=not_a_conclusion`。

页面在全球行情的 AI Token 里，接口是 `GET /api/v1/inferencex`。
