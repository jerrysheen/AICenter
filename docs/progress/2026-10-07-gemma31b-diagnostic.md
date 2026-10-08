# 2026-10-07 Gemma 31B 有限诊断

用户要求配合运行下载的 gemma31b-diagnostic 包。本轮从仓库根目录运行外部脚本，仅读取 GEMINI_API_KEY5，不轮换账号、不重试、不调用 Harness、不改正式模型池或翻译配置。Node 22.23.2；外部脚本离线测试 13/13 通过。

## 实测

本轮共 10 次 Google 官方请求（其中 1 次 ListModels），脚本正常退出。脱敏请求、完整错误和输出保存在本机 `.ai-data/gemma31b-diagnostic-2026-10-07T10-05-19-326Z/results.json`，属于忽略的 Host 运行产物。

| 请求 | HTTP / 终止 | 耗时秒 |
| --- | --- | --- |
| ListModels | 200，列出 31B/26B | 1.418 |
| 31B native generateContent，无 generationConfig | 200 / STOP，OK | 45.782 |
| 31B native，minimal，maxOutputTokens 256 | 500 / INTERNAL | 0.778 |
| 同上，加 systemInstruction，不带 role | 500 / INTERNAL | 0.922 |
| 同上，加 systemInstruction.role=system | 500 / INTERNAL | 0.969 |
| 31B streamGenerateContent?alt=sse，minimal，maxOutputTokens 256 | 200 / STOP，OK | 34.342 |
| 31B Google OpenAI 兼容接口 | 500 / INTERNAL | 0.787 |
| 26B native，minimal 对照 | 200 / STOP，OK | 1.293 |
| 31B 流式 minimal 韩文翻译，maxOutputTokens 2048，第一次 | 200 / STOP | 28.944 |
| 同上，第二次 | 200 / STOP | 30.654 |

四次 500 均为 `Internal error encountered.`，无用量字段，不能补零或称配额耗尽。两次翻译分别报告总 Token 229/230。

## 结论与限制

31B 本轮已获得基础响应和两次完整翻译，覆盖此前“尚未验证可用”的状态，但不能据此认定生产稳定。默认非流式也成功一次，不能将全部问题归因为 thinkingConfig；相同基础 contents/generationConfig 的流式成功而非流式失败，是后续优先验证的接口差异线索，不是已证明的服务端根因。补 systemInstruction.role 在本轮没有修复 500，不修改现有适配器。

两次韩文短段输出人工核对均保留每台 680,000 韩元、不含增值税及安装费、考虑 6 台但尚未下单、测量合格与再培训完成同时满足才计划用于夜班，以及任一条件未满足则维持人工检查。中文“下个月为止”较生硬；本轮仅对该短段核对，不扩展为长文质量验收。脚本原始 `translationQualityVerified: false` 保持原样，人工结论独立记录。

Google 官方文档当前列出两个模型 ID、native v1beta 调用与 minimal/high 开关；其 systemInstruction REST 示例本身不带 role。因此 role 线索不能视为官方必填要求。参考：<https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api>。

仅新增本诊断记录，未改业务源码、数据库、服务或正式默认配置；未运行无关全仓检查，也不将脚本 13 项测试冒称项目回归。
