# AI Center Worker

Worker 与 Web 使用同一个 SQLite 文件，但运行在独立进程中。

```powershell
npm run start:worker
```

开发监听使用 `npm run dev:worker`。

可以在本机调用 `POST /api/v1/runtime/healthcheck` 创建检查任务，再通过 `GET /api/v1/runtime` 或 `GET /api/v1/runtime/jobs` 查看结果。

新增 handler 时，在 `packages/connectors/src/index.js` 注册明确的任务类型。不得把任意命令、路径或 shell 字符串从 HTTP 请求直接传给 Worker。
