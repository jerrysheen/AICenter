# 信息架构布局与第二阶段计划

## 目标

先把五栏信息架构改到第二阶段结构，并写下整体计划。不接入新 API，不调用旧仓库抓取或行情。

## 决定

- 底栏：信息、交易、工具、问答、日报。账户进入右上角设置。
- 信息：全部、关注；平台筛选为全部来源 / B站 / X / 手工。去掉推荐和热门。
- 交易：股票、全球资产、持仓。股票与持仓分 A股/美股。全球资产改用同一行情列表。流水进入持仓详情。
- 问答增加「包含最近信息流」开关，默认关闭。日报先放六个结构块。
- 旧 `F:\AI` skills 与 `F:\Fintech\AI-Hub` 行情适配只写入计划文档，本轮不调用。

## 改动

- `apps/web/public/index.html`、`app.js`、`mock.js`、`styles.css`
- `docs/product-v2.md`、`docs/architecture.md`、`docs/README.md`
- `docs/plan/stage-2.md`、`docs/plan/contracts-draft.md`

## 验证

- 语法检查通过。
- 浏览器走五栏、设置、信息筛选、交易三栏、持仓详情流水、问答开关、日报结构。
- 手工发布和灵感仍走现有接口，未新增服务端路由。

## 后续

等待命令后再做 `docs/plan/stage-2.md` 中的 A1。
