import json
import os
import time
import urllib.request

DEFAULT_URL = "https://api.tushare.pro"


class TushareError(RuntimeError):
    pass


def read_token():
    token = os.environ.get("TUSHARE_TOKEN", "").strip()
    if not token:
        raise TushareError("TUSHARE_TOKEN 未配置")
    return token


def call_tushare(api_name, params, fields, token, url=DEFAULT_URL, attempts=4):
    body = json.dumps({
        "api_name": api_name,
        "token": token,
        "params": params,
        "fields": fields,
    }).encode("utf-8")
    last_error = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=40) as response:
                payload = json.loads(response.read().decode("utf-8"))
            code = payload.get("code")
            if code not in (0, None, "0"):
                message = str(payload.get("msg") or f"{api_name} 失败")
                if "token" in message.lower():
                    message = f"{api_name} 鉴权失败"
                raise TushareError(message)
            data = payload.get("data") or {}
            columns = data.get("fields") or []
            rows = data.get("items") or []
            return columns, rows
        except TushareError:
            raise
        except Exception as error:
            last_error = error
            time.sleep(1.2 * (attempt + 1))
    raise TushareError(f"{api_name} 请求失败：{last_error}")


def fetch_all(api_name, params, fields, token, page_size=5000):
    frames = []
    offset = 0
    columns = []
    while True:
        page_params = {**params, "offset": offset, "limit": page_size}
        columns, rows = call_tushare(api_name, page_params, fields, token)
        frames.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
        time.sleep(0.35)
    return columns, frames
