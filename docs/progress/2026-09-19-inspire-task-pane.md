# 灵感下独立任务窗

## 目标

工作包不再混进随记。灵感下面单独开「任务」窗口；Cursor 做完后把状态和结果写回任务卡。

## 决定

- 路由 `#inspire` 是随记，`#inspire/tasks` 是任务。
- `listInspirations` 不返回 `sourceType=work-package` 的笔记。
- 不恢复终端轮询。本机 Cursor 只在用户说「有任务了」后主动领取。

## 验证

- `test/work-package.test.js` 确认随记列表不含工作包笔记
- 页面：灵感下 `随记 | 任务`，任务卡显示待领取 / 实现中 / 已完成与结果
