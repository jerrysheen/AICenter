# 2026-10-19 收紧 X 自动点赞

jev 关闭后，关注流整段放行，推荐流只要 xFocus ≥ 0.7 或命中关键词且不含广告词也会放行。点赞仍按 0.75 选条，每小时能选出 5–9 条，抽查大约一半是广告、官号宣传、一句话或偏敏感内容。这次只收紧点赞选条和失败停用，不改关注流的信息流准入，也不加「只记录不点赞」。

## 决定

- 所有来源，包括关注流，正文里有广告或推广词就不再点赞。自动点赞额外把承接、招募、代投、折扣、打折、优惠码算作推广。推广链接和返佣原来就有，信息流入库仍只用原来的词表。这样「招募说明书」「折价发行」继续入库。关注流仍然整段放行。「广告收入」这类经营事实仍然不算推销。
- 正文去掉链接后，字母和数字合计少于 40 个就不点。用来挡住一句话闲聊和只有图片的帖。
- 企业动态继续可以点赞，但主方向是企业动态时至少 0.9。完全停掉会丢掉高分财报、订单和监管。方向问题改成只认财报、订单、收购、人事和监管，产品宣传、折扣和官号广告不算。
- 品牌或公司官号不点赞。用户名或显示名里出现 Official 或「官方」就跳过。Global 只在两种情况下跳过：它是用户名的独立后缀（`_Global`、`-Global`，或 `BinanceGlobal` 这种大写分词结尾），并且同时有品牌证据（认证为机构，或打分给出 `promotional=true`）；或者认证类型本身就是机构、企业、政府。显示名里只有 Global，例如「Global Macro Guy」，以及 `macroglobal` 这种个人用户名，继续可以点赞。打分提示词增加 `promotional`：广告、推销和官号产品宣传为 true 时不点赞。当前 X 采集只保存作者 id、用户名、显示名、简介和粉丝数，metadata 里没有 `verified`，也没有 `verifiedType`。`ORGANIZATION_VERIFIED` 读得到 `authorVerified`、`authorProfile.verified` 或 `authorProfile.verifiedType`，但现有抓取不会写入这些字段，所以机构认证这条在真实数据上还不会生效。布尔值 `verified` 即使以后写进来，也不会被当成机构。
- 敏感判断写明加密货币争议人物的采访、动态、站队或带货，例如孙宇晨，不只看喊单和人身攻击。
- 没有分类客户端时，点赞分数门槛提高到 0.9。`AI_CENTER_JEV_ENABLED=false`（以及 `0`、`off`）且 provider 仍是 TypeSafe 时如此。`AI_CENTER_CLASSIFICATION_PROVIDER=bamboo` 按有分类客户端处理，其他方向仍是 0.75。
- `filterDecision` 为 KEEP 还不够。`filterReason` 以 `fallback-` 或 `jev-disabled-` 开头的是本地兜底，不点赞。Bamboo 失败、达到每日或每小时上限、用量文件异常时都走这个前缀，不会因为兜底 KEEP 被点赞。切到 Bamboo 之后，只点 Bamboo 自己给出的 KEEP。
- 默认上限改为每天 8 次、每小时 2 次、间隔 15 分钟。`AI_CENTER_X_AUTO_LIKE_DAILY`、`AI_CENTER_X_AUTO_LIKE_HOURLY`、`AI_CENTER_X_AUTO_LIKE_INTERVAL_MS` 仍可覆盖。
- 点赞任务直接失败也计入自动停，包括任务抛错、运行超时和进程中断后的租约过期。连续 2 次就关掉页面开关，通知里写上最近一次原因。成功点赞会把这串计数清零。已经记下的失败不会在重新打开开关后再次计数。
- 配置版本改为 `x-focus-2`。自动点赞只认这个版本，已经按 `x-focus-1` 打分的帖不会被点赞。关注方向趋势图同时接受 `driftCompatibleVersions` 里的 `x-focus-1`，版本切换后旧点仍留在图上。新抓取按新提示词打分。最近 6 小时里仍是关键词分的帖，下一轮会补打。
- 「推荐记录」里本来就有相关度、方向和一句理由，这次不改页面。

## 改动

`config/x-focus.json`、`packages/domain/src/x-focus.js`、`packages/domain/src/x-auto-like.js`、`packages/domain/src/x-focus-score.js`、`packages/domain/src/feed-ad.js`、`packages/domain/src/feed-filter.js`、`packages/runtime/src/feed-interaction-module.js`。选条读捕获里的原文、作者名和认证。不新增 migration。

## 验证

`node --test`。广告词、官号、短帖不选；「Global Macro Guy」和 `macroglobal` 仍会入选，「XXX Official」「XX官方」和认证为 business 的账号不选；企业动态 0.85 不选、半导体 0.8 选；jev 关闭时 0.85 不选、0.9 选；连续 2 次任务失败自动停。切到 `x-focus-2` 后趋势图保留 `x-focus-1` 的点，自动点赞忽略旧分数。承接、招募、代投、折扣、打折、优惠码只挡自动点赞，「招募说明书」「折价发行」仍按原词表入库。

## 部署

不需要 `npm ci`，不要重建数据库。需要同时重启 Web 和 Worker。确认要自动点赞时，再把 `AI_CENTER_X_AUTO_LIKE=1` 写入环境，并在「推荐记录」打开开关。服务器仍须设置 `AI_CENTER_HARNESS_HOURLY_PROVIDER=google`。
