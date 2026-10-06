# 2026-10-03 新闻公开页面与浏览器正文试验

## 目标与决定

用户明确要求优先尝试已有web/browser与其他取文方式，媒体API作为最后选择。
本轮使用现有HTTP Connector、正文提取器和BrowserRuntime/BrowserSkill做真实只读样本验证。
BrowserSkill已连接一台Chrome；只调用会话、导航和DOM读取，没有Computer Use、桌面鼠标/键盘模拟、
Cookie导出、自动登录、订阅购买、挑战解答或关闭TLS验证。媒体API没有申请或调用。

前一轮主要核查RSS和官方API，不能据此得出“新闻正文必须先买API”。本轮纠正此技术结论。
验证公开页面可读性与内容服务使用许可是不同事项；下述可读样本不代表整个出版商或所有用途已验收。

## 实际结果

以下字符数为本轮提取器或可见DOM测量值，不表示翻译已落库。样本HTML、DOM、诊断脚本属于
忽略的Host audit目录；只提交方法、公开URL和结果摘要，不提交完整版权正文。

| 媒体 | 直接HTTP | 本机浏览器 | 本轮结论 |
|---|---|---|---|
| BBC | Business样本3335字符/20块；World样本5056字符/30块，均200 | Business样本可读，首末段与HTTP哈希一致 | 公开文章技术上可直接HTTP取文，不必以正文API为前置 |
| Guardian | 经济样本1491字符/8块；World feed发现的样本3825字符/22块，均200 | 经济样本可读；main包含额外标题/页面组件 | 公开文章HTTP可取文，API不是技术前置；长期保存/翻译用途仍不能从可读性推断 |
| AP | 未纳入本轮直接HTTP质量验收 | World页发现文章后，正文6149字符/28块；具体正文容器RichTextStoryBody | 已有BrowserRuntime可读真实长文；Business入口遇Cloudflare拒绝后停止，不能宣称全板块稳定 |
| POLITICO | 最新Defense RSS正常；文章HTTP403 | 等待动态渲染后，1625字符增长至6123字符/23块，读到正常末段 | 浏览器是有效候选；非免费元数据与实际可见正文并存，需保留访问/完整性证据，不能仅按HTTP403永久判无正文 |
| Reuters | 原站TLS链校验失败 | 原站ERR_CERT_AUTHORITY_INVALID | 原站本轮不可达；另有署名Reuters的Yahoo公开转载样本200，可提取1416字符/7块，须区分原出版商与读取入口 |
| FT | 文章403 | 正常打开到Subscribe to read订阅页 | 没拿到正文；961字符为套餐文字，不能当新闻全文 |
| Economist | 文章403 | JS渲染后显示免费试用/登录引导、非免费元数据 | 没拿到完整正文；main的1137字符含导航/试用组件，不能当全文 |
| Bloomberg | 文章403 | 非免费元数据，正文区域仅约586字符/3块 | 保留预览状态，未确认全文；不提取付费墙背后的隐藏数据 |
| WSJ | 原站TLS链校验失败 | ERR_CERT_AUTHORITY_INVALID | 本机链路问题，尚未读取文章；不能据此认定网站只支持API |

另外试了TinyFish读取AP文章、Reuters World和Economist文章，分别timeout、401、403；
本轮没有新增可用正文。没有把远端提取失败写成“本机浏览器也失败”，也没有持续重试挑战入口。

## 样本与正文边界

- BBC：[经济样本](https://www.bbc.co.uk/news/articles/cq0ld88kzxw8o)、[World样本](https://www.bbc.co.uk/news/articles/ck87zg8jnwngo)。
- Guardian：[经济样本](https://www.theguardian.com/business/2026/oct/02/doj-fed-chair-jerome-powell-investigation)、[World feed发现样本](https://www.theguardian.com/global-development/2026/oct/02/row-erupts-over-cairo-mural-depicting-tutankhamun-and-nefertiti-with-dark-skin)。第二篇属于文化相关国际发展题材，不能代表经济新闻筛选已做好。
- AP：[World文章](https://apnews.com/article/israel-saudi-flight-copilot-flydubai-repatriation-93d54fd230acb35d7112f47bba203459)。
- POLITICO：[Defense文章](https://www.politico.com/news/2026/10/02/pentagon-hegseth-musk-palmer-commission-01104908)。
- Reuters署名转载：[Yahoo阅读入口](https://finance.yahoo.com/economy/policy/articles/mexico-says-fourth-round-us-012845076.html)。另一个Investing公开转载样本HTTP403后停止。

AP最初以main读取7329字符/33块，其中混入视频和图片说明。观察实际DOM后改用
`div.RichTextStoryBody.RichTextBody`，取得6149字符/28块，正常新闻开头至记者归因末段均在。
这说明“页面可见文本很长”不能代替正确的正文定位。

POLITICO首次DOMContentLoaded后只返回几段；等待动态内容后正文增加。末段为正常报道结尾，
没有把Newsletter表单内容合并进正文。AP与POLITICO均只读取当前页面可见DOM，未从隐藏JSON恢复正文。

本轮临时通用fragment提取会把FT订阅套餐、Economist试用页或Bloomberg预览误判为full；
这些诊断标签已由页面证据纠正，未写入业务库。生产浏览器接入前必须把此类反例加入确定性测试，
保留付费/挑战/渲染未完成状态，不能把fragment的full标签直接落库。

## 后续接入优先级与工程边界

按用户要求确定方法顺序，尚未宣称生产已完成接入：

1. RSS/公开板块页发现索引，公开文章页HTTP读取；保留出版商专用正文定位、原URL、作者与日期。
2. 对正常浏览器可读、依赖JS渲染的文章，通过现有BrowserRuntime读取可见正文。等待正文变化稳定，
   去除导航/图片说明/推荐/订阅组件，保留首尾段、字节上限、失败状态。挑战和付费页不无限回退。
3. 对署名明确的公开转载，必须登记读取入口及原出版商，去重并记录provenance，不能伪称Reuters原站抓取。
4. 前述方法仍不能满足需要时，才考虑用户已有API或另行申请内容服务；不要求先采购九家的API。

长时间导航/采集继续在Worker，不从Web请求直接启动；BrowserRuntime负责Instance浏览器绑定，
媒体Connector不读取Profile或Cookie。若生产接入浏览器读取，需先同步稳定设计和向后兼容Contract，
复用已注册handler、Service/Repository、每日预算与冷却，再做真实Worker验收；不另建Runtime或数据库。

本轮没有修改生产来源启用、预算、Contract或采集策略，没有写业务文章、译文和标签。
主机TLS链错误没有通过ignoreHTTPS、`NODE_TLS_REJECT_UNAUTHORIZED=0`或跳过浏览器证书页处理。
诊断创建的浏览器会话和标签页按会话所有权清理，不触碰用户原有标签页。

## 追加：未取得正文媒体的替代入口搜索

继续按用户“搜索下没抓到的几个，有什么替代方案”要求，搜索出版商官方说明和署名转载，
并用现有HTTP Connector、BrowserRuntime对候选入口做只读验证。没有启用新生产来源或写业务文章。

| 媒体 | 替代入口与本轮证据 | 范围和用户操作 |
|---|---|---|
| Bloomberg | 两篇Yahoo署名转载HTTP200；普通浏览器打开后可用Story Continues按钮展开，文章可见段落范围分别从2595字符/14块增长到4040字符/25块、从2557字符/15块增长到7880字符/42块，均显示Bloomberg版权末尾 | 两篇样本未要求登录或API；这些字符数包含Most Read推荐项，不能当净正文或整家媒体覆盖率。需要转载专用正文清洗和逐篇完整性检查 |
| Reuters | 前轮Yahoo署名转载HTTP200、1416字符/7块；继续作为原站之外的公开阅读入口候选 | 未要求登录或API；原出版商标为Reuters，读取入口标为Yahoo，不能宣称原站已恢复。原站证书链问题仍需单独排查 |
| FT | Alphaville官网RSS HTTP200、25条文章索引；官方Substack feed HTTP200、20期、包含content:encoded | 官网Alphaville是免费注册阅读，用户在绑定浏览器注册/登录免费FT账户即可验证；官网RSS本身不含全文。Substack是每周汇编，不能替代FT全站或每篇原文 |
| Economist | 官方集团网站明确支持订阅者向非订阅者赠送文章；普通已有订阅的网页登录也是后续验证入口 | 官方赠文适合指定少量文章；本轮未验证赠文链接、额度或有效期。没有找到并验收稳定的免费批量全文入口，API继续排在最后 |
| WSJ | Yahoo主题页搜索结果中存在WSJ署名条目，但web读取入口429后停止 | 未取得可验收的转载正文。原站是TLS链失败，不能当成必须采购API的证据；先恢复正常证书访问，再验证用户已有普通订阅的浏览器可见内容 |

Bloomberg样本：

- [Treasuries Rebound Raises Stakes for Job Data as Rate Hikes Loom](https://finance.yahoo.com/economy/policy/articles/treasuries-rebound-raises-stakes-job-000433339.html)。
- [Rising Yields Are Wreaking Havoc on Stocks Outside the AI Trade](https://finance.yahoo.com/markets/stocks/articles/rising-yields-wreaking-havoc-stocks-203032620.html)。

两篇初始HTTP通用提取分别返回2661/2622字符，均为partial、coverage_unverified。
浏览器的续读按钮为公开的`button.readmore-button`，显示Story Continues；点击后按钮消失，
后续报道段落和版权结尾进入可见DOM。只按首个bodyItems-wrapper取文仍会漏掉展开部分，
不能依靠“按钮点过了”或当前通用提取器标签直接宣布全文入库。接入时需覆盖展开后的全部报道区域，
排除Most Read链接、作者简介及版权组件，并保存原出版商与读取入口。

FT一手说明：

- [How to read FT Alphaville for free](https://www.ft.com/content/b6cdf8d1-7435-460b-9a68-df456a143ce5)：本轮页面明确显示免费和注册入口。
- [FT Alphaville官方Substack说明](https://ftav.substack.com/about)：明确免费邮箱注册方式；原创报道仍发布在FT博客，周五newsletter汇编本周工作。
- [官网RSS](https://www.ft.com/alphaville?format=rss)、[官方周报RSS](https://ftav.substack.com/feed)：本轮均真实HTTP200，不借助内容API。
- [The Economist Group官方产品说明](https://www.economistgroup.com/businesses/the-economist)：确认订阅者可向非订阅者赠文；不引用第三方旧额度。

经济、债券、利率、汇率与市场分析可优先验证FT Alphaville、Bloomberg/Reuters署名转载；
国际局势、贸易、能源与地缘政治继续由此前已验证的BBC、Guardian、AP及POLITICO样本路线补齐。
这是一组可实现候选，尚未完成生产转载发现、正文清洗、去重与Worker接入验收。

## 验证

- 完成九家方法核查，BBC/Guardian各两个HTTP样本、AP可见正文、POLITICO动态正文及Reuters署名转载入口。
- 比较BBC HTTP/DOM首末段哈希，AP专用正文首尾，POLITICO动态加载前后范围。
- 核实Reuters/WSJ HTTP错误为`UNABLE_TO_VERIFY_LEAF_SIGNATURE`，浏览器也报证书链错误。
- 文档和Host诊断变更，无生产代码变更；不把此前全仓测试结果作为这次浏览器集成上线的证明。
