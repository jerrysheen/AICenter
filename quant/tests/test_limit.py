"""Qlib 0.9.7 applies limit_threshold to the stored $change field."""

import shutil
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from dump_bin import DumpDataAll


def _write(path, rows):
    pd.DataFrame(rows).to_csv(path, index=False)


class LimitFieldTest(unittest.TestCase):
    def test_missing_change_does_not_enforce_the_threshold(self):
        root = Path(tempfile.mkdtemp())
        try:
            csv_dir = root / "csv"
            qlib_dir = root / "qlib"
            csv_dir.mkdir()
            _write(csv_dir / "sh600000.csv", [
                {"date": "2023-01-03", "open": 10, "high": 10, "low": 10, "close": 10, "volume": 1000, "vwap": 10, "factor": 1, "change": 0},
                {"date": "2023-01-04", "open": 11, "high": 11, "low": 11, "close": 11, "volume": 1000, "vwap": 11, "factor": 1, "change": 0.10},
                {"date": "2023-01-05", "open": 11, "high": 11, "low": 11, "close": 11, "volume": 1000, "vwap": 11, "factor": 1, "change": 0.01},
            ])
            DumpDataAll(
                data_path=str(csv_dir), qlib_dir=str(qlib_dir), freq="day", max_workers=1,
                include_fields="open,high,low,close,volume,vwap,factor,change",
            ).dump()
            import qlib
            from qlib.backtest.exchange import Exchange
            from qlib.data import D
            qlib.init(provider_uri=str(qlib_dir), region="cn")
            stored = D.features(["SH600000"], ["$change"], start_time="2023-01-04", end_time="2023-01-04")
            self.assertAlmostEqual(float(stored["$change"].iloc[0]), 0.10, places=6)
            exchange = Exchange(
                freq="day", start_time="2023-01-03", end_time="2023-01-05",
                codes=["SH600000"], deal_price="close", limit_threshold=0.095,
            )
            limited = exchange.quote_df["limit_buy"]
            self.assertTrue(bool(limited.xs("SH600000", level="instrument").loc["2023-01-04"]))
            self.assertFalse(bool(limited.xs("SH600000", level="instrument").loc["2023-01-05"]))
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
