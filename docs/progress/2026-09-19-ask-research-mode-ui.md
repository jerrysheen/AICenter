# 问答专业研究开关适配 HarmonyOS

## 目标

上一轮留下的「专业研究」入口是原生勾选框，和问答底栏、HarmonyOS 选择类控件不一致。按 `docs/design/harmonyos-design-guides.md` 把这个二元档位改成开关，不改 Contract / Service。

## 决定

- 二元档位用开关，不用勾选。隐藏 checkbox 只保留表单取值和 `localStorage`。
- 文案 + 轨道位置同时表达开闭，不只靠颜色。
- 热区至少 40vp；间距走 8vp；选中轨道用品牌蓝 Token；开关动效 150ms，减弱动效降到 120ms。
- 联网选择和专业研究收在左侧工具组，发送留在右侧。

## 验证

`npm test -- test/ask-research-mode-ui.test.js test/research-profile.test.js test/static-files.test.js`
