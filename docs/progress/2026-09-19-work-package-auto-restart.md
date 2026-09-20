# 任务完成后自动弹进程，远端可手动点重启

## 目标

远端投任务后，静态页立刻生效；改了服务端代码要自动弹 Web/Worker，且公网隧道不关。不能再开一个只做重启的公网端口。

## 决定

- CLI 只如实报 `changedPaths`，不杀进程、不跑 restart 脚本。
- `apps/web/public`、文档、测试 = 热更新，不弹进程。
- `apps/web/src`、`apps/worker`、`packages` = CLI 退出后写 `runtime/restart.request`。
- 启动器看到请求或 Web/Worker 自己退出，只弹这两个进程，cloudflared 保持。
- 已配对手机走现有 8787：`POST /api/v1/runtime/restart`。设置页有按钮。
- 公网 Hostname 仍只映射 Web 端口。

## 验证

- `test/work-package.test.js`：complete 不立刻写请求；dispatch 在 CLI 退出后才写；配对设备可手动请求
- `test/launcher-boundary.test.js`：崩溃与请求都弹进程且不杀隧道
