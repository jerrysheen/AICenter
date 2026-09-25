import argparse
import json
import sys
import uuid

from aicenter_quant.prepare import main_prepare
from aicenter_quant.run_experiment import run_experiment
from aicenter_quant.universe import DEFAULT_N_DROP, DEFAULT_TOPK


def main(argv=None):
    parser = argparse.ArgumentParser(prog="aicenter_quant")
    sub = parser.add_subparsers(dest="command", required=True)

    prepare = sub.add_parser("prepare")
    prepare.add_argument("--root", required=True)

    run = sub.add_parser("run")
    run.add_argument("--root", required=True)
    run.add_argument("--experiment-id", default="")
    run.add_argument("--topk", type=int, default=DEFAULT_TOPK)
    run.add_argument("--n-drop", type=int, default=DEFAULT_N_DROP)

    doctor = sub.add_parser("doctor")

    args = parser.parse_args(argv)
    if args.command == "doctor":
        import lightgbm
        import qlib
        print(json.dumps({
            "python": sys.version.split()[0],
            "qlib": qlib.__version__,
            "lightgbm": lightgbm.__version__,
        }))
        return 0
    if args.command == "prepare":
        return main_prepare(args.root)
    experiment_id = args.experiment_id or str(uuid.uuid4())
    if args.topk < 1 or args.topk > 20 or args.n_drop < 0 or args.n_drop >= args.topk:
        print("topk 必须在 1 到 20 之间，且 n_drop 必须小于 topk", file=sys.stderr)
        return 2
    try:
        summary = run_experiment(args.root, experiment_id, args.topk, args.n_drop)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps({
        "ok": summary.get("status") == "completed",
        "experiment_id": experiment_id,
        "prediction_rows": summary.get("prediction_rows"),
        "position_days": summary.get("position_days"),
    }, ensure_ascii=False))
    return 0 if summary.get("status") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
