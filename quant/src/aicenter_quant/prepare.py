import csv
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from aicenter_quant.tushare_client import TushareError, fetch_all, read_token
from aicenter_quant.units import qlib_bar, restores_raw_close, restores_raw_volume
from aicenter_quant.universe import (
    BENCHMARK_QLIB,
    BENCHMARK_TS_CODE,
    DATA_END,
    DATA_START,
    LABEL_GAP_TRADING_DAYS,
    SAMPLE_LABEL,
    SAMPLE_NOTE,
    SAMPLE_TS_CODES,
    TEST_END,
    TRAIN_END,
    TRAIN_START,
    VALID_END,
    qlib_code,
)

DAILY_FIELDS = "ts_code,trade_date,open,high,low,close,vol,amount"
ADJ_FIELDS = "ts_code,trade_date,adj_factor"
BASIC_FIELDS = "ts_code,name,list_date,exchange"
INDEX_FIELDS = "ts_code,trade_date,open,high,low,close,vol,amount"


def _root(path):
    root = Path(path).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _write_csv(path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        writer.writerows(rows)


def _read_csv(path):
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _cache_covers(path, start, end):
    meta_path = path.with_suffix(path.suffix + ".meta.json")
    if path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return meta.get("start") == start and meta.get("end") == end and path.stat().st_size > 0
    return False


def _fetch_cached(cache_path, api_name, params, fields, token, start, end):
    if _cache_covers(cache_path, start, end):
        return _read_csv(cache_path), True
    columns, rows = fetch_all(api_name, params, fields, token)
    _write_csv(cache_path, columns, rows)
    cache_path.with_suffix(cache_path.suffix + ".meta.json").write_text(
        json.dumps({"start": start, "end": end, "rows": len(rows)}),
        encoding="utf-8",
    )
    return _read_csv(cache_path), False


def _iso(compact):
    text = str(compact)
    return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"


def _shift_trading_day(days, day, steps):
    if day not in days:
        later = [item for item in days if item > day]
        if not later:
            raise RuntimeError(f"交易日不足，无法从 {day} 向后移动")
        day = later[0]
        steps -= 1
    index = days.index(day) + steps
    if index < 0 or index >= len(days):
        raise RuntimeError(f"交易日不足，无法把 {day} 移动 {steps} 天")
    return days[index]


def _segments(open_days):
    train_start = _iso(TRAIN_START.replace("-", ""))
    train_end = _iso(TRAIN_END.replace("-", ""))
    valid_end = _iso(VALID_END.replace("-", ""))
    test_end = _iso(TEST_END.replace("-", ""))
    iso_days = [_iso(day) for day in open_days]
    valid_start = _shift_trading_day(iso_days, train_end, LABEL_GAP_TRADING_DAYS + 1)
    test_start = _shift_trading_day(iso_days, valid_end, LABEL_GAP_TRADING_DAYS + 1)
    # The last backtest step reads the next calendar timestamp, and the label
    # looks two sessions ahead. Keep those days in the handler, outside the test.
    test_end = iso_days[-4]
    handler_end = iso_days[-1]
    if not (train_start < train_end < valid_start < valid_end < test_start <= test_end <= handler_end):
        raise RuntimeError("训练、验证、测试区间没有按标签跨度分开")
    return {
        "handler_start": _iso(DATA_START),
        "handler_end": handler_end,
        "fit_start": train_start,
        "fit_end": train_end,
        "train": [train_start, train_end],
        "valid": [valid_start, valid_end],
        "test": [test_start, test_end],
        "label_gap_trading_days": LABEL_GAP_TRADING_DAYS,
        "label": "Ref($close, -2)/Ref($close, -1) - 1",
    }


def _rows_by_date(rows, date_key="trade_date"):
    found = {}
    for row in rows:
        day = row.get(date_key)
        if not day or day in found:
            continue
        found[day] = row
    return found


def _qlib_rows(daily_rows, factor_by_date, factor_default=None):
    converted = []
    dropped = {"missing_price": 0, "missing_factor": 0, "no_trade": 0, "duplicate": 0}
    seen = set()
    prev_raw_close = None
    for row in sorted(daily_rows, key=lambda item: item["trade_date"]):
        day = row["trade_date"]
        if day in seen:
            dropped["duplicate"] += 1
            continue
        seen.add(day)
        factor = factor_by_date.get(day, factor_default)
        if factor in (None, ""):
            dropped["missing_factor"] += 1
            continue
        bar = qlib_bar({
            "date": _iso(day),
            "open": row.get("open"),
            "high": row.get("high"),
            "low": row.get("low"),
            "close": row.get("close"),
            "vol": row.get("vol"),
            "amount": row.get("amount"),
            "factor": factor,
        }, prev_raw_close=prev_raw_close)
        if bar is None:
            dropped["no_trade"] += 1
            continue
        prev_raw_close = bar["raw_close"]
        converted.append(bar)
    return converted, dropped


def _write_symbol_csv(path, bars):
    fields = ["date", "open", "high", "low", "close", "volume", "vwap", "factor", "change"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for bar in bars:
            row = {key: bar.get(key) for key in fields}
            if row["change"] is None:
                row["change"] = ""
            writer.writerow(row)


def _dump(csv_dir, qlib_dir):
    vendor = Path(__file__).resolve().parents[2] / "vendor"
    sys.path.insert(0, str(vendor))
    from dump_bin import DumpDataAll

    DumpDataAll(
        data_path=str(csv_dir),
        qlib_dir=str(qlib_dir),
        freq="day",
        max_workers=2,
        include_fields="open,high,low,close,volume,vwap,factor,change",
    ).dump()


def _read_qlib_bar(qlib_dir, symbol, day):
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    import qlib
    from qlib.data import D

    qlib.init(provider_uri=str(qlib_dir), region="cn")
    frame = D.features(
        [symbol], ["$close", "$factor", "$volume", "$change"], start_time=day, end_time=day,
    )
    if frame.empty:
        raise RuntimeError(f"Qlib 读不到 {symbol} {day}")
    return {
        "close": float(frame["$close"].iloc[0]),
        "factor": float(frame["$factor"].iloc[0]),
        "volume": float(frame["$volume"].iloc[0]),
        "change": None if frame["$change"].isna().iloc[0] else float(frame["$change"].iloc[0]),
    }


def _check_restoration(qlib_dir, symbol, day, raw_close, raw_volume, factor, raw_change=None):
    stored = _read_qlib_bar(qlib_dir, symbol, day)
    restored_close = restores_raw_close(stored["close"], stored["factor"])
    restored_volume = restores_raw_volume(stored["volume"], stored["factor"])
    if abs(restored_close - raw_close) / raw_close > 1e-4:
        raise RuntimeError(
            f"无法还原原始收盘价 {symbol} {day}: raw={raw_close} restored={restored_close}"
        )
    if abs(restored_volume - raw_volume) / raw_volume > 1e-3:
        raise RuntimeError(
            f"无法还原原始成交量 {symbol} {day}: raw={raw_volume} restored={restored_volume}"
        )
    if abs(stored["factor"] - factor) / factor > 1e-4:
        raise RuntimeError(f"factor 与 Tushare adj_factor 不一致 {symbol} {day}")
    if raw_change is not None and stored["change"] is not None:
        if abs(stored["change"] - raw_change) > 1e-6:
            raise RuntimeError(f"$change 不是原始涨跌幅 {symbol} {day}")
    return {
        "symbol": symbol,
        "date": day,
        "raw_close": raw_close,
        "qlib_close": stored["close"],
        "factor": stored["factor"],
        "restored_close": restored_close,
        "raw_volume": raw_volume,
        "restored_volume": restored_volume,
        "change": stored["change"],
    }


def prepare_data(root):
    token = read_token()
    base = _root(root)
    cache = base / "cache" / "tushare"
    cache.mkdir(parents=True, exist_ok=True)
    downloaded = []
    reused = []
    series = {}

    calendar_path = cache / "trade_cal.csv"
    calendar_rows, calendar_cached = _fetch_cached(
        calendar_path, "trade_cal",
        {"exchange": "SSE", "start_date": DATA_START, "end_date": DATA_END, "is_open": "1"},
        "cal_date,is_open", token, DATA_START, DATA_END,
    )
    (reused if calendar_cached else downloaded).append("trade_cal")
    open_days = sorted({row["cal_date"] for row in calendar_rows if row.get("is_open") == "1"})
    if len(open_days) < 500:
        raise RuntimeError("交易日历过短")
    segments = _segments(open_days)

    kept = []
    excluded = []
    for ts_code in SAMPLE_TS_CODES:
        basic_path = cache / f"{ts_code}.basic.csv"
        basic_rows, basic_cached = _fetch_cached(
            basic_path, "stock_basic", {"ts_code": ts_code}, BASIC_FIELDS, token, DATA_START, DATA_END,
        )
        (reused if basic_cached else downloaded).append(f"{ts_code}:stock_basic")
        if not basic_cached:
            time.sleep(0.25)
        info = basic_rows[0] if basic_rows else {}
        list_date = info.get("list_date") or ""
        if not list_date or list_date > "20170101":
            excluded.append({"ts_code": ts_code, "reason": f"上市日 {list_date or '缺失'} 晚于样本要求"})
            continue
        daily_path = cache / f"{ts_code}.daily.csv"
        daily_rows, daily_cached = _fetch_cached(
            daily_path, "daily",
            {"ts_code": ts_code, "start_date": DATA_START, "end_date": DATA_END},
            DAILY_FIELDS, token, DATA_START, DATA_END,
        )
        (reused if daily_cached else downloaded).append(f"{ts_code}:daily")
        if not daily_cached:
            time.sleep(0.25)
        adj_path = cache / f"{ts_code}.adj.csv"
        adj_rows, adj_cached = _fetch_cached(
            adj_path, "adj_factor",
            {"ts_code": ts_code, "start_date": DATA_START, "end_date": DATA_END},
            ADJ_FIELDS, token, DATA_START, DATA_END,
        )
        (reused if adj_cached else downloaded).append(f"{ts_code}:adj_factor")
        if not adj_cached:
            time.sleep(0.25)
        factors = {row["trade_date"]: row["adj_factor"] for row in adj_rows if row.get("trade_date")}
        bars, dropped = _qlib_rows(daily_rows, factors)
        if len(bars) < 200:
            excluded.append({"ts_code": ts_code, "reason": f"有效行情只有 {len(bars)} 天", "dropped": dropped})
            continue
        symbol = qlib_code(ts_code)
        series[symbol] = bars
        kept.append({
            "ts_code": ts_code,
            "qlib": symbol,
            "name": info.get("name") or "",
            "list_date": list_date,
            "bars": len(bars),
            "dropped": dropped,
            "start": bars[0]["date"],
            "end": bars[-1]["date"],
        })

    if len(kept) < 20:
        raise RuntimeError(f"有效股票不足：{len(kept)}")

    index_path = cache / f"{BENCHMARK_TS_CODE}.daily.csv"
    index_rows, index_cached = _fetch_cached(
        index_path, "index_daily",
        {"ts_code": BENCHMARK_TS_CODE, "start_date": DATA_START, "end_date": DATA_END},
        INDEX_FIELDS, token, DATA_START, DATA_END,
    )
    (reused if index_cached else downloaded).append("000300.SH:index_daily")
    index_bars, index_dropped = _qlib_rows(index_rows, {}, factor_default="1")
    if len(index_bars) < 200:
        raise RuntimeError("沪深300基准行情不足，不能用股票池收益代替指数")
    series[BENCHMARK_QLIB] = index_bars

    digest = hashlib.sha256()
    for symbol in sorted(series):
        for bar in series[symbol]:
            digest.update(f"{symbol},{bar['date']},{bar['close']:.8f},{bar['volume']:.8f},{bar['factor']:.8f},{bar['change']}\n".encode())
    content_sha256 = digest.hexdigest()
    version_id = f"v0.1-{content_sha256[:12]}"
    version_dir = base / "versions" / version_id
    csv_dir = version_dir / "csv"
    qlib_dir = version_dir / "qlib"
    csv_dir.mkdir(parents=True, exist_ok=True)
    for symbol, bars in series.items():
        _write_symbol_csv(csv_dir / f"{symbol.lower()}.csv", bars)

    _dump(csv_dir, qlib_dir)
    sample_file = qlib_dir / "instruments" / "lab_sample.txt"
    with sample_file.open("w", encoding="utf-8") as handle:
        for item in kept:
            handle.write(f"{item['qlib']}\t{item['start']}\t{item['end']}\n")

    sample = kept[0]
    sample_bar = series[sample["qlib"]][0]
    ordinary = _check_restoration(
        qlib_dir, sample["qlib"], sample_bar["date"],
        sample_bar["raw_close"], sample_bar["raw_volume"], sample_bar["factor"],
    )
    ex_rights = _ex_rights_case(series)
    if ex_rights is None:
        raise RuntimeError("样本里没有跨复权因子变化的交易日，不能验收复权约定")
    ex_check = _check_restoration(
        qlib_dir, ex_rights["symbol"], ex_rights["date"],
        ex_rights["raw_close"], ex_rights["raw_volume"], ex_rights["factor"],
        raw_change=ex_rights["change"],
    )

    manifest = {
        "id": version_id,
        "content_sha256": content_sha256,
        "source": "tushare",
        "sample_label": SAMPLE_LABEL,
        "sample_note": SAMPLE_NOTE,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "date_range": {"start": _iso(DATA_START), "end": _iso(DATA_END)},
        "stock_count": len(kept),
        "benchmark": {"ts_code": BENCHMARK_TS_CODE, "qlib": BENCHMARK_QLIB, "bars": len(index_bars), "factor": 1},
        "adjustment": "Qlib 价格 = 未复权价格 × Tushare adj_factor；成交量 = 原始股数 / factor。原始价 ≈ Qlib 价 / factor。$change 用未复权收盘价。",
        "units": "Tushare vol 为手、amount 为千元；还原后的 volume 为股，vwap 为元/股，再按 factor 调整到 Qlib 尺度。",
        "pool": "固定名单，不是历史指数成分",
        "qlib_version": "0.9.7",
        "segments": segments,
        "stocks": kept,
        "excluded": excluded,
        "index_dropped": index_dropped,
        "cache": {"reused": len(reused), "downloaded": len(downloaded)},
        "roundtrip": {"ordinary": ordinary, "ex_rights": ex_check},
        "qlib_dir": f"versions/{version_id}/qlib",
        "csv_dir": f"versions/{version_id}/csv",
    }
    (base / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _ex_rights_case(series):
    for symbol, bars in series.items():
        if symbol == BENCHMARK_QLIB:
            continue
        previous = None
        for bar in bars:
            if previous is not None and abs(bar["factor"] - previous["factor"]) / previous["factor"] > 1e-6:
                return {"symbol": symbol, **bar}
            previous = bar
    return None


def main_prepare(root):
    try:
        manifest = prepare_data(root)
    except TushareError as error:
        print(f"准备数据失败：{error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"准备数据失败：{error}", file=sys.stderr)
        return 1
    print(json.dumps({
        "ok": True,
        "stock_count": manifest["stock_count"],
        "benchmark": manifest["benchmark"]["qlib"],
        "segments": manifest["segments"],
        "cache_reused": manifest["cache"]["reused"],
        "cache_downloaded": manifest["cache"]["downloaded"],
    }, ensure_ascii=False))
    return 0
