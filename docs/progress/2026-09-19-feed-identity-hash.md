# 推文去重 hash

## 目标

抓到的推文只打算短期保留正文。删掉或过期后，同一作者同一段文字再次投递不该再出现；左滑删除也要在正文不在了之后继续生效。

## 决定

- 身份是 `provider + 作者 + 正文` 的 SHA-256，单独放在 `feed_identity_fingerprints`。
- 表只存 hash、externalId 和时间，不存推文正文，所以可以比 Capture / ContentItem 留得更久。
- 无正文时退回 `external:{id}`，避免图文空帖撞车。
- ingest 时已见过或已隐藏的 identity 直接跳过；隐藏仍写 `UserItemState.isHidden`，同时给 fingerprint 打 `hiddenAt`。
- 本轮不做 7 天正文清理，只把可持久的身份 ID 先立住。

## 改动

- Contract：`FeedIdentityFingerprint`
- Domain：`feed-identity.js`，ingest / hide 走 fingerprint
- Repository + V23：`feed_identity_fingerprints`，并从已有 Capture 回填

## 验证

`npm test -- test/feed-identity.test.js test/domain-foundation.test.js test/contracts.test.js test/runtime.test.js test/work-package.test.js`

## 遗留

正文按保留期清理还没做。fingerprint 暂不自动过期。
