"""Fixed teaching sample. Not a historical index membership table."""

SAMPLE_LABEL = "教学小样本／存在选样偏差"
SAMPLE_NOTE = (
    "固定名单只用于跑通研究流程，不是中证指数的历史成分。"
    "回测结果不能当作盈利证据。"
)

# Listed well before the 2018 sample window. Prepare drops any name whose
# Tushare list_date is after 2017-01-01.
SAMPLE_TS_CODES = (
    "600519.SH",
    "600036.SH",
    "601318.SH",
    "600276.SH",
    "600900.SH",
    "601166.SH",
    "600030.SH",
    "601398.SH",
    "601288.SH",
    "600887.SH",
    "600031.SH",
    "600309.SH",
    "601888.SH",
    "600048.SH",
    "601668.SH",
    "600585.SH",
    "600104.SH",
    "600000.SH",
    "000858.SZ",
    "000333.SZ",
    "000651.SZ",
    "002415.SZ",
    "000001.SZ",
    "000002.SZ",
    "002594.SZ",
    "000725.SZ",
    "002475.SZ",
)

BENCHMARK_TS_CODE = "000300.SH"
BENCHMARK_QLIB = "SH000300"

DATA_START = "20180101"
DATA_END = "20241231"
# Alpha158 rolling windows need history before the first training day.
TRAIN_START = "2019-01-02"
TRAIN_END = "2021-12-31"
# Label is Ref($close, -2) / Ref($close, -1) - 1, so each split leaves
# two trading days out of the next segment.
LABEL_GAP_TRADING_DAYS = 2
VALID_END = "2022-12-30"
TEST_END = "2024-12-31"

DEFAULT_TOPK = 5
DEFAULT_N_DROP = 1
DEFAULT_ACCOUNT = 10_000_000
THREAD_LIMIT = 4


def qlib_code(ts_code):
    code, exchange = str(ts_code).split(".")
    return f"{exchange}{code}"
