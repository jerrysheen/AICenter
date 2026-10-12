# 2026-10-12 算力价格过滤

## 目标

生产第一次抓取里，Gemini Pro 选到了出图型号，H200 NVL 社区云记了无库存的 0.5 美元/时，Vast 的 H100 只有 2 条样本。

## 决定

OpenRouter 每个族只留文本模型。`architecture.output_modalities` 必须全部是 `text`。id 或名称指向 image、audio、video、tts 的型号跳过。

RunPod 读取 `lowestPrice` 的 `stockStatus`。没有库存对象的旧响应仍保留非零价。库存为空的档跳过。未分档报价有库存，且 `uninterruptablePrice` 等于该档目录价时，社区云仍保留。留下的价格若低于同型号中位的 40%，或低于 H100 1、H200 1.5、B200 2 美元/时，也跳过。原因写入 Worker 日志。

Vast 按 H100 SXM、H100 NVL、H100 PCIE 查询，`num_gpus` 不限张数，计入 verified 与 unverified，跳过 deverified。单卡价用 `dph_total / num_gpus`。少于 3 条不保存最低和中位。页面写出样本条数，并隐藏少于 3 条的 Vast 行。

不新增 migration。解析版本改为 `compute-prices-2`，下一次抓取另记快照。

## 改动

`packages/connectors/src/compute-prices.js`、`packages/runtime/src/compute-price-job.js`、`apps/web/public/compute-prices.js`。

## 验证

`node --test test/compute-prices.test.js`。没有打开行情页。

## 遗留

重启 Worker 后下一次任务才写入新快照。重载 Web 后旧的薄 Vast 行才从页面消失。Vast 仍不是全市场。
