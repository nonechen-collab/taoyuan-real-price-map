"""禮貌下載：每次請求至少間隔 DELAY_SEC 秒，不丟例外，回傳狀態字典"""

import http.cookiejar
import os
import re
import ssl
import time
import urllib.error
import urllib.request

DELAY_SEC = float(os.environ.get("PLVR_DELAY", "10"))  # 開源專案慣例 10 秒，避免造成對方負擔
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; taoyuan-real-price-map/1.0; personal non-commercial; "
                  "+https://github.com/nonechen-collab/taoyuan-real-price-map)",
    "Accept": "text/html,application/xhtml+xml,application/zip,application/json,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5",
}
# 開放 API（OpenStreetMap 等）用的識別字串：不冒充瀏覽器，Overpass 會擋瀏覽器式 User-Agent
API_HEADERS = {
    "User-Agent": "taoyuan-real-price-map/1.0 (personal non-commercial; +https://github.com/nonechen-collab/taoyuan-real-price-map)",
    "Accept": "application/json",
}
BLOCK_MARKERS = ("The requested URL was rejected", "Request Rejected", "Access Denied")


def _ssl_context():
    """內政部網站的 TWCA 憑證鏈過不了 Python 3.13 起預設開啟的嚴格檢查（VERIFY_X509_STRICT）。
    這裡只關掉這個嚴格旗標，憑證照樣驗證；不可改成完全不驗證。"""
    ctx = ssl.create_default_context()
    if hasattr(ssl, "VERIFY_X509_STRICT"):
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=_ssl_context()),
)
_last = {}


def _polite_wait(host, delay):
    gap = time.monotonic() - _last.get(host, 0.0)
    if gap < delay:
        time.sleep(delay - gap)
    _last[host] = time.monotonic()


def fetch(url, dest=None, timeout=300, max_bytes=1024 ** 3, delay=None, data=None, retries=2, headers=None):
    """GET（或帶 data 的 POST）。dest 有值時串流存檔，否則回傳 bytes。
    回傳 (info, body)；info["ok"] 為 False 時看 info["error"]。暫時性錯誤會重試。"""
    host = urllib.request.urlparse(url).netloc
    info = {}
    for attempt in range(retries + 1):
        _polite_wait(host, DELAY_SEC if delay is None else delay)
        info, body = _fetch_once(url, dest, timeout, max_bytes, data, headers or HEADERS)
        transient = not info["ok"] and not info["blocked"] and (info["status"] is None or info["status"] >= 500)
        if info["ok"] or not transient or attempt == retries:
            return info, body
        time.sleep(30 * (attempt + 1))
    return info, None


def _fetch_once(url, dest, timeout, max_bytes, data, headers):
    info = {"url": url, "ok": False, "status": None, "bytes": 0, "seconds": None,
            "content_type": None, "error": None, "snippet": None, "blocked": False}
    head, body = b"", None
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url, headers=headers, data=data)
        with _opener.open(req, timeout=timeout) as resp:
            info["status"] = resp.status
            info["content_type"] = resp.headers.get("Content-Type")
            if dest is not None:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(dest, "wb") as f:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        if not head:
                            head = chunk[:4096]
                        info["bytes"] += len(chunk)
                        if info["bytes"] > max_bytes:
                            raise OSError("檔案超過大小上限")
                        f.write(chunk)
            else:
                body = resp.read(max_bytes)
                info["bytes"] = len(body)
                head = body[:4096]
            info["ok"] = True
    except urllib.error.HTTPError as e:
        info["status"] = e.code
        info["error"] = f"HTTP {e.code} {e.reason}"
        try:
            head = e.read(4096)
        except Exception:
            head = b""
    except Exception as e:  # 逾時、連線被拒、DNS 失敗、TLS 錯誤等
        info["error"] = f"{type(e).__name__}: {e}"
    info["seconds"] = round(time.monotonic() - t0, 2)
    text = head.decode("utf-8", "replace") if head else ""
    if any(m in text for m in BLOCK_MARKERS):
        info.update(blocked=True, ok=False, error=info["error"] or "被網站防火牆擋下")
    if head and not head.startswith(b"PK"):
        info["snippet"] = re.sub(r"\s+", " ", text)[:200]
    return info, body
