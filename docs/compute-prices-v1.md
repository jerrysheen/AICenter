# 算力价格 V1

2026-10-12 用户授权：全球行情增加「AI Token」。这里放公开目录里的主要模型 token 价，以及 H100 / H200 / B200 的 GPU 小时租金。它不进入证券行情、硬件价表或模型用量账本。

页面只读。采集在 Worker 的已注册任务里完成。Web 不直接抓外站。价格用十进制字符串，币种是 USD。页面契约不返回解析版本、原始响应或本机模型供应商。

## Token

每天抓一次 `https://openrouter.ai/api/v1/models`，不使用密钥。`pricing.prompt` 与 `pricing.completion` 是每 token 美元，乘 1,000,000 后保存为每百万 token。每个族只留 `created` 最新、且输入和输出都能计价的一条文本模型，跳过带 `:` 的别名。`architecture.output_modalities` 必须是非空且每一项都是 `text`。id 中带 `-image`、`-audio`、`-tts`、`-video`、`preview-image`、`image-preview` 的型号，以及名称里带 image、audio、video、tts、speech 的型号，都不进入族。族是 GPT、GPT mini、Claude Opus / Sonnet / Haiku、Gemini Pro / Flash、DeepSeek、Grok、Llama。某一族当天没有公开价时记警告，其余照常保存。一个都没有则任务失败。

报价日是 Asia/Shanghai 的日历日。同一天、同一价格只更新检查时间。下一天即使价格相同也记一条新观测，这样日环比是 0 而不是缺一天。日环比相对该型号上一个报价日；上一日价格为 0 时不计算涨跌。

## GPU

RunPod 用公开 GraphQL `gpuTypes`，不使用密钥。查询带上安全云、社区云和未分档 `lowestPrice` 的 `stockStatus` 与 `uninterruptablePrice`。保留名称里的 H100、H200、B200，去掉 MIG。安全云和社区云分开。价格为 0 的档不保存。响应里没有这些库存对象时，仍保留非零价。有库存对象时，`stockStatus` 为空、`none`、`unavailable` 或 `out` 的档记为无库存并跳过。社区云查询经常不返回库存；若未分档 `lowestPrice` 为 High、Medium 或 Low，且 `uninterruptablePrice` 等于该档目录价，仍保留。留下的价格再按型号（H100、H200、B200）取中位，低于中位 40% 或低于下限的丢掉。下限是 H100 1、H200 1.5、B200 2 美元/时。跳过原因写入 Worker 日志，不编造价格。

Vast.ai 对 `https://console.vast.ai/api/v0/bundles/` 按 H100 SXM、H100 NVL、H100 PCIE 分别查询，`num_gpus` 至少 1，`limit` 500，按 `dph_total` 升序。计入 verified、unverified 和未标验证的整卡，跳过 deverified。同一 `id` 或 `ask_contract_id` 只计一次。单卡小时价是 `dph_total / num_gpus`。样本至少 3 条才保存最低和中位，并带上样本数；少于 3 条只记警告。页面上 Vast 行写出条数，样本少于 3 的不显示。三次查询都失败且没有挂牌时，任务失败。这仍不是全市场。

CCIR 读公开 `https://ccir.io/rates`。页面是静态阶梯表，robots 允许抓取。保存 H100、H200、B200、B300、A100 的超大规模、新云、市场三档，以及按需保障和按需可中断。空单元格不是 0。单元格上的 `n=` 记为样本数。报价日优先用页面上的 `AS OF` 或 print 日期。`market.ccir-gpu.snapshot` 默认每天 20:30（Asia/Shanghai），21:30 再跑一次；同一天价格不变只更新检查时间。

GPU Economy 读各卡页面，例如 `https://gpueconomy.com/gpu/h100-sxm`。站点欢迎引用。保存多供应商中位价：每个供应商只计一次最便宜的按需牌价，社区云和市场底价不进中位。样本数是供应商数。页面行带出来源链接。比较页里的 “Median rate card” 表也能解析。默认每 120 分钟。

Bargo 读公开 `https://www.bargo.ai/gpu-prices`。保存 H100、H200、B200、B300、A100 的按需、竞价、预留均价，样本数是供应商数。`$—` 和 “no listings” 不记。报价日用页面上的更新日期。默认每天 09:00（Asia/Shanghai）。这三处都沿用同一条异常价规则：低于同型号已留价格中位的 40%，或低于下限，就跳过并写入日志。下限是 H100 1、H200 1.5、B200 2、B300 2.5、A100 0.4 美元/时。

Ornn 读公开指数 `https://data.ornn.com/api/public-index/gpu/{name}/index-history`，不使用密钥。路径名在 `config/gpu-rent-normalization.json`：`H100 SXM`、`H200`、`B200`。来源是 `ornn`，档位是 `ocpi`，归入指数。结算时间戳按 America/New_York 的日历日记入 `gpu_rent_daily`。默认每天 06:00（Asia/Shanghai）抓取，09:00 再抓一次。返回的大约三个月历史会整段写入，第一次运行因此带上近 90 天。页面写明指数来自 Ornn，仅供内部参考。不接入 Silicon Data，也不为 GB200 另找来源。

GPU 租金区可以按来源筛选。每一行写出场地、档位、样本数和报价日，并链到公开页面。

## 日程与环境变量

`market.token-prices.snapshot` 默认每天 08:20（Asia/Shanghai）。`market.gpu-rent.snapshot` 默认每 360 分钟。

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_CENTER_TOKEN_PRICE_SYNC` | 开启 | `0` 关闭每日 token 价 |
| `AI_CENTER_TOKEN_PRICE_AT` | `08:20` | `HH:MM` |
| `AI_CENTER_TOKEN_PRICE_TIMEZONE` | `Asia/Shanghai` | 每日时刻与报价日 |
| `AI_CENTER_GPU_RENT_SYNC` | 开启 | `0` 关闭 RunPod / Vast |
| `AI_CENTER_GPU_RENT_INTERVAL_MINUTES` | `360` | 60 到 1440 |
| `AI_CENTER_CCIR_GPU_SYNC` | 开启 | `0` 关闭 CCIR |
| `AI_CENTER_CCIR_GPU_AT` | `20:30` | CCIR 每日时刻 |
| `AI_CENTER_CCIR_GPU_RETRY_AT` | `21:30` | CCIR 同一天再抓一次 |
| `AI_CENTER_GPUECONOMY_SYNC` | 开启 | `0` 关闭 GPU Economy |
| `AI_CENTER_GPUECONOMY_INTERVAL_MINUTES` | `120` | 60 到 1440 |
| `AI_CENTER_BARGO_GPU_SYNC` | 开启 | `0` 关闭 Bargo |
| `AI_CENTER_BARGO_GPU_AT` | `09:00` | Bargo 每日时刻 |
| `AI_CENTER_GPU_RENT_DAILY_SYNC` | 开启 | `0` 关闭日汇总 |
| `AI_CENTER_GPU_RENT_DAILY_AT` | `00:10` | 日汇总时刻 |
| `AI_CENTER_ORNN_GPU_SYNC` | 开启 | `0` 关闭 Ornn |
| `AI_CENTER_ORNN_GPU_AT` | `06:00` | Ornn 每日时刻 |
| `AI_CENTER_ORNN_GPU_RETRY_AT` | `09:00` | Ornn 同一天再抓一次 |

`market.gpu-rent.daily` 在 00:10 把已经结束的北京日历日写入 `gpu_rent_daily`。同一天有多份快照时，规格只取最后一份；最低和最高仍覆盖当天仍在这份规格里的价格，收盘和样本数取最后一份。来源当天检查过但内容没变时，沿用上一次收盘，最低和最高都写成这个收盘，并标 `carried_forward`。已经写好的过去日期不会整段重算；刚结束的那一天会重算。当天的值不入库，由 `GET /api/v1/compute-prices/history` 现算，并在进程里按工作区缓存 60 秒。历史和日汇总只按北京日的时间范围读观测和检查，不扫全表。每条序列带 `dayBasis`：租金是 `Beijing`，Ornn 是 `ET`。型号和档位只从 `config/gpu-rent-normalization.json` 读取。`grain=day` 把同一型号、档位、来源下的原始规格合成一条；`grain=raw` 保留规格和档位，窗口最多 31 天。`start` 和 `end` 必填，最多 366 天。覆盖情况会标出没有来源的型号，例如 GB200 是 `no_source`。覆盖看日表里的型号，再加上当天观测。

migration 55 保存观测。migration 75 用 `IF NOT EXISTS` 建 `gpu_rent_daily`，并给观测加 `(workspace_id, captured_at)` 索引、给快照加 `(workspace_id, last_checked_at)` 索引。它接在 Polymarket 的 73、74 之后。RunPod / Vast / OpenRouter 仍是 `compute-prices-2`。CCIR 是 `ccir-rates-1`，GPU Economy 是 `gpueconomy-median-1`，Bargo 是 `bargo-averages-1`。历史从 2026-10-11 起用 `node scripts/backfill-gpu-rent-daily.mjs` 补，不在启动时自动补。检查时间只留最后一次，所以回填靠前的日子可能有缺口，中间没变价的日期补不回来。重启 Web 和 Worker 后，`#market/global/compute` 的 GPU 租金区才出现日租金图。只读令牌可以读 `/api/v1/compute-prices/history`。持仓和个人资产不开放。
