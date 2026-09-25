import json
import os
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import yaml

from aicenter_quant.universe import (
    BENCHMARK_QLIB,
    DEFAULT_ACCOUNT,
    DEFAULT_N_DROP,
    DEFAULT_TOPK,
    SAMPLE_LABEL,
    THREAD_LIMIT,
)

QLIB_VERSION = "0.9.7"


def experiment_dir(root, experiment_id):
    path = Path(root).resolve() / "experiments" / experiment_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def build_config(manifest, provider_uri, topk, n_drop):
    segments = manifest["segments"]
    data_handler = {
        "start_time": segments["handler_start"],
        "end_time": segments["handler_end"],
        "fit_start_time": segments["fit_start"],
        "fit_end_time": segments["fit_end"],
        "instruments": "lab_sample",
    }
    port_analysis = {
        "strategy": {
            "class": "TopkDropoutStrategy",
            "module_path": "qlib.contrib.strategy",
            "kwargs": {
                "signal": "<PRED>",
                "topk": int(topk),
                "n_drop": int(n_drop),
            },
        },
        "backtest": {
            "start_time": segments["test"][0],
            "end_time": segments["test"][1],
            "account": DEFAULT_ACCOUNT,
            "benchmark": BENCHMARK_QLIB,
            "exchange_kwargs": {
                "limit_threshold": 0.095,
                "deal_price": "close",
                "open_cost": 0.0005,
                "close_cost": 0.0015,
                "min_cost": 5,
            },
        },
    }
    return {
        "qlib_init": {
            "provider_uri": provider_uri,
            "region": "cn",
        },
        "market": "lab_sample",
        "benchmark": BENCHMARK_QLIB,
        "data_handler_config": data_handler,
        "port_analysis_config": port_analysis,
        "task": {
            "model": {
                "class": "LGBModel",
                "module_path": "qlib.contrib.model.gbdt",
                "kwargs": {
                    "loss": "mse",
                    "colsample_bytree": 0.8879,
                    "learning_rate": 0.2,
                    "subsample": 0.8789,
                    "lambda_l1": 205.6999,
                    "lambda_l2": 580.9768,
                    "max_depth": 8,
                    "num_leaves": 210,
                    "num_threads": THREAD_LIMIT,
                    "seed": 42,
                },
            },
            "dataset": {
                "class": "DatasetH",
                "module_path": "qlib.data.dataset",
                "kwargs": {
                    "handler": {
                        "class": "Alpha158",
                        "module_path": "qlib.contrib.data.handler",
                        "kwargs": data_handler,
                    },
                    "segments": {
                        "train": segments["train"],
                        "valid": segments["valid"],
                        "test": segments["test"],
                    },
                },
            },
            "record": [
                {
                    "class": "SignalRecord",
                    "module_path": "qlib.workflow.record_temp",
                    "kwargs": {"model": "<MODEL>", "dataset": "<DATASET>"},
                },
                {
                    "class": "SigAnaRecord",
                    "module_path": "qlib.workflow.record_temp",
                    "kwargs": {"ana_long_short": False, "ann_scaler": 252},
                },
                {
                    "class": "PortAnaRecord",
                    "module_path": "qlib.workflow.record_temp",
                    "kwargs": {"config": port_analysis},
                },
            ],
        },
    }


def _thread_env():
    env = os.environ.copy()
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env[key] = str(THREAD_LIMIT)
    env["MLFLOW_ALLOW_FILE_STORE"] = "true"
    env["MLFLOW_DISABLE_AGENT_HINT"] = "1"
    env.pop("TUSHARE_TOKEN", None)
    return env


def _qrun_path():
    candidate = Path(sys.executable).with_name("qrun.exe" if os.name == "nt" else "qrun")
    if not candidate.exists():
        raise RuntimeError("当前虚拟环境里没有 qrun。请先运行 scripts/setup-quant.ps1")
    return candidate


def _write_status(folder, status, **extra):
    payload = {"status": status, "updated_at": datetime.now(timezone.utc).isoformat(), **extra}
    (folder / "status.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def run_experiment(root, experiment_id, topk=DEFAULT_TOPK, n_drop=DEFAULT_N_DROP):
    base = Path(root).resolve()
    manifest_path = base / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError("还没有数据清单。请先准备数据。")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    folder = experiment_dir(base, experiment_id)
    provider = str((base / manifest.get("qlib_dir", "qlib")).resolve()).replace("\\", "/")
    config = build_config(manifest, provider, topk, n_drop)
    config_path = folder / "workflow.yaml"
    config_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    _write_status(folder, "running", experiment_id=experiment_id, topk=topk, n_drop=n_drop)
    log_path = folder / "run.log"
    command = [str(_qrun_path()), str(config_path.name)]
    with log_path.open("w", encoding="utf-8") as log:
        completed = subprocess.run(
            command,
            cwd=folder,
            env=_thread_env(),
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if completed.returncode != 0:
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        _write_status(folder, "failed", returncode=completed.returncode, error=tail)
        raise RuntimeError(f"qrun 失败，退出码 {completed.returncode}")
    from aicenter_quant.export_report import export_experiment

    summary = export_experiment(folder, manifest, config, topk, n_drop)
    _write_status(folder, "completed", experiment_id=experiment_id)
    return summary
