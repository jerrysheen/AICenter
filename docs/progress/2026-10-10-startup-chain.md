# 2026-10-10 启动链去串行

总览按页加载之后，第一个数据请求仍要等完整的模块阶梯和第二次界面指纹。这一步只缩短启动往返，不改业务结果。

- `ui-boot.js` 在送出 HTML 时内联。解析脚本的同步部分同时发出 `/api/v1/session` 和 `/api/v1/ui/revision`，不再为这个 3KB 文件单独走一趟，也不再挡住 CSS 和模块。
- `maybeReloadStaleShell` 复用 `window.aiCenterUiBoot`。指纹一致时不再发第二次 `/ui/revision`。部署过程中指纹不一致，仍走原来的稳定后重载；之后的 SSE `ready` 也还在。
- `/session` 与指纹检查并行。刚配对成功的这一次会丢掉提前发出的未授权结果，再读一次新会话。
- `app.js` 顶上的四段 `await import()` 改成静态 `import`，和 `mock`、`icons`、`markdown`、`quant-lab`、`media-feed` 一起由浏览器并行拉取。`index.html` 用 `<link rel="modulepreload">` 让这些模块和 `app.js` 同一轮开始。
- `information-tree.js` 的图标引用改成 `./icons.js?v=dev`，由静态文件改写和 `app.js` 共用同一个 `?v=`，只下载一次。

新闻筛选、JEV、翻译、小时报/日报和接口契约没有改。没有新依赖，也没有构建步骤。

本机空库对照（Playwright，相对导航开始，请求重叠不超过 2ms 算同一轮）：

| | 首个数据请求 | `/session` 开始 | `/ui/revision` | `icons.js` | 数据请求前的串行轮次 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 改前 | 108ms | 90ms | 2 次（14ms、88ms） | 2 次，其中一次无 `?v=` | 8 |
| 改后 | 89ms | 14ms | 1 次（15ms） | 1 次，带 `?v=` | 3 |

改后的三轮是：HTML；模块、样式、`/session`、唯一一次 `/ui/revision` 并行；然后才是业务数据。`/session` 落在模块下载这一轮里，不再等模块阶梯结束。本机每次请求只有 1–3ms，所以墙钟只少了约 20ms；公网每轮大约 220–350ms，少掉的 5 轮大约是 1.1–1.8s。直接打开 `#inspire`、`#knowledge`、`#source/bilibili`、`#report/history` 以及从总览切到 `#report`、`#feed` 仍会读各自的数据。
