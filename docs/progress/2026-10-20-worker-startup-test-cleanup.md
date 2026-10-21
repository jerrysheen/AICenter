# 启动测试先停 Worker 再删临时库

## 目标

Windows 上这条启动测试失败时，不要留下还在跑的 Worker，也不要让删目录的 EBUSY 盖住原来的断言。整套测试不能因为这条挂住。

## 决定

`test/worker-startup.test.js` 的 `worker start claims a job before translation maintenance` 在 `finally` 里直接 `rmSync` 临时目录。任务循环和调度都用 `setTimeout` 等下一轮，这个定时器是默认引用的。测试在断言之后才 `close()`。断言一抛，`finally` 就去删还开着的 `test.db`。Windows 上这是 `EBUSY: resource busy or locked`。JavaScript 里 `finally` 再抛错，会换掉 `try` 里的那个异常。调度循环没停，整套测试就一直不退出。

GitHub 上 #182 没有留下这次 Windows 日志，看不到被盖住的原文。对照断言：启动日志的先后在「ellipsis-lead」出来时已经能判断。`job.status === 'completed'` 会等健康检查结束。健康检查调用本机 `bsk status`，超时最多 15 秒。仓库里有 `externaltools/bsk.exe`，Windows 上这一笔当时仍可能是 `running`。日志顺序那几条不依赖 bsk 结束。所以如果有被盖住的断言，就是这一条状态，不是领取顺序。

收尾改成固定顺序：恢复控制台，停任务循环，停调度，`close()`，关数据库，最后删目录。`close()` 清掉补译 interval 和硬件价格 interval，并等这一轮维护结束，避免关掉之后又挂上定时器。重复调用 `close()` 直接返回。删目录用 `rmSync` 的 `maxRetries: 10`、`retryDelay: 100`。断言失败时仍然收尾，报错用原来的断言。这条测试超时 30 秒，收尾钩子超时 10 秒。浏览器健康检查改成测试里的立即返回，不再启动 bsk。

不新增 migration。当前 schema 仍是 93。下一号仍是 94。空号仍是 63、79、80、82。不要重建数据库。

需要重启 Worker。页面没有改，Web 不用为这项重启。
