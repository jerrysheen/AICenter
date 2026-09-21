# 统一 Detail Shell

阅读、灵感详情、问答 Session、任务详情不再各自发明页面语法，而是挂到同一套工作台式内容页。

## 决定

- 白色画布是默认。灰底只表示工具、输入、机器状态或 AI 结果。
- 公共语义：`detail-shell` / `detail-head` / `detail-status` / `detail-title` / `detail-meta` / `detail-body` / `detail-section` / `detail-surface` / `detail-actions`。
- 阅读页底部只留对象操作（存入灵感、引用、分析、重点），删除「返回上层」；分析是唯一稍强调动作。
- 问答进入 Session 后，顶栏变成「新提问」或会话标题，左上角返回记录列表；正文不再放「返回记录」和「新提问」灰卡。
- 灵感详情使用同一套 Head / Meta / Body / Action，「接着研究」不再独占整宽蓝按钮。
- 任务详情的标题和目标是普通正文 section；当前进展、执行记录、结果才进浅灰 Surface。

## 验证

静态页立刻生效。用浏览器走文章详情、新提问、灵感详情、任务详情，确认顶栏返回、内容白底、机器结果灰底、每页最多一个高强调动作。
