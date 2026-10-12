# 2026-10-12 小时报阅读分类分批

小时报给材料做阅读分类时，默认一次发送 10 条。`AI_CENTER_READING_CLASS_BATCH=1` 时仍是原来的一条一次。信息树浓缩不改。`AI_CENTER_HOURLY_DISABLED=1` 时小时任务仍然不会入队，也不会跑到分类。需要重启 Worker。

## 调用

批量提示词是生产用的 `READING_CLASS_INSTRUCTION`，后面追加一句：输入是带 `idx` 的数组，逐项独立判断，输出 JSON 数组，每个 `idx` 一个对象，字段与单条输出相同。

返回按 `idx` 对齐。整段不能解析，或某个 `idx` 缺失、重复、主类或细类非法时，只对那些条再发原来的单条分类。已经判成 `classified` 或 `out-of-scope` 的条目直接落缓存，不再重打。

配额耗尽、429 或现有准入返回的 `budget-deferred` 不拆成逐条。`AI_CENTER_HARNESS_HOURLY_PROVIDER=google` 时，每一批按 `AI_CENTER_GEMINI_KEY_ENVS` 里已配置且不重复的 key 轮询，请求仍带 `googleKeyEnv`，由小时报原来的按 key 准入决定能不能发出。这一轮 key 都进不了，整批记为 `budget-deferred`。不是 Google 小时路由时不指定 key。

## 结果

每条仍写入 `reading-class` 阶段记录，键和版本与单条分类相同。文章节点上已有的 `readingClassification`，以及完成的阶段缓存，继续按条复用。页面快照字段不变。

## 环境

```text
AI_CENTER_READING_CLASS_BATCH=10
```

未设置时是 10。必须是大于等于 1 的整数。
