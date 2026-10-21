# SQLITE_BUSY 不按重复数据库错误退出

## 原因

`SQLITE_BUSY` 和 `database is locked` 是正常的锁竞争。10 分钟内出现 3 次就 `exit(1)`，启动器会把 Worker 反复拉起。

## 决定

这两种只计入 10 分钟内的总次数。超过 20 次仍 `exit(1)`。`SQLITE_BUSY_TIMEOUT` 这类同一族的锁代码同样只计入总次数。其它 `SQLITE_` 错误仍是同一种出现 3 次就退出。

不新增 migration。当前 schema 仍是 95。下一号是 96。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。
