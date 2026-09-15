# 第二阶段工作计划

状态：布局已按 `product-v2.md` 调整。Yahoo 美股/亚洲行情已接入股票页。同花顺 A 股、持仓核算和抓取仍未开始。

## 工作包

| 包 | 范围 | 当前状态 |
|---|---|---|
| A 前端与快速验证 | `apps/web/public/`、契约草案、交互 | A0 布局已完成；A1 起未开工 |
| B 后端、Worker、鸿蒙 | 迁移、任务、Adapter、SSE 补发、薄壳 | 架构骨架完成，等待真机验证 |
| 共享 | `packages/contracts/` 冻结后再实现 | 仅有草案 `docs/plan/contracts-draft.md` |

## 前端任务顺序

等命令后按此执行，不要提前打穿旧仓库。

1. **A1 现有接口接入（信息/灵感/知识）**
   把 `posts` 映射为 `FeedItem(platform=manual)`；「全部」不再混入无订阅语义的 mock 故事。「关注」在没有订阅前为空。灵感/知识继续用现有 `notes` / `knowledge`，但页面按原文与 AI 结果分离展示。
2. **A2 股票层**
   统一 `Instrument` / `QuoteSnapshot` 字段。前端可先用契约形 mock 完成 A股/美股列表、搜索、加删自选；自选未落库前必须明确提示。
3. **A3 持仓与全球资产**
   复用行情列表；持仓总览六个数字；流水只在详情。
4. **A4 订阅 UI**
   管理关注、同步中/失败态。请求打到未来 `/api/v1/subscriptions*`，无接口时保持本地 mock。
5. **A5 问答/日报/行为事件**
   问答占位补来源字段；日报保持结构；行为事件扩共享契约后再打点。

## 后端任务顺序（包 B）

P0-A：迁移机制、默认 workspace、领域表、任务/事件运行时已完成；共享业务契约仍等前端冻结。
P0-B：B站关注 -> 全部/关注 真实闭环，再接 X。
P0-C：Yahoo 美股/亚洲观察池已接入。同花顺 Adapter、手工持仓与价格刷新待做。
P0-D：灵感 AI 改为任务，知识全文检索。

## 旧仓库只作 Adapter 参考

不复制页面，不迁脚本。业务代码不写死机器路径，用环境变量或配置。

### 信息：`F:/AI/skills`

| 能力 | 参考 | 第一轮用法 |
|---|---|---|
| 列出 UP 视频 | `list-bilibili-up-videos` | 关注账号同步的入口：得到 `bvid` 列表 |
| 单视频字幕 JSON | `pull-bilibiliInfo` | 异步加工，不阻塞信息流入库 |
| X 用户时间线 JSON | `pull-Twitter` | 先公开 RSS/结构化出口，登录态 enrichment 后置 |
| 知识入库与检索 | `knowledge-base-io`（本机 `127.0.0.1:8777`） | P0-D 后再接混合检索 |

B站建议拆成两段任务：`list` 快速生成 `ContentItem`；`transcript` 完成后更新卡片。登录 Cookie 留在采集用浏览器，连接器页只显示「已登录/可抓取」。**用户执行登录；Agent 不接管桌面。**

### 交易：`F:/Fintech/AI-Hub`

| 能力 | 参考 | 第一轮用法 |
|---|---|---|
| A股行情、搜索、指数、错误分类 | `apps/web/lib/hithink.ts` 与测试 | 本机 HTTP Adapter，映射为 `QuoteSnapshot` |
| 美股/亚洲行情原型 | `apps/web/lib/yahoo.ts`、`us-market.ts`、`asia-market.ts` | 同上；页面不依赖 Yahoo/同花顺原始字段 |
| 自选与告警 | finance 模块 README | 可参考分组，但旧库 **没有** 持仓账户、流水和收益核算 |
| 模块边界 | `docs/architecture.md`：finance / records / ingestion 分离 | 与本仓三域拆分一致，页面不复用 |

全球资产与期货供应商（含 Massive）只做评估，不写死。

## 现有 AI Center 接口（A1 可接）

- `GET/POST /api/v1/posts`、`GET /api/v1/posts/:id`
- `GET/POST /api/v1/notes`、`POST /api/v1/notes/:id/archive`
- `GET /api/v1/knowledge`
- 会话、配对、设备、行为、SSE `post.created`

尚不存在：feed、subscriptions、quotes、watchlists、portfolios、knowledge/search、inspirations/process。

## 停止线

真实数据接入前继续遵守：

- 调用 B站/X Skill 或旧 AI-Hub HTTP
- 把 mock 行情当成已落库自选
- 扩大推荐/热门或把账户加回底栏
