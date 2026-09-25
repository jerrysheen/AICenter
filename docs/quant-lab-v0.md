# 量化实验室 V0

这是一次范围例外：0.2.0 的总停止线仍然是隐私、安全和稳定性。量化实验室只增加一条预登记的 Qlib 研究基线，不改真实持仓、资产、信息流或问答。

## 安装与启动

需要 Python 3.11。不要用系统里的 Python 3.13。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-quant.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-ai-center.ps1
```

页面入口：工具 → 量化实验室，或直接打开 `#quant`。准备数据和运行实验只在本机桌面会话开放。安装依赖和下载行情都不会在打开页面时自动发生。

`TUSHARE_TOKEN` 继续放在本机 `.env`。不要把它写进页面、日志或 Git。

## 数据与结果放在哪里

研究数据在实例数据目录的 `data/quant/`，和交易账本分开：

```text
data/quant/cache/tushare/     原始接口缓存
data/quant/csv/               交给 Qlib 的未复权行情
data/quant/qlib/              Qlib bin 数据
data/quant/manifest.json      数据清单
data/quant/experiments/<id>/  一次实验的配置、日志、模型和报告
```

这些目录已被 `data/*` 忽略，不会进 Git。Python 环境在 `quant/.venv/`，同样不进 Git。

## 基线配置在哪

| 内容 | 文件 |
|---|---|
| 股票池、日期、默认 topk / n_drop | `quant/src/aicenter_quant/universe.py` |
| Tushare 字段、单位和 Qlib 转换 | `quant/src/aicenter_quant/prepare.py`、`units.py` |
| Alpha158、LightGBM、TopkDropout、费用和线程 | `quant/src/aicenter_quant/run_experiment.py` |
| 官方二进制转换 | `quant/vendor/dump_bin.py`（Qlib v0.9.7 原脚本，未改核心） |

下一轮只替换一个因子或评分方法时，改 `run_experiment.py` 里生成的 workflow：特征类现在是 `Alpha158`，模型类是 `LGBModel`。不要改页面来传入任意 YAML。

## 命令

```powershell
$env:PYTHONPATH = "quant\src"
quant\.venv\Scripts\python.exe -m aicenter_quant doctor
quant\.venv\Scripts\python.exe -m aicenter_quant prepare --root data\quant
quant\.venv\Scripts\python.exe -m aicenter_quant run --root data\quant --topk 5 --n-drop 1
```

第二次准备会复用 `cache/tushare` 里同一区间的缓存。

## 已完成与限制

已接上的是日频研究回测：Alpha158、LightGBM、TopkDropoutStrategy、Qlib 原生 Recorder 和 Plotly HTML 报告。

当前股票池是固定教学小样本，存在选样偏差，不是历史指数成分，不能当作盈利证据。基准是 Tushare `index_daily` 的沪深 300，不是用股票池收益冒充的。

MLflow 3 默认停用文件型 tracking。Qlib 0.9.7 的 Recorder 仍写 `mlruns`，运行时设置 `MLFLOW_ALLOW_FILE_STORE=true`，不改 Qlib 核心。

Qlib 价格等于未复权价格乘以 Tushare `adj_factor`，成交量等于原始股数除以该因子。原始收盘价约等于 Qlib 收盘价除以 factor。`$change` 用未复权涨跌幅，供 `limit_threshold` 使用。数据版本写在 `data/quant/versions/`，不会覆盖上一版 `data/quant/qlib`。

本轮不做实时模拟、券商交易或自动挖因子。
