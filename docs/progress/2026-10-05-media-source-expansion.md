# 新闻栏目与差异化来源扩充

## 目标与决定

用户提供新闻源扩展研究并明确要求落实。沿用`native-channels-v1`、现有Media Service / Repository / Connector / Worker；不增加Agent、数据库或主题关键词过滤。

第一批增加BBC Technology、Science & Environment，Guardian AI、Energy industry、Manufacturing sector、International trade，以及EIA Today in Energy、Utility Dive News；复用已有`thelec`身份，改用官方CDN RSS和正文读取。FT主站继续只承诺索引，Yahoo AI Hub/分页、新游戏与工程源、BIS等后续候选不在这批上线范围。

运行数据库实查活动额度占用13（包含两个discovery出版商、排除已有官方Adapter），六个新栏目不能在原16上限内全部启用。契约允许上限从16兼容扩至24，缺省仍6，当前Instance设24；登记总数从32到40，仍不超过40。保留全部旧来源与启用选择，不用关闭World替换新栏目。当前批次新增九个活动入口后占用22。

## 改动

- `config/media.json`保存八个新入口及THE ELEC校正，默认enabled仍false；真实运行状态由数据库与Service显式启用管理。新入口按最近7天回看，刷新120–360分钟，正文日额度沿用null。
- Connector按来源`publisherKey`选择正文边界，缺失时兼容旧`sourceKey`。BBC新键复用已有段落规则和音视频排除。Guardian仅取已验证正文容器，排除newsletter/callout和外部推荐；live页面返回`live_template_unverified`，视频返回`non_article`，不套用普通文章full。
- EIA识别`tie-article`，保留正文、表格、数据来源说明与贡献作者，移除topic导航。图表存在时保留`visualEvidenceRequired`，文字全文不代表图表已经阅读。THE ELEC仅识别`article-view-content-div`。缺容器、访问墙与付费预览维持真实失败原因。
- 复用规范化URL合并、一篇正文多个discovery、公平正文队列、翻译/Tag缓存、已读/隐藏状态；不重算历史ID，不改已执行migration，不清预算统计。
- 增加`scripts/audit-media-expansion.mjs`：生产SQLite仅readonly，HTTP逐源低并发抽样，报告固定滚动24小时窗口与另列7天窗口，无Job、模型、BrowserRuntime或外部通知。真实RSS/HTML只写忽略的Host audit目录；仓库仅保留合成测试。

## 只读入口和正文验收

本机每轮13个RSS入口（4个旧栏目基线+9个扩充入口）、19个正文样本请求，合计32次HTTP，无跳转；所有RSS成功。18个普通文章采集样本（含跨栏目重复样本）均得到连续正文，另1个Guardian视频明确`non_article`。对照原DOM首尾，排除了Guardian之前可能混入的推荐尾部及newsletter；EIA初次unsupported模板在补充容器后通过。普通文章样本覆盖24小时/7天；制造业第二篇为窗口外旧样本，在逐篇报告中单独标记。

| 入口 | RSS条目 | 最近24h | 最近7天 | 24h相对旧栏目净新增URL（逐源） |
|---|---:|---:|---:|---:|
| BBC Technology | 21 | 1 | 15 | 0 |
| BBC Science & Environment | 42 | 4 | 27 | 4 |
| Guardian AI | 20 | 5 | 20 | 4 |
| Guardian Energy industry | 20 | 1 | 20 | 1 |
| Guardian Manufacturing sector | 20 | 0 | 1 | 0 |
| Guardian International trade | 20 | 0 | 4 | 0 |
| EIA Today in Energy | 22 | 0 | 3 | 0 |
| Utility Dive | 10 | 0 | 10 | 0 |
| THE ELEC | 50 | 5 | 50 | 5 |

全批去重后24小时相对旧栏目新增14个URL；这是文章URL净新增，不能称为14个独立事件。仅验证当前feed所见范围，不宣称覆盖该时间窗全部历史；停止原因记录`feed_end`，未作历史分页。低频源短窗口为0不视为坏源。只读阶段源状态前后相同。

验收原始数据：Host `media-audit/expansion/acceptance.json`；源码合成回归包含出版商路由、视频/live、正文噪声、图表说明、缺模板、付费墙、跨新栏目一篇正文多发现、Service重建后已读保持及24槽位边界。

## 生产启用与最终验证

全仓`npm run check`最终693/693通过，包含语法、Source/Harness、契约类型、架构、Harmony及测试。新增6项合成回归，原来源清单断言按本批范围更新。

生产先执行SQLite在线backup，随后Service逐源探针9次全部ready、正文用途确认与显式启用9项成功。通过现有本机Launcher重载Web/Worker，真实tech/macro API均200且显示新入口enabled。Runtime Service入队注册的`media.sources.sync`，长驻Worker完成并自动继续enrich；没有另起采集进程或任意HTTP命令。

2026-10-05 05:51Z的首轮落库快照：

| 入口 | 新文章索引 | 已存全文 | 发现关系 |
|---|---:|---:|---:|
| BBC Technology | 8 | 6 | 15 |
| BBC Science & Environment | 19 | 17 | 23 |
| Guardian AI | 16 | 15 | 20 |
| Guardian Energy industry | 18 | 15 | 20 |
| Guardian Manufacturing sector | 0 | 0 | 1 |
| Guardian International trade | 1 | 1 | 4 |
| EIA Today in Energy | 3 | 3 | 3 |
| Utility Dive | 10 | 9 | 10 |
| THE ELEC | 50 | 50 | 50 |
| 合计 | 125 | 116 | 146 |

生产回看7天与上述24小时研究窗口不同，125不是当天净新增事件数。制造业唯一窗口内文章已存在，保留原ID和正文，仅补发现关系。九篇未达全文的原因分别为`coverage_unverified`、`unsupported_template`、`preview`及`non_article`，没有标成full。已有ID全部保留，原已读/隐藏状态逐条核对保持。活动额度占用22/24，没有关闭既有来源。

普通文章抽测的18个样本中，11个已存正文与只读样本哈希一致；6个索引沿用已有跨栏目正文快照，未以本次样本强制覆盖；1个制造业旧样本在回看窗口外未入库。视频只保留索引，不比较全文哈希。不把跨栏目复用的旧快照说成本次重新验收的全文。

源状态、在线备份、Job结果、正文原因与样本对照记录在Host `media-audit/expansion/{activation,production}.json`，不提交数据库与原站全文。快照时enrich仍在翻译/打标，完成正文采集不等于所有译文和Tag已完成；继续使用已有Worker与缓存重试，不另派付费模型验收任务。

## 遗留与边界

这是用户授权的媒体来源专项，不替代0.2.0隐私/安全整体验收。RSS的可读与全文样本不能保证所有模板长期稳定。未开发直播时间线解析、浏览器翻页、新凭证接口或付费全文；不添加关键词过滤。源正文出现图表时文字只能作为文字证据，图表需单独核验。
