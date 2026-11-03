# X 抓取与行情请求恢复

## 范围与决定

沿用工作区已有的 BrowserSkill `moving: 'once'` 和 X 首页修补，不覆盖已暂存改动，不改迁移或页面 Contract。浏览器仍由 Host BrowserRuntime 统一访问，行情仍走已有 HTTP Connector。

## 修复

- BrowserSkill 将 `The media source changed; synchronize and replan` 归为页面变动。动作、cooperate wait、sync 和重试共用一个可取消的总时限，重试不再各自重新获得完整时限；调用方取消仍保留 AbortError。
- X 首页检查及首次提取遇到暂时页面变动时最多尝试三次。滚动中途的媒体变动和取消保留已读取的帖子。文章补全或评分期间取消也不清空已读结果。
- X 按本轮观察到的帖子 ID 判断翻页进展，已入库的帖子仍算页面向下推进的证据。连续两屏没有任何新的观察 ID 才停止。连续页面变动最多恢复三次，滚动最多 20 轮、70 秒，并服从更早的单源截止；单步读取也受滚动截止约束。
- X Service 收到带 deadline 的非空帖子时仍允许原有 Feed Service 入库。登录墙、栏目不匹配和无结果截止仍保持失败。
- 雪球报价的匿名令牌、批量报价及日 K，Yahoo 的报价、历史、搜索及 cookie/crumb，均将响应正文读取包含在原请求的超时范围内。收到响应头就移除 AbortSignal 的旧行为会让正文卡住后长期占用请求。
- Worker 每轮领取让出一次事件循环，避免立即完成的任务在微任务链里持续领取，拖延浏览器 IPC、HTTP 和截止计时器。回归用例在移除让出逻辑的版本中失败，修复后通过。
- 真实 Worker CPU 采样进一步定位到 `isYoutubeTranslationTarget`。启动时逐条检查非 YouTube 翻译，旧查询将 `ci.id`、`c.external_id` 和字符串拼接放进同一个 OR，导致扫描内容池。拆成内容 ID、供应商外部 ID 两次精确查询，沿用既有唯一索引；保留 workspace、YouTube 前缀与外部 ID 兼容，不新增 migration。真实运行库 100 次未命中查询耗时 7ms；夹具对实际查询计划断言无内容表/采集表扫描。

## 验证

- `node --test test/browser-runtime.test.js test/twitter.test.js test/xueqiu-quotes.test.js test/yahoo-quotes.test.js`：89/89 通过。新增用例覆盖媒体变动恢复、十屏已入库帖子后的新帖、非空 deadline 投影、sync 卡住后释放，以及行情正文超时后回退/下一轮请求恢复。
- 最终浏览器、行情、翻译判断、Worker 启动及并发专项合计 178/178 通过，Host 日志 `.ai-data/browser-repair-final-focused.log`。
- 独立 HTTP 探针：雪球沪深/港股与 Yahoo 美股/日经均得到有效报价。四个行情 Board 并发读取，美股/亚洲/全球资产为 live，A 股为 partial；不据此声称全部证券覆盖恢复。
- 标准 `npm run check` 在 Windows `cmd` 的命令长度限制处失败（syntax 脚本超过 8K）。在 Host 临时脚本中依次执行同一组命令后，语法与 Contract 类型检查通过，架构校验报告当前仓库多处越层依赖，未通过。未放宽校验或重构无关模块。
- 单独执行 Harmony 校验通过；最终全量 `node --test` 为 2151 项，2124 通过、27 失败，涉及其他测试文件及计时断言。包含播客测试中 schema 98/96 的旧预期；未改写迁移或放宽校验。全仓不能宣称通过。

## 运行验收

通过 Repository 维护入口暂缓排队任务和调度，等待在途任务结束后实测 X；随后由原启动器重载 Web/Worker 并恢复原调度与队列时间。运行记录保存在 Host 的 `.ai-data/browser-repair-live/`，不提交数据库、帖子正文或浏览器身份。

推荐与关注页各抓到 3 条，均为已登录、无错误、未到截止；两页各 2 条截断正文均完成展开，耗时分别约 47 秒、30 秒。首次安全重载恢复 29 个排队任务。随后收紧 Worker 领取循环并定位启动 SQL，进一步重载记录保存在 `.ai-data/browser-repair-yield-live/` 和 `.ai-data/browser-repair-sql-live/`。

SQL 修复后的 Worker 启动日志中，`youtube-retire` 为 3ms，`translation-demote` 为 1ms，维护步骤不再停住约一分半钟。最后一次安全 Worker 重载恢复 17 个暂缓任务，Web 保持运行，原调度恢复。

滚动恢复重试补充后的最终 Worker 重载等待正在生成的小时报完成，恢复 5 个暂缓任务及原有 50 项调度，健康接口为 200。记录位于 `.ai-data/browser-repair-final-live/`。页面行情接口实读：美股 65/65、A 股 247/248、亚洲 38/38、全球资产 32/32 有报价；A 股仍为 partial，亚洲该次读带 stale，不能写成所有证券都已实时更新。SQL 修复后连续看板任务 `failed=0`。

自动推荐流一轮正常完成，耗时约 87 秒，新增为 0，不能把该结果当作吞吐已恢复。最终补充滚动恢复重试后提交的固定同步任务因订阅尚未到期而返回 `skipped/not-due`，没有绕过间隔或修改准入规则。后续小时新增量和完整自动入库吞吐仍需观察；本轮真实 X 验收结论限定为推荐/关注页面抓取、正文展开，以及故障保留/翻页回归。

BrowserSkill 本机观测为 daemon/CLI 0.4.0、extension 0.4.1，协议 1.7/1.8 有 version skew。本轮未替换第三方二进制，不把版本差异直接当作全部故障的原因。
