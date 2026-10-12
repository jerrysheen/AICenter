# 2026-10-12 AI Token 与 GPU 租金

## 目标

在全球行情增加「AI Token」，每天保存主要模型的每百万 token 价格，并按数小时保存 H100 / H200 / B200 的公开小时租金。

## 决定

OpenRouter 公开型号目录不需要密钥。单价按每 token 美元换算成每百万 token。每个模型族只留最新一条可计价型号。报价日用 Asia/Shanghai。同一天价格不变只更新检查时间；跨日即使价格相同也保留新观测，日环比相对上一报价日。

RunPod 的 `gpuTypes` 不需要密钥，保存 H100 / H200 / B200 的安全云和社区云，价格为 0 的档不记。Vast.ai 公开 bundles 只覆盖有限挂牌，有整卡 H100 时记最低和中位，没有就不编价格。

页面契约只给报价、日环比和检查时间，不给解析版本或原始响应。

## 改动

migration 55。Connector 解析三处公开响应。Domain 保存并计算日环比。Worker 注册 `market.token-prices.snapshot` 与 `market.gpu-rent.snapshot`。`GET /api/v1/compute-prices`。全球行情 `#market/global/compute`。

## 验证

`node --test test/compute-prices.test.js` 覆盖换算、型号筛选、RunPod / Vast 样例、跨日涨跌、重复检查、日程开关和只读接口。没有打开浏览器。

## 遗留

生产库要等 Worker 重启后的第一次任务才有快照。Vast 挂牌不是全市场。
