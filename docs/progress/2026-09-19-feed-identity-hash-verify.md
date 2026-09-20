# 信息源 hash 去重已落地

## 问题

信息源拉取后左滑删除，或以后清掉正文，同一作者同一段文字再出现时不该再进列表。

## 结论

已经做成了，不必再加一层 hash。

- Contract：`FeedIdentityFingerprint`，身份是 `provider + 作者 + 正文` 的 SHA-256。
- 表 `feed_identity_fingerprints`（V23）只存 hash、externalId 和时间，不跟 Capture / ContentItem 走。
- 左滑隐藏写 `UserItemState.isHidden`，同时给 fingerprint 打 `hiddenAt`。
- 手工清掉 `content_items` / `captures` 后 fingerprint 仍在；再拉取同一作者同一正文（即使换了 tweet id）会被 ingest 跳过。
- 刷新时 `excludeExternalIds` 也会带上 fingerprint 里记过的 id，减少重复抓。

## 验证

`npm test -- test/feed-identity.test.js test/domain-foundation.test.js test/contracts.test.js` 34 通过，含 `identity fingerprints survive content purge and keep hidden tweets out`。
