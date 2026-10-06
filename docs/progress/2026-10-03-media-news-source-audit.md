# 2026-10-03 经济与国际新闻媒体核查

后续用户要求API作为最后选择，已真实测试HTTP、本机BrowserRuntime和其他读取方式；
优先方法及样本结果见[公开页面与浏览器正文试验](2026-10-03-media-public-page-browser-probe.md)。
下文API权限表是备用内容服务方案，不表示正文必须先开通API。

## 用户范围与当前结论

用户补充：此前媒体需求包含经济、国际局势新闻，主要核查已讨论的媒体及正文获取、板块范围。
本轮暂按 BBC、FT、Bloomberg、经济学人、WSJ、POLITICO、Reuters、AP、Guardian 九家核查。
官方政策发布已补齐的20篇全文不能算作这些新闻媒体已接入。

当前普通新闻媒体只有 BBC Business 和 FT Global Economy 在本地启用，且都是索引/摘要。
Bloomberg、经济学人、WSJ、POLITICO 尚未启用；Reuters、AP、Guardian 的 vendor_api 是目录占位，
不是已经实现并运行的正文客户端。仅把 enabled 改为 true 不能完成 API 接入。

## 真实 RSS 探测

2026-10-03 使用已有白名单 HTTP Connector 和 XML Parser 做只读探测，不请求文章正文、
不使用浏览器、不写用户数据库。每次限制8秒、单次尝试、2 MiB响应上限。
原始响应未保存，诊断脚本与结果仅在忽略的 Host audit 目录。

| 媒体/板块 | RSS入口 | HTTP/解析 | 返回索引条目 |
|---|---|---|---:|
| BBC Business | https://feeds.bbci.co.uk/news/business/rss.xml | 200/ready | 55 |
| BBC World | https://feeds.bbci.co.uk/news/world/rss.xml | 200/ready | 37 |
| FT Global Economy | https://www.ft.com/global-economy?format=rss | 200/ready | 25 |
| FT World | https://www.ft.com/world?format=rss | 200/ready | 25 |
| Bloomberg Economics | https://feeds.bloomberg.com/economics/news.rss | 200/ready | 20 |
| Bloomberg Politics | https://feeds.bloomberg.com/politics/news.rss | 200/ready | 20 |
| Economist Finance & Economics | https://www.economist.com/finance-and-economics/rss.xml | 200/ready | 300 |
| WSJ Markets | https://feeds.content.dowjones.io/public/rss/RSSMarketsMain | 200/ready | 61 |
| WSJ World | https://feeds.content.dowjones.io/public/rss/RSSWorldNews | 200/ready | 71 |
| Guardian Economics | https://www.theguardian.com/business/economics/rss | 200/ready | 20 |
| Guardian World | https://www.theguardian.com/world/rss | 200/ready | 45 |
| POLITICO现配置 | https://www.politico.com/rss/economy.xml | 403/blocked | 0 |
| POLITICO Economy替代入口 | https://rss.politico.com/economy.xml | 200/ready | 3 |

上述可解析RSS都没有 content:encoded 正文元素；数量仅指本次返回的目录，不代表当日新文、
完整历史或全文。POLITICO不能只以HTTP 200判断源已恢复：

- economy：最新条目为2026-09-06，不能作为及时经济新闻主入口。
- defense：30条，最新2026-10-02；energy：30条，最新2026-10-02。
- morningtrade：8条，最新2026-09-28。都是索引，没有正文元素。

## 建议覆盖范围与正文通道

下面是建议采集范围，不表示对应板块都已经配置、探测或获得正文权限。

| 媒体 | 建议板块/主题 | 正文通道与接入状态 |
|---|---|---|
| Reuters | World、Business、Markets；经济、贸易、能源、地缘政治 | Reuters Connect API/供稿；需有对应内容权限，当前未实现客户端 |
| AP | World、Business；战争外交、重大经济事件 | AP Media API：JSON索引→renditions.nitf.href→NITF正文；需API内容权限，当前未实现 |
| BBC | Business、World；中国/亚洲、欧洲、中东重点新闻 | 公开RSS为索引；Information Syndication API的body mixin返回content:encoded，需供稿关系/API Key |
| FT | Global Economy、World、Markets；贸易、能源、中国与欧洲 | 公开RSS为索引；Developer Programme有内容API，具体全文服务与权限待接入核验 |
| Bloomberg | Economics、Politics、Markets；央行、通胀、贸易与能源 | RSS为索引；正文走Media Distribution内容供稿，不能用行情Data License冒充新闻全文权限 |
| Economist | Finance & Economics、Business、International、China；美国、欧洲与中东分析 | Content API /v1/articles/{id}返回结构化body；需Pro伙伴/供稿访问，板块以/v1/sections授权结果为准 |
| WSJ | Economy、World、Markets；贸易、中国与能源 | RSS为索引；全文内容服务必须明确覆盖WSJ，不能把通用Dow Jones订阅视为全部WSJ正文权限 |
| POLITICO | 经济政策、贸易、国防/外交、能源政策；美欧政策 | 先修复并检查RSS时效；公开文章需另做正文/访问规则验证，Pro内容需要对应权限，目前未确认可稳定全文 |
| Guardian | Business/Economics、World；中国、欧洲、乌克兰、中东 | Open Platform可提供article text，需要API Key；当前vendor_api占位未实现 |

默认关注宏观增长、就业、通胀、央行/利率、财政、关税/贸易、战争/外交/制裁、能源与供应链。
企业新闻仅纳入有宏观、行业或供应链影响的内容；不默认纳入娱乐、体育、生活方式和地方琐事。
地区是筛选维度，不保证每家媒体都存在同名RSS板块。

## 实施边界与下一步顺序

1. 一个出版商覆盖多个板块，合并索引并按规范文章URL/来源ID去重；先明确多入口的Contract与兼容方式，
   不用重复出版商源和重复文章凑数量。保留现有sourceKey和已读/翻译缓存关联。
2. Guardian普通Developer Key可取原文，但不能直接满足本项目完整用途。继续阅读注册页当前链接的
   条款后，需要为全文翻译、AI处理与保存另行确认授权；撤回“申请免费Key即可优先上线”的建议。
3. Reuters/AP/BBC/Economist等按实际已取得的API权限接入；FT/WSJ/Bloomberg需核验具体内容服务。
   本轮没有申请账号、购买服务、使用用户登录凭据或调整授权状态。
4. 正文仍在Worker内通过Connector获取，归一化段落/标题/列表，校验全文或截断状态后再做完整翻译、标签。
   RSS摘要、付费预览、正文获取失败不能标为full。翻译格式延续现有文章阅读流程。
5. 当前普通媒体maxActiveSources=6、成功正文32篇/日、正文HTTP48次/日；新增媒体需要同步评估启用上限和
   新闻/科技/官方材料的正文份额，否则即使增加目录，新闻正文仍可能因预算排队。此次未改预算或运行配置。

## 官方依据

- [Guardian访问类型与限额](https://open-platform.theguardian.com/access/)
- [BBC供稿API：授权关系与body mixin](https://information-syndication.api.bbc.com/)
- [Economist访问条件](https://developer.economist.com/)、[文章结构](https://developer.economist.com/docs/v1/articles/id)、[授权板块](https://developer.economist.com/docs/v1/sections)
- [AP索引与NITF正文下载](https://developer.ap.org/ap-media-api/agent/Feeds_and_Linked_Content.htm)
- [Reuters Connect](https://reutersagency.com/content-delivery-platforms/reuters-connect/)
- [FT Developer Programme](https://developer.ft.com/portal)
- [Bloomberg Media Distribution](https://www.bloomberg.com/distribution)

## 验证范围

本轮只读RSS/文档核查并新增此报告，没有修改业务代码、启用新媒体或宣称正文上线。
POLITICO原入口失败后停止该入口请求；替代rss.politico.com仅请求公开RSS，未请求受限文章。
报告与诊断覆盖可用性和结构，不代表逐篇新闻质量验收。正文客户端需要后续真实凭据和确定性测试。

## 补充：用户需要开通什么权限

这是媒体内容服务的开通要求，不是向本地助手授予桌面控制权限。已验证的公开RSS读取不用账号。
以下涉及正文的各项均应向媒体说明实际用途：个人非商业阅读、定时取文、本地保存、中文翻译、
AI标签、由实际使用的第三方模型API处理、自己已配对设备查看；明确保存期限与允许的内容范围。
这是供申请时确认的用途清单，不表示某个基础订阅或Key已经覆盖这些用途。

| 媒体 | 应申请/确认 | 接入所需凭据 | 当前核实程度 |
|---|---|---|---|
| Guardian | 为本项目用途另行确认Open Platform许可 | 获批用途对应API Key | 普通Key可取原文；注册页链接条款与本项目用途存在冲突 |
| AP | Media API中text/story正文下载entitlement，所选国际/经济内容与生产访问模式 | AP Media API Key | 已确认x-api-key；AP Newsroom→Account→Media API→See My API Keys；有Key仍需正文计划 |
| BBC | Business/World文本供稿合同及相应feed、body权限 | Account Manager签发API Key与允许的feed名称 | 官方文档明确Key由供稿合同开通时提供 |
| Economist | Economist Pro伙伴/授权Syndication的Content API访问，以及所选板块 | client_id与client_secret | 官方文档明确；普通读者订阅不能据此视为伙伴API访问 |
| FT | 向开发者计划申请取文许可，明确需要正文、保存与翻译 | FT API Key及已获批服务说明 | 已找到官方申请页；注册开发者账号不自动产生API使用权 |
| Reuters | Reuters Connect文本内容与API权限，经济/国际范围和使用方式 | 官方API凭据及文档，字段待实际服务开通确认 | 已确认Connect API/内容服务；不从第三方样例推断当前客户认证字段 |
| Bloomberg | 新闻文本feed许可及用途确认 | 官方供稿凭据、接口文档、内容范围 | 官方Media Distribution提供新闻feed；具体认证格式待开通确认 |
| WSJ | 向Dow Jones确认明确包含WSJ正文的程序化内容许可 | 获批服务的凭据与接口文档 | 本轮未确认可自行注册的WSJ个人全文API，不应建议先购买普通会员 |
| POLITICO | 普通文章先验证；Pro正文需确认程序化获取、保存/翻译范围 | 若官方提供接口/供稿，使用其指定凭据 | 未发现可直接申请并验证的公开全文API；Pro订阅本身不足以证明可程序化接入 |

实际Key只配置在Host端本地秘密配置，不发到聊天、不写config/media.json、不提交Git。
本轮未新增这些媒体的环境变量或设置入口；当前vendor_api仍为占位，拿到权限后还需要Connector实现。

补充依据：

- [Guardian注册页](https://bonobo.capi.gutools.co.uk/register/developer)链接的[普通条款](https://www.theguardian.com/open-platform/terms-and-conditions)限制翻译、AI处理和长期缓存；具体本项目权限需另行确认。
- [AP Key获取步骤](https://developer.ap.org/ap-media-api/agent/GettingStarted.htm)、[API请求认证](https://api.ap.org/media/v/docs/Getting_Started_API.htm)、[生产/预览模式](https://api.ap.org/media/v/docs/Access_Modes.htm)。
- [Economist凭据交换](https://developer.economist.com/docs/v1/auth/login)。
- [FT Key申请](https://developer.ft.com/portal/docs-start-request-an-api-key)、[开发者条款](https://developer.ft.com/portal/legal)。
- [POLITICO Pro订阅咨询](https://www.politicopro.com/faqs/)、[Pro内容协议](https://www.politicopro.com/msa/)。
