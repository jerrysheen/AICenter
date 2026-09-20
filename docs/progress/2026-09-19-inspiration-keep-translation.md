# 存入灵感保留当时看到的中文译文

## 目标

信息流卡片和阅读页已经显示 Gemini 中文译文，但「存入灵感」仍把英文原文写进灵感正文。

## 决定

- `inspirationBodyFromPost` 与页面展示同一份 `translationFor(post)?.text`；没有译文时仍用原文。
- 作者、handle、来源 URL / 标题和采集元数据保持原样，不把来源拼进正文。
- 已有灵感不覆盖；信息不流原文不改。客户端构造 body 即可，Contract 仍只存 `body`。

## 改动

- `apps/web/public/app.js`
- `docs/product-v2.md`
- `test/inspiration-keep-translation.test.js`

## 验证

`npm test -- test/inspiration-keep-translation.test.js`

## 遗留

已存成英文的旧灵感不回写。鸿蒙系统分享走分享正文，不经这条函数。
