# 2026-09-19 Feed 信息筛选层（Shadow）

## 目标

Source Snapshot 之后先 Filter，再决定是否建 ContentItem。垃圾内容默认仍入库，只写影子结果，方便对照 X / B 站有没有误杀。

## 决定

- 流程：Snapshot → 确定性 Filter → Jev 语义 Filter → KEEP 建 ContentItem；enforce 时 IGNORE 只留 `status=ignored` Capture。
- 默认 `AI_CENTER_FEED_FILTER=shadow`，不默认 enforce。
- 与 `AI_CENTER_JEV_DISABLED` 独立：关掉 Agent Quality 不自动关掉 Feed Filter。
- 只复用 `typesafe-system-one.js` 的 evaluate Port；业务规则只在 `packages/domain/src/feed-filter.js`。
- Jev 只判断是不是一条真正的信息，不做兴趣 / 投资 / 重要性。
- Fail Open：timeout、缺 Key、坏 JSON、缺分一律 KEEP。
- 不用字数阈值；短事实（如 `NVDA +5%`）必须留。

## 改动

- `packages/domain/src/feed-filter.js`
- `packages/domain/src/feed-service.js`（ingest 改为 async）
- `packages/domain/src/index.js`
- `packages/database/src/repositories/feed-repository.js`（只读 `getCaptureByContentHash`）
- `apps/web/src/server.js`、`apps/worker/src/worker.js`
- `.env.example`、`docs/architecture-modules-v1.md`、`docs/contracts-v1.md`
- `test/feed-filter.test.js`

## 验证

- `npm test -- test/feed-filter.test.js test/domain-services.test.js test/domain-foundation.test.js test/typesafe-system-one.test.js test/agent-quality.test.js` 48 通过。
- 本机 `scripts/probe-feed-filter.mjs` 已用真实 TypeSafe Key 打过 Jev（`jev-1.13.0`，约 300ms/条）。
- 对照：`查看更多...` Jev IGNORE；纯 emoji 走确定性 `no-body`；`三星 NAND 报价上调 10%` / `NVDA +5%` KEEP。
- `Great!` 被 KEEP（information 0.68 / residue 0.91 / worth 0.10）——三条高置信门槛没齐，符合 Fail Open。
- 真实 X / B站样例全部 KEEP；一条健身广告 residue 0.76 但仍 KEEP。
- 默认 shadow：刷新后垃圾仍可见，Capture.metadata 带 `wouldKeep` / `wouldIgnore`。
- 人工确认后再开 `AI_CENTER_FEED_FILTER=enforce`。
