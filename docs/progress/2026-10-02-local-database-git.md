# 2026-10-02 SQLite 留本地与 Git 大文件修正

用户要求确认数据库内容，并明确允许数据库留本地、不启用 LFS。该决定替代此前“私有完整部署快照有意版本化 SQLite”的规则；Instance 的配置、导入工作簿、Knowledge 文件和附件继续按既有边界维护。

## 原因与数据归属

- 首次本地提交包含 133,361,664 字节的 SQLite 一致快照，超过 GitHub 100 MiB 单文件限制；本地 commit 可以成功，远端 push 会拒绝。
- 排查时运行数据库约 128 MiB，含 19,232 条 ContentItem / Capture、译文、标签，以及笔记、投资账本、AI 会话、设备授权、任务和事件。它是业务真源，不是可以直接删除的新闻缓存。
- 最大的三个表是 `outbox_events`（约 31 MiB）、`content_items`（约 29 MiB）和 `captures`（约 29 MiB）。数据库增长不只来自媒体全文，也来自帖子采集与事件持久化。
- Git 数据库二进制快照会持续增长；压缩或清理到阈值以下无法解决后续提交问题。本轮不删除业务内容、任务或 SSE 事件，不执行 VACUUM，不改变采集和定时任务。

## 处理

1. `.gitignore` 移除数据库白名单，并忽略 `data/` 下的 SQLite 数据库及其 WAL/SHM。自定义 Instance 目录仍按既有规则忽略。
2. 在忽略的 Host 目录用 SQLite 在线 backup 保存一致备份，并检查 `integrity_check = ok`。不复制、覆盖或重建运行中的数据库。
3. 仅用 `git rm --cached` 停止跟踪，保留本地数据库及后续写入。数据库仍由 Service / Repository 使用，Schema 和 migration 不变。
4. 确认远端 main 仍停在本次提交的父提交，仅修正本次唯一尚未发布的提交。不能只追加删除提交，否则待推送历史仍包含超限对象。不重写已发布历史，不强推、不启用 LFS、不清理 reflog。
5. 同步 README、内容与提交指引、架构和发布门槛。换机需要单独恢复数据库备份；Git 克隆只恢复代码、配置和已跟踪文件，不再保证恢复当前业务数据。

## 验证

- `npm.cmd run check`：syntax、Contract typecheck、architecture、Harmony 与 617/617 测试通过。
- 本地数据库存在、已不受跟踪，`git check-ignore` 命中忽略规则；一致备份通过完整性检查。
- 检查 `origin/main..HEAD` 的全部可达新增对象，无超过 100 MiB 的 blob；不是只检查最终文件树。
- 修正前后的差异仅包含忽略规则、数据库 Git 删除条目和上述政策文档，原先代码、配置、工作簿与二进制改动保留。
- 仅本地修正，不执行 push。旧远端历史中已有的数据库版本保持原样；后续增长只发生在本地数据库。临时查看脚本保留且未提交。

诊断、备份、旧提交号和对象大小验收记录保存在忽略的 `.ai-data/commit-audit/`，不进入 Git。
