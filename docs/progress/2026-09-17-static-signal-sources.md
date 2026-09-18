# 静态信号官方来源接入

## 目标

把中美宏观日程、央行日程与官方政策发布接入现有 SourceHub，同时冻结“只记录公开事实、不解释意味着什么”的边界。

## 决定

- 新增 `calendar` 与 `policy` Source category，以及 `calendar` / `official-release` view kind。
- 统一输出 `ScheduledEvent` 与 `OfficialRelease`，不保存 importance、forecast、consensus、surprise、impact 或多空判断。
- 官网逐项列出的日程使用 `official-calendar`；按官网固定规则生成的 ISM、Initial Claims、LPR 使用 `official-rule + tentative`。
- 继续使用 SourceSnapshot 的只读 TTL 缓存；本轮不增加数据库 migration，不把日程或政策文件塞进 Feed 表。
- 只使用普通 HTTP、ICS、RSS 与公开 JSON API，不使用 BrowserSkill。

## 改动

- 首批注册 15 个 Source：BLS、BEA、Census、ISM、DOL Initial Claims、NBS、GACC、Fed Calendar、FOMC、LPR、Federal Register、White House、Fed RSS、国务院政策文件库、PBOC。
- 增加官方源 Connector、确定性解析器、运行时 Contract 与失败降级。
- 总览页增加静态信号源目录和通用详情 Renderer；页面按 `viewKind` 渲染，不按供应商字段分支。
- 增加 ICS、HTML、JSON、规则日程、Source API 与失败降级测试。

## 验证

- 固定 fixture 覆盖 BLS、BEA、Census、NBS、Federal Register、White House、gov.cn 与 PBOC。
- 本机实时冒烟已读取 BEA、Census、NBS、Fed Calendar、FOMC、Federal Register、White House、Fed RSS、gov.cn 与 PBOC。
- GACC 在当前主机因证书链验证失败会按设计降级为 unavailable，不绕过 TLS 校验。

## 遗留

- 逐源进行更长周期的真实网络验收，尤其是官网结构改版与节假日例外。
- 当前 SourceSnapshot 不持久化；只有未来日报确需保存历史快照时才设计新 migration。
- 企业事件、市场预期、Tokenized/Crypto-native 报价与预测市场仍不在本轮范围。
