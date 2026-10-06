# 原生媒体频道采集修正与验收

## 目标与决定

按用户明确要求直接修改现有代码：采集范围由媒体原生频道决定，数量由既有预算决定，Tag只作后处理。科技和宏观媒体使用同一规则；X/雪球、政府央行、周报、UI及Agent执行器未作范围扩展。

## 改动

- `config/media.json`移除主题词，明确BBC Business/World和Guardian Economics/World入口与出版商。两个Yahoo署名入口合并为`yahooeconomy`，旧键保留为兼容别名，每频道正文上限仍为4，不累加成8。
- Service取消索引、正文候选、默认列表的主题过滤，取消focus/数字/标题语义评分与同标题合并；候选按新增发现和频道列表顺序、缺失顺序时发布时间，频道间轮流取。已完成且未变化的正文不因24小时到期进入普通队列；隐藏、失败冷却、预算仍生效。历史同URL候选也不会重复消耗正常正文请求。
- migration 36前向增加频道发现关系、列表位置、策略版本、出版商与作者字段。规范化URL精确相同的新增发现复用已有ID，保留多入口；不重算历史Capture/ContentItem/译文/状态/引用。旧Yahoo预算与新入口合并计算，不清零。
- 策略版本变化触发一次无条件读取；成功解析后才保存版本。旧ETag/304/feedHash不会永久遮蔽此前漏采项。窗口、元数据及正文额度沿用原配置。
- Yahoo实机核对后选择`main .stream section.story-item`主新闻流和对应headline tracking位置；不遍历整页，不包含顶部精选、导航或侧栏。逐篇保留所有出版商；只有已验证Reuters/Bloomberg正文规则可判断full，其他出版商明确`publisher_adapter_pending`。保留允许域名/路径、署名不一致、付费墙、挑战、稳定性、总时限和公开续读限制。
- Tag服务缺失也可注册和执行采集handler；不影响已保存正文和默认归属。未知发布时间保持null。同步handler仍通过现有JobRunner自动入队enrich，不需要手指定文章ID。

## 验证

`npm run check`最终通过648/648，包含语法、Source/Harness语法、契约类型、架构、Harmony及全仓测试。新增7个频道回归用例；既有测试适应新频道配置与取消主题规则。验证了无关键词文章、相同标题不同URL、跨频道复用、旧304恢复、预算延期、空/缺失Tag、未知出版商、列表容器、历史同URL候选及身份/状态保持。

实机命令：

```powershell
node scripts/verify-media-channels.mjs --run
node scripts/verify-media-channels.mjs --run --repeat --running-worker
```

第一轮由受控验收Schedule→注册sync handler→自动enrich→JobRunner完成，未传入文章ID。验收Schedule完成后关闭，原有每小时Schedule保持。实机先通过SQLite在线backup保存一致快照，migration 36已应用。

验收期间发现长驻Web/Worker仍加载旧代码，随后通过现有`restart.request`启动器机制重载。最终复核由已重载的长驻Worker领取任务完成，Web健康与媒体API验证成功；API中只出现一个Yahoo Economy频道，不再出现两个署名频道。初期混跑结果不用于声明重复翻译已通过。

| 入口 | 第一轮新增索引（整个所选列表） | 最新前10项已存索引 | 未存原因 |
|---|---:|---:|---|
| BBC Business RSS | 0 | 10 | 无；其中部分是窗口外已保存历史，不计为本轮新增 |
| Guardian Economics RSS | 3 | 10 | 无 |
| BBC World RSS | 11 | 10 | 无 |
| Guardian World RSS | 11 | 7 | 3项超出48小时窗口 |
| Yahoo Economy主新闻流 | 15 | 8 | 2项是视频等非登记文章路径 |

真实入口：

- BBC Business：`https://feeds.bbci.co.uk/news/business/rss.xml`
- BBC World：`https://feeds.bbci.co.uk/news/world/rss.xml`
- Guardian Economics：`https://www.theguardian.com/business/economics/rss`
- Guardian World：`https://www.theguardian.com/world/rss`
- Yahoo Economy：`https://finance.yahoo.com/topic/economy/`

合计恢复40条媒体频道索引，不使用政府回补代替验收。最新重跑新增0；正文请求增量0；仅对媒体译文ID及其全文分片核对，新增0、改写0；旧ID和已读/隐藏状态保持。正文快照数162→162。

前10条标题、URL、顺序、是否已有、索引状态、正文状态和原因记录在忽略的Host audit目录`media-audit/native-channels`；其中Yahoo包含原始前10项的结构性排除记录，不用过滤后的第11/12项冒充前10项。验收输出不提交原站全文、完整响应、模型记录或SQLite备份。

## 尚未完成的真实正文抽检

开始前当日正文请求已达96/96，成功正文计数43/56，且部分单源额度已满。本轮未提高额度、未清零计数。第一轮enrich选中40项，35项预算延期，5项出版商模板待适配，实际正文请求和新正文均为0。

因此本轮不能声明取得新增正文或完成新正文原站首末段抽检。已有快照边界哈希只验证存储，不代替原站抽检。新条目保持待处理，由已有Worker在预算恢复后继续；Yahoo其他出版商正文仍需专门验证适配，不能靠统一套用两家末段规则宣称全文。

## 取消采集每日配额（用户后续调整）

- 当前Instance的元数据、成功正文、正文全局/单源请求上限及每个来源detailDailyCap均设为null，明确表示不限额；保留旧数字配置兼容能力及实际计数，不采用扩大额度或清空历史计数。
- 默认契约不再生成每日配额；旧request_budget/success_budget冷却在取消相应额度后立即恢复。网络失败退避、刷新间隔、增量去重、字节限制和并发继续生效。
- 自动enrich处理全部已选候选，每批40条；后续批次不会被丢弃。新增回归验证旧96请求/56正文/300索引用量不再阻断处理，并覆盖43条候选跨批处理。
- 全量npm run check：650项通过。验收期间发现listWindowSources/listEntriesInWindow误放在mapState中，将原方法移回Repository，保留查询实现，修复来源状态回滚测试。
- 翻译检查：当前Gemini→DeepL（配置时）→Google；批量失败后逐条重试相同链路。明确禁止读取ELUCID_GROK_API_KEY的注释、环境样例和测试仍然存在，因此当前没有Gemini→Elucid翻译回退；未将用户的现状询问当作新增供应商路由授权。

后续取消每日配额已生效：npm run check 650/650通过；长驻Worker的实际请求计数已超过旧96次限制，新增保存146篇完整正文。历史文章身份与已读/隐藏状态保留，翻译及打标仍在现有Worker后台处理。此结论验证配额解除和正文落库，不替代逐篇原站首末段抽检。
