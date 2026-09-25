import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from aicenter_quant.universe import BENCHMARK_QLIB, DEFAULT_ACCOUNT, SAMPLE_LABEL, SAMPLE_NOTE, THREAD_LIMIT


def _load_pickle(path):
    import pickle
    with path.open("rb") as handle:
        return pickle.load(handle)


def _find_artifacts(folder):
    found = {}
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix == ".pkl":
            found.setdefault(path.name, path)
    return found


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _metric(name, value, meaning):
    return {"name": name, "value": _finite(value), "meaning": meaning}


def _frame(value):
    if isinstance(value, pd.Series):
        return value.to_frame("score")
    if isinstance(value, pd.DataFrame):
        return value
    return None


def _prediction_table(pred, label):
    frame = _frame(pred)
    if frame is None or frame.empty:
        return pd.DataFrame(columns=["date", "instrument", "score", "rank", "label"])
    score = frame.iloc[:, 0].rename("score")
    table = score.reset_index()
    columns = list(table.columns)
    if "datetime" in columns:
        table = table.rename(columns={"datetime": "date"})
    elif "date" not in columns:
        table = table.rename(columns={columns[0]: "date"})
    if "instrument" not in table.columns and len(columns) > 1:
        table = table.rename(columns={columns[1]: "instrument"})
    table["date"] = pd.to_datetime(table["date"]).dt.strftime("%Y-%m-%d")
    label_frame = _frame(label)
    if label_frame is not None and not label_frame.empty:
        labels = label_frame.iloc[:, 0].rename("label").reset_index()
        label_columns = list(labels.columns)
        labels = labels.rename(columns={label_columns[0]: "date", label_columns[1]: "instrument"})
        labels["date"] = pd.to_datetime(labels["date"]).dt.strftime("%Y-%m-%d")
        table = table.merge(labels, on=["date", "instrument"], how="left")
    else:
        table["label"] = pd.NA
    table["rank"] = table.groupby("date")["score"].rank(ascending=False, method="min").astype(int)
    return table.sort_values(["date", "rank"])


def _position_table(positions):
    rows = []
    if isinstance(positions, dict):
        items = positions.items()
    else:
        return pd.DataFrame(columns=["date", "instrument", "amount", "weight"])
    for day, position in items:
        date = pd.Timestamp(day).strftime("%Y-%m-%d")
        weights = {}
        if hasattr(position, "get_stock_weight_dict"):
            weights = position.get_stock_weight_dict(only_stock=True) or {}
        stocks = position.get_stock_list() if hasattr(position, "get_stock_list") else list(weights)
        for stock in stocks:
            amount = position.get_stock_amount(stock) if hasattr(position, "get_stock_amount") else None
            rows.append({
                "date": date,
                "instrument": stock,
                "amount": amount,
                "weight": weights.get(stock),
            })
    return pd.DataFrame(rows)


def _collect_figures(report, pred_label):
    figures = []
    errors = []

    def take(label, producer):
        try:
            produced = producer() or []
            figures.extend(produced)
        except Exception as error:
            errors.append(f"{label}：{error}")

    if report is not None and not getattr(report, "empty", True):
        from qlib.contrib.report.analysis_position import report_graph
        take("收益与回撤图", lambda: report_graph(report, show_notebook=False))
    if pred_label is not None and not pred_label.empty:
        from qlib.contrib.report.analysis_position import score_ic_graph
        take("IC 图", lambda: score_ic_graph(pred_label, show_notebook=False))
        try:
            from qlib.contrib.report.analysis_model import model_performance_graph
            take("模型表现图", lambda: model_performance_graph(pred_label, show_notebook=False))
        except Exception as error:
            errors.append(f"模型表现图未能导入：{error}")
    return figures, errors


def _html_report(report, pred_label, target):
    figures, errors = _collect_figures(report, pred_label)
    parts = [
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>量化实验室报告</title></head><body>",
        "<h1>量化实验室基线报告</h1>",
        f"<p>{SAMPLE_LABEL}。{SAMPLE_NOTE}</p>",
    ]
    if not figures:
        parts.append("<p>没有可嵌入的图形。</p>")
    parts.extend(f"<p>{item}</p>" for item in errors)
    for index, figure in enumerate(figures):
        parts.append(figure.to_html(full_html=False, include_plotlyjs=index == 0))
    parts.append("</body></html>")
    target.write_text("\n".join(parts), encoding="utf-8")
    return errors


def summarize_report(report, initial_account):
    """Qlib report['return'] is already before cost. Account is the compounded book."""
    metrics = []
    if not isinstance(report, pd.DataFrame):
        return metrics
    if "return" in report.columns:
        metrics.append(_metric(
            "strategy_gross_daily_return_sum",
            report["return"].sum(),
            "扣费前日收益累加。Qlib report.return 已是扣费前，这不是复利账户净值",
        ))
    if "return" in report.columns and "cost" in report.columns:
        metrics.append(_metric(
            "strategy_net_daily_return_sum",
            (report["return"] - report["cost"]).sum(),
            "扣费后日收益累加，等于 return 减去 cost，仍然不是复利账户净值",
        ))
    if "bench" in report.columns:
        metrics.append(_metric("benchmark_daily_return_sum", report["bench"].sum(), "基准日收益累加"))
    if "return" in report.columns and "bench" in report.columns:
        metrics.append(_metric(
            "excess_gross_daily_return_sum",
            (report["return"] - report["bench"]).sum(),
            "扣费前超额日收益累加，不是相对净值回撤",
        ))
    if "account" in report.columns and len(report) and initial_account:
        ending = _finite(report["account"].iloc[-1])
        period = None if ending is None else ending / float(initial_account) - 1
        metrics.append(_metric(
            "account_period_return",
            period,
            "期末 account / 初始资金 - 1，是复利账户的区间收益，不是日收益累加",
        ))
        metrics.append(_metric("account_ending", ending, "Qlib 回测账户期末资产"))
    if "turnover" in report.columns:
        metrics.append(_metric("turnover_mean", report["turnover"].mean(), "日换手均值"))
    return metrics


def model_diagnostics(folder, predictions):
    diagnostics = {"distinct_scores": None, "model": None}
    if isinstance(predictions, pd.DataFrame) and not predictions.empty:
        counts = predictions.groupby("date")["score"].nunique()
        diagnostics["distinct_scores"] = {
            "days": int(len(counts)),
            "min": int(counts.min()),
            "median": float(counts.median()),
            "max": int(counts.max()),
        }
    model_path = None
    for path in folder.rglob("params.pkl"):
        model_path = path
        break
    if model_path is None:
        diagnostics["model"] = {"missing": "实验产物里没有 params.pkl"}
        return diagnostics
    try:
        model = _load_pickle(model_path)
        booster = getattr(model, "model", None)
        if booster is None:
            diagnostics["model"] = {"missing": "params.pkl 里没有 LightGBM booster"}
            return diagnostics
        importance = booster.feature_importance(importance_type="gain")
        names = booster.feature_name()
        ranked = sorted(zip(names, importance), key=lambda item: item[1], reverse=True)[:12]
        diagnostics["model"] = {
            "best_iteration": int(getattr(booster, "best_iteration", 0) or 0),
            "num_trees": int(booster.num_trees()),
            "num_leaves_param": booster.params.get("num_leaves"),
            "top_features": [{"name": name, "gain": float(gain)} for name, gain in ranked],
        }
    except Exception as error:
        diagnostics["model"] = {"missing": f"无法读取模型：{error}"}
    return diagnostics


def _activity(report, positions):
    turnover = None
    if isinstance(report, pd.DataFrame) and "turnover" in report.columns:
        turnover = _finite(report["turnover"].abs().sum())
    holding_days = 0
    if isinstance(positions, pd.DataFrame) and not positions.empty:
        holding_days = int(positions.groupby("date")["instrument"].count().gt(0).sum())
    return {"turnover_sum": turnover, "position_days": holding_days}


def export_experiment(folder, manifest, config, topk, n_drop):
    artifacts = _find_artifacts(folder)
    pred = _load_pickle(artifacts["pred.pkl"]) if "pred.pkl" in artifacts else None
    label = None
    for name in ("label.pkl", "labels.pkl"):
        if name in artifacts:
            label = _load_pickle(artifacts[name])
            break
    report = None
    for name, path in artifacts.items():
        if name.startswith("report_normal"):
            report = _load_pickle(path)
            break
    positions_raw = None
    for name, path in artifacts.items():
        if name.startswith("positions_normal"):
            positions_raw = _load_pickle(path)
            break
    predictions = _prediction_table(pred, label)
    positions = _position_table(positions_raw)
    export_dir = folder / "export"
    export_dir.mkdir(exist_ok=True)
    predictions.to_csv(export_dir / "predictions.csv", index=False)
    positions.to_csv(export_dir / "positions.csv", index=False)
    if isinstance(report, pd.DataFrame):
        report.to_csv(export_dir / "report_normal.csv")
    pred_label = None
    if not predictions.empty and "label" in predictions.columns:
        indexed = predictions.copy()
        indexed["datetime"] = pd.to_datetime(indexed["date"])
        pred_label = indexed.set_index(["datetime", "instrument"])[["score", "label"]]
    graph_errors = _html_report(report if isinstance(report, pd.DataFrame) else None, pred_label, folder / "report.html")
    activity = _activity(report if isinstance(report, pd.DataFrame) else None, positions)
    test_predictions = predictions
    segments = manifest["segments"]["test"]
    if not predictions.empty:
        test_predictions = predictions[(predictions["date"] >= segments[0]) & (predictions["date"] <= segments[1])]
    metrics = summarize_report(report if isinstance(report, pd.DataFrame) else None, DEFAULT_ACCOUNT)
    ic_value = None
    rank_ic = None
    for name, path in artifacts.items():
        if name.startswith("ic.pkl") or name == "ic.pkl":
            loaded = _load_pickle(path)
            if hasattr(loaded, "mean"):
                ic_value = _finite(loaded.mean())
        if name.startswith("ric.pkl") or name == "ric.pkl":
            loaded = _load_pickle(path)
            if hasattr(loaded, "mean"):
                rank_ic = _finite(loaded.mean())
    metrics.append(_metric("IC", ic_value, "SigAnaRecord 信息系数均值；缺失则不是 0"))
    metrics.append(_metric("Rank IC", rank_ic, "SigAnaRecord Rank IC 均值；缺失则不是 0"))
    dates = sorted(test_predictions["date"].unique().tolist()) if not test_predictions.empty else []
    summary = {
        "experiment_id": folder.name,
        "status": "completed" if activity["position_days"] else "completed_without_positions",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "sample_label": SAMPLE_LABEL,
        "sample_note": SAMPLE_NOTE,
        "qlib_version": "0.9.7",
        "data_manifest_id": manifest.get("id"),
        "data_sha256": manifest.get("content_sha256"),
        "segments": manifest.get("segments"),
        "topk": int(topk),
        "n_drop": int(n_drop),
        "account": DEFAULT_ACCOUNT,
        "benchmark": BENCHMARK_QLIB,
        "threads": THREAD_LIMIT,
        "seed": 42,
        "prediction_rows": int(len(test_predictions)),
        "position_days": activity["position_days"],
        "turnover_sum": activity["turnover_sum"],
        "test_dates": dates[:],
        "metrics": metrics,
        "diagnostics": model_diagnostics(folder, test_predictions),
        "graph_errors": graph_errors,
        "assumptions": {
            "deal_price": "close",
            "signal_shift": "Qlib 0.9.7 TopkDropoutStrategy 用前一交易日信号，在当日 close 成交",
            "open_cost": 0.0005,
            "close_cost": 0.0015,
            "min_cost": 5,
            "limit_threshold": 0.095,
            "not_simulated": "没有逐笔成交、真实涨跌停分板块、停牌精确撮合、冲击成本和资金账户会计",
        },
        "artifacts": {
            "report_html": "report.html",
            "predictions": "export/predictions.csv",
            "positions": "export/positions.csv",
            "config": "workflow.yaml",
            "log": "run.log",
        },
        "config": config,
    }
    if activity["position_days"] == 0 or test_predictions.empty:
        summary["status"] = "failed"
        summary["error"] = "测试区间没有预测或没有持仓变动，不能把这次运行当作已跑通的回测"
    (folder / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary
