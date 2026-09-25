"""Synthetic checks for the Qlib adjustment convention. Not a market backtest."""

import unittest

from aicenter_quant.units import qlib_bar, restores_raw_close, restores_raw_volume, vwap_yuan


class UnitsTest(unittest.TestCase):
    def test_vwap_uses_shares_and_yuan(self):
        self.assertEqual(vwap_yuan(10, 20), 20)

    def test_missing_trade_is_dropped(self):
        self.assertIsNone(qlib_bar({
            "date": "2024-01-02",
            "open": 10, "high": 10, "low": 10, "close": 10,
            "vol": 0, "amount": 0, "factor": 1,
        }))

    def test_does_not_invent_ohlc(self):
        self.assertIsNone(qlib_bar({
            "date": "2024-01-02",
            "open": None, "high": 11, "low": 9, "close": 10,
            "vol": 10, "amount": 20, "factor": 1,
        }))

    def test_adjusted_price_restores_raw_close_and_volume(self):
        bar = qlib_bar({
            "date": "2018-01-02",
            "open": 700, "high": 710, "low": 690, "close": 703.85,
            "vol": 100, "amount": 70.385, "factor": 7.111,
        }, prev_raw_close=700)
        self.assertAlmostEqual(restores_raw_close(bar["close"], bar["factor"]), 703.85, places=6)
        self.assertAlmostEqual(restores_raw_volume(bar["volume"], bar["factor"]), 10000, places=6)
        self.assertAlmostEqual(bar["change"], 703.85 / 700 - 1, places=8)

    def test_ex_rights_day_uses_raw_change_not_adjusted_jump(self):
        before = qlib_bar({
            "date": "2018-06-14",
            "open": 100, "high": 100, "low": 100, "close": 100,
            "vol": 10, "amount": 10, "factor": 2,
        })
        after = qlib_bar({
            "date": "2018-06-15",
            "open": 50, "high": 52, "low": 49, "close": 51,
            "vol": 20, "amount": 10.2, "factor": 4,
        }, prev_raw_close=100)
        self.assertAlmostEqual(restores_raw_close(after["close"], after["factor"]), 51, places=6)
        adjusted_jump = after["close"] / before["close"] - 1
        self.assertNotAlmostEqual(after["change"], adjusted_jump, places=4)
        self.assertAlmostEqual(after["change"], 51 / 100 - 1, places=8)


if __name__ == "__main__":
    unittest.main()
