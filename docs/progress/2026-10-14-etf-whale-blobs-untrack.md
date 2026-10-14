# ETF 鲸鱼原始响应不再进入 Git

日期：2026-10-14

## 线上

`etf.whale.sync` 把上交所 JSON、深交所 XLSX、腾讯前复权日线和参考站样本写到 `data/blobs/etf-whale/`。这些文件仍被 Git 跟踪，同步一写工作区就脏。自动部署看到 `git status --porcelain` 有输出就放弃，也不会自动还原。

## 决定

停止跟踪 `data/blobs/etf-whale/`，并把它写进 `.gitignore`。其余 `data/blobs/` 仍按原规则版本化。

页面 `/etf-whale`、重算和覆盖率只读 SQLite 的份额、行情和日结果。`readReport` 读的是已忽略的 `.ai-data/etf-whale-parity/`，目录不在时返回空。没有任何代码在检出时打开 `data/blobs/etf-whale/`。`writeBlob` 会 `mkdir` 再写入，所以缺目录时下一次真正发起的抓取仍能落盘。

库里的 `blob_path` 和 `content_hash` 只是相对路径和哈希，这次不改表，也不读回文件。增量同步对已是 `ok` 或 `empty` 的区间会跳过，不会把历史原始响应重新下载回来。

## 服务器

这次提交在索引里删除这些文件。快进会把工作区里对应的文件从磁盘删掉。删除不影响页面，只要 SQLite 还在。

自动部署的备份只有数据库、WAL、SHM 和 `.env`，不含这个目录。工作区现在是脏的，部署不会开始，所以要先手动做：

1. 把 `data/blobs/etf-whale/` 复制到仓库外。约 799 个文件、122MB。
2. `git restore --source=HEAD -- data/blobs/etf-whale`，让 `git status --porcelain` 为空。这一步会先回到上次提交里的副本，备份才是同步写过的那一份。
3. 等这次提交快进。快进会删掉工作区里的这些文件。
4. 需要留下原始响应时，把备份拷回 `data/blobs/etf-whale/`。拷回后的路径已被忽略，porcelain 保持为空。
5. 不需要原始响应就可以不拷回。页面仍读 SQLite。之后只有新抓到的区间会再写出文件。

不要在快进之前把备份拷回原路径，否则快进会再删一次。健康检查失败时部署会 `git reset --hard` 回到上一个提交，那会把旧的受跟踪副本写回这个路径，盖住已经拷回的备份。回滚之后要再拷一次。

## 重启

不新增 migration。不必为这项单独重启。这次差异不在 `apps/web/public/`，自动部署仍会重启 Web 和 Worker。不要重建数据库。
