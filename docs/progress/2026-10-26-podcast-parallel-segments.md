# 2026-10-26 播客并行分段整理

新开的 YouTube / X 长视频整理改为：按现有 `longVideoPartBounds` 切段，Gemma 26B 并行写出译文、3～5 条 hint 和 topic，默认并发 `min(8, 密钥数×每钥在途数)`，未数到密钥时是 8。段失败会再试那些段，已经成功的段留下。全部段成功后，`gemini-3.1-flash-lite` 用 hint 加每段最多 1800 字摘录写一次整集脉络；输入太长才再拆。Flash 额度紧或失败时，这一步改由 Gemma 26B。合并时按 `partIds` 接回全文译文。不要求对话体。

已经 `ready` 的稿，包括 `chapter-dialogue`，不自动重写。进行中的旧要点稿仍按原来的小节写完。显式重跑 `scripts/rerun-youtube-chapter-articles.mjs` 只在带 `--video` 或 `--all` 时把已整理的集排回队列，新跑走这条并行路径。不新增 migration。只需要重启 Worker。
