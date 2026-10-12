# 算力价格 V1

2026-10-12 用户授权：全球行情增加「AI Token」。这里放公开目录里的主要模型 token 价，以及 H100 / H200 / B200 的 GPU 小时租金。它不进入证券行情、硬件价表或模型用量账本。

页面只读。采集在 Worker 的已注册任务里完成。Web 不直接抓外站。价格用十进制字符串，币种是 USD。页面契约不返回解析版本、原始响应或本机模型供应商。

## Token

每天抓一次 `https://openrouter.ai/api/v1/models`，不使用密钥。`pricing.prompt` 与 `pricing.completion` 是每 token 美元，乘 1,000,000 后保存为每百万 token。每个族只留 `created` 最新、且输入和输出都能计价的一条，跳过带 `:` 的别名。族是 GPT、GPT mini、Claude Opus / Sonnet / Haiku、Gemini Pro / Flash、DeepSeek、Grok、Llama。某一族当天没有公开价时记警告，其余照常保存。一个都没有则任务失败。

报价日是 Asia/Shanghai 的日历日。同一天、同一价格只更新检查时间。下一天即使价格相同也记一条新观测，这样日环比是 0 而不是缺一天。日环比相对该型号上一个报价日；上一日价格为 0 时不计算涨跌。

## GPU

RunPod 用公开 GraphQL `gpuTypes { id displayName securePrice communityPrice }`，不使用密钥。保留名称里的 H100、H200、B200，去掉 MIG。安全云和社区云分开；价格为 0 的档不保存。

Vast.ai 读公开 `https://console.vast.ai/api/v0/bundles/`。只统计整卡 H100，小时价用 `dph_total / num_gpus`。有挂牌时保存最低和中位；没有 H100 时记警告并保存这次检查，不编造价格。这个接口只返回有限挂牌，不能当成全市场。

## 日程与环境变量

`market.token-prices.snapshot` 默认每天 08:20（Asia/Shanghai）。`market.gpu-rent.snapshot` 默认每 360 分钟。

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_CENTER_TOKEN_PRICE_SYNC` | 开启 | `0` 关闭每日 token 价 |
| `AI_CENTER_TOKEN_PRICE_AT` | `08:20` | `HH:MM` |
| `AI_CENTER_TOKEN_PRICE_TIMEZONE` | `Asia/Shanghai` | 每日时刻与报价日 |
| `AI_CENTER_GPU_RENT_SYNC` | 开启 | `0` 关闭 GPU 租金 |
| `AI_CENTER_GPU_RENT_INTERVAL_MINUTES` | `360` | 60 到 1440 |

migration 55 只新增快照、检查和观测表。重启 Worker 后才会建表、注册任务并写入日程。重载 Web 后 `#market/global/compute` 才出现「AI Token」。
