# 2026-10-02 Desktop Layout v1

## 目标

只补 Web 桌面布局。`<1200px` 保持现有手机、平板与小窗口布局；不改业务、API、Contract、后端或导航数据。

## 实现

- 在 `apps/web/public/styles.css` 末尾集中追加一个 `@media (min-width: 1200px)` 区块，之前的规则原样保留。HTML 与 app.js 本轮没有修改；保留工作区已有改动。
- App Shell 使用 `220px + minmax(0, 1fr)` 网格，复用现有 side-nav 与 renderNav 输出。侧栏沿用 sticky / 100dvh，隐藏 bottom-tab；桌面 `--bottom-tab` 为 0，消除问答与其他页面的旧底栏预留。
- main 最大宽度 1440px，左右 gutter 32px，居中。标题栏背景仍铺满 app-frame，通过当前页面的内容轴计算内边距。
- 灵感最大 960px，日报最大 920px，保持单列；日报卡片 padding 24px，段落最长 72ch。
- 资产最大 1360px。账户卡 `repeat(auto-fit, minmax(340px, 1fr))`，gap 16px；账户合计独占一整行，账户内部原有 2×2 指标不变。资产表格移除桌面负 margin / 补偿 padding，保持在宽数据区域内。
- 灵感 fixed composer 从侧栏右边开始、贴窗口底部。输入框最大 960px，按 fixed containing block 的百分比计算 gutter，与正文左右边缘一致。
- 灵感底部预留为 232px + safe area，覆盖现有 120px textarea 上限、工具栏与内边距。显示附图时额外预留 72px；显示来源时额外预留 88px，来源区最大 80px 并可内部滚动。任务详情沿用 `data-inspire-detail` 分支与 in-flow task-continue。

## 布局验证

使用本机 Chrome headless 渲染现有 index.html / styles.css，插入符合现有渲染结构的固定测试内容；不运行业务 API、不读取或写入用户数据，也没有模拟桌面鼠标键盘。验证脚本、基线 CSS、截图与日志位于系统临时目录，未加入仓库依赖。

六种窗口 × 灵感、资产、日报、问答，共 24 次渲染检查通过。

| Viewport | 结果 | 灵感 / 日报 / 资产实际宽度 | 账户卡列数 |
| --- | --- | --- | --- |
| 390×844 | 改前改后像素与计算布局一致，底栏存在 | 沿用原布局 | 1 |
| 768×1024 | 改前改后像素与计算布局一致，底栏存在 | 沿用原布局 | 1 |
| 1024×768 | 改前改后像素与计算布局一致，底栏存在 | 沿用原布局 | 1 |
| 1280×800 | 侧栏显示、底栏隐藏，header 与页面对齐 | 960 / 920 / 996px | 2 |
| 1440×900 | 侧栏显示、底栏隐藏，header 与页面对齐 | 960 / 920 / 1156px | 3 |
| 1920×1080 | 侧栏显示、底栏隐藏，header 与页面对齐 | 960 / 920 / 1360px | 3 |

其他通过的检查：

- `<1200px` 的四类页面共 12 次截图 SHA-256 与计算样式比较一致；旧 CSS 前缀内容保持不变。
- 1199 / 1200px 边界切换正确，页面无横向溢出。
- 滚动后 sticky header 与侧栏留在视口顶端；问答线程保持内部滚动，桌面底部不再留 58px 导航空隙。
- 灵感普通输入、120px 长文本、四张附图与长来源提示的布局通过；输入框与正文同轴、不会覆盖侧栏，滚到底后最后一张卡不被 composer 遮挡。
- 未授权状态的 app-shell 仍然隐藏。
- 1280 / 1440 / 1920 宽窗口各按 80% / 100% / 125% 缩放后的 CSS viewport 验证三类页面，共 27 次检查通过。1280 在 125% 时 CSS 宽度为 1024，正确回到旧布局。这里验证的是缩放引起的布局变化，没有操作真实浏览器缩放菜单；未做真机触控 / safe area 验收。
- 已查看三个 1920×1080 测试内容截图，确认阅读列、三列账户与 composer 的轴线。

## 项目检查

- `npm.cmd run check` 已执行（PowerShell 执行策略禁止 npm.ps1，因此使用等价的 npm.cmd）。syntax、syntax:source、syntax:harness、Contract typecheck 通过，在 architecture:verify 停止。
- 架构失败来自本轮开始前已有的未提交文件 `packages/domain/src/media-ingestion-service.js`，直接依赖 Connector 的 `article-html.js`、`article-url.js`、`feed-xml.js`、`http.js`，违反 Domain 依赖方向。本轮没有修改这些文件。
- 单独执行 `npm.cmd run harmony:verify` 通过。
- 单独执行 `npm.cmd test`：577 项，573 通过，4 失败。失败涉及现有启动器进程扫描断言、两处 schemaVersion 预期 32 / 实际 33、工作簿预期 57 / 实际 58 个期间；不涉及本轮 CSS。
- 单独执行 `node --test test/ask-session-layout.test.js test/ask-research-mode-ui.test.js test/reference-pack-ui.test.js test/ui-revision-settle.test.js`：8 项全部通过。
- 本轮文件的 `git diff --check` 通过。

## 已有 CSS 冲突与边界

- 历史设计曾采用 840px 侧栏，但当前 840px 规则强制隐藏侧栏、显示底栏，并让 main 不限宽。保留该规则，只在 1200px 开始覆盖。
- 700px 灵感 dispatch-box 的 720px 上限与新桌面 960px 内容轴冲突，通过新桌面区块覆盖。
- 840px 表格采用负 40px margin 与补偿 padding，桌面资产页局部归零，避免超出内容轴。
- compose-box 后面的通用规则仍覆盖早先 dispatch-box 的背景、边框与 padding；这是原有视觉，不在本轮清理。
- 未清理其他历史 CSS；未修复工作区已有的业务或架构测试失败；没有提交 Git。
