"""Tushare daily bars to the Qlib 0.9.7 bin convention.

Tushare `vol` is 手 and `amount` is 千元. Raw share volume is vol * 100.
Raw VWAP in 元/股 is amount * 1000 / shares.

Qlib stores adjusted prices and adjusted volume, plus a restoration factor:

    raw_close ≈ qlib_close / factor
    raw_shares ≈ qlib_volume * factor

`factor` is Tushare `adj_factor`, so adjusted price = raw price * factor.
`change` is the raw close-to-close return. Exchange uses `$change` for
`limit_threshold`; it is not computed from `$close` when the field is absent.
"""


def shares_from_lots(volume_lots):
    return float(volume_lots) * 100.0


def yuan_from_thousand(amount_thousand):
    return float(amount_thousand) * 1000.0


def vwap_yuan(volume_lots, amount_thousand):
    shares = shares_from_lots(volume_lots)
    amount = yuan_from_thousand(amount_thousand)
    if shares <= 0 or amount <= 0:
        return None
    return amount / shares


def raw_bar(row):
    """Unadjusted bar, or None when the row is not a real trade."""
    required = ("open", "high", "low", "close", "vol", "amount")
    if any(row.get(key) in (None, "") for key in required):
        return None
    try:
        open_ = float(row["open"])
        high = float(row["high"])
        low = float(row["low"])
        close = float(row["close"])
        volume = shares_from_lots(row["vol"])
        price = vwap_yuan(row["vol"], row["amount"])
        factor = float(row["factor"])
    except (TypeError, ValueError):
        return None
    if min(open_, high, low, close, volume, factor) <= 0 or price is None:
        return None
    if high < max(open_, close, low) or low > min(open_, close, high):
        return None
    return {
        "date": row["date"],
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "vwap": price,
        "factor": factor,
    }


def qlib_bar(row, prev_raw_close=None):
    """Adjusted Qlib fields. `change` uses the raw close, not the adjusted one."""
    raw = raw_bar(row)
    if raw is None:
        return None
    factor = raw["factor"]
    change = None
    if prev_raw_close not in (None, "") and float(prev_raw_close) > 0:
        change = raw["close"] / float(prev_raw_close) - 1.0
    return {
        "date": raw["date"],
        "open": raw["open"] * factor,
        "high": raw["high"] * factor,
        "low": raw["low"] * factor,
        "close": raw["close"] * factor,
        "volume": raw["volume"] / factor,
        "vwap": raw["vwap"] * factor,
        "factor": factor,
        "change": change,
        "raw_close": raw["close"],
        "raw_volume": raw["volume"],
    }


def restores_raw_close(qlib_close, factor):
    return float(qlib_close) / float(factor)


def restores_raw_volume(qlib_volume, factor):
    return float(qlib_volume) * float(factor)
