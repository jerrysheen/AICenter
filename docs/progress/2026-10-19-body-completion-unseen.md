# 滑出时间线的正文待补全也会计次

2026-10-19。#164 上线后 `bodyCompletion=pending` 没有回落，仍全是 X：03:51 是 100 条，04:08 是 109 条，04:33 是 112 条。这台环境碰不到线上库，下面按代码说明次数什么时候不动。

次数只在这条再次进入入库时加一。首页一次最多 50 条，截断帖展开关注流最多 16 条、推荐流最多 8 条，到点剩下的记 `deadline`。没排进这 50 条的旧帖不会再出现在抓取结果里，`bodyCompletionAttempts` 保持空或 1，`bodyCompletionSince` 也不会写上。24 小时同样要等下一次入库才判断，所以滑出时间线的条目既不会满 3 次，也不会满 24 小时。新的截断 KEEP 每轮还在进 pending。失败或空的抓取不会入库，次数也不动。关注流和推荐流是两个来源，这一路的同步不会给另一路计次。

新进 pending 的展开失败，主要不是点击表达式又回到只认 testid。这一轮没排上展开名额、抓取到点，或状态页上「显示更多」点过之后控件还在，保存时 `truncated` 仍是 true，KEEP 就再标 pending。正文已经补全的会清掉 pending。

同一来源这一轮成功抓到了时间线、但这条不在结果里，也算一次。满 3 次或从第一次记下的时间起满 24 小时，清掉 pending，判定、原因和分数不动。抓取失败、结果为空，或这是另一路时间线，不计。已经 pending、没有次数的旧行，下一次没再见到就按第 2 次计，再下一轮清掉。

不新增 migration。当前 schema 仍是 91。下一号仍是 92。空号仍是 63、79、80、82。不要重建数据库。需要同时重启 Web 和 Worker。不用另跑脚本。

服务器上可以只读核对，不要加写语句：

```sql
SELECT json_extract(metadata_json, '$.bodyCompletionAttempts') AS attempts,
       COUNT(*) AS n
FROM captures
WHERE workspace_id = 'local' AND provider = 'x'
  AND json_extract(metadata_json, '$.bodyCompletion') = 'pending'
GROUP BY 1 ORDER BY 1;

SELECT c.external_id,
       s.external_id AS source,
       datetime(c.captured_at / 1000, 'unixepoch') AS captured_utc,
       json_extract(c.metadata_json, '$.bodyCompletionAttempts') AS attempts,
       datetime(json_extract(c.metadata_json, '$.bodyCompletionSince') / 1000, 'unixepoch') AS since_utc,
       json_extract(c.metadata_json, '$.filterDecision') AS decision,
       json_extract(c.metadata_json, '$.captureContext.truncated') AS truncated,
       length(json_extract(c.metadata_json, '$.originalText')) AS chars
FROM captures c
LEFT JOIN source_accounts s ON s.id = c.source_account_id
WHERE c.workspace_id = 'local' AND c.provider = 'x'
  AND json_extract(c.metadata_json, '$.bodyCompletion') = 'pending'
ORDER BY c.captured_at DESC
LIMIT 40;
```

次数几乎全是空或 1，说明这些帖子没有再次进入抓取结果。若 03:38 之后的新行也没有 `bodyCompletionAttempts`，Worker 还在跑 #164 之前的代码。
