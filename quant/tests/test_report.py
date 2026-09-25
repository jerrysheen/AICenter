"""Fee direction on a synthetic Qlib report. Not a market backtest."""

import unittest

import pandas as pd

from aicenter_quant.export_report import summarize_report


class ReportTest(unittest.TestCase):
    def test_flat_price_fee_is_subtracted_not_added(self):
        report = pd.DataFrame([{
            "return": 0.0,
            "cost": 4749.43 / 10_000_000,
            "bench": 0.0,
            "account": 9_995_250.57,
            "turnover": 1.0,
        }])
        metrics = {item["name"]: item["value"] for item in summarize_report(report, 10_000_000)}
        self.assertAlmostEqual(metrics["strategy_gross_daily_return_sum"], 0.0)
        self.assertAlmostEqual(metrics["strategy_net_daily_return_sum"], -(4749.43 / 10_000_000))
        self.assertAlmostEqual(metrics["account_period_return"], 9_995_250.57 / 10_000_000 - 1)
        self.assertLess(metrics["strategy_net_daily_return_sum"], metrics["strategy_gross_daily_return_sum"])


if __name__ == "__main__":
    unittest.main()
