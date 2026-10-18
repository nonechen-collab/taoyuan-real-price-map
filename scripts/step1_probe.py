#!/usr/bin/env python3
"""
第一步：連線測試＋桃園實價登錄資料檢查（只用 Python 標準函式庫，不必安裝套件）

用法（Windows 把 python3 換成 python 或 py）
  python3 scripts/step1_probe.py
      連線測試 → 下載最新一期與上一季 → 分析 → 產生報告（每次請求間隔 10 秒，約 1–3 分鐘）
  python3 scripts/step1_probe.py --local 檔案或資料夾 [...]
      不連網，直接分析手動下載的 zip 或資料夾

輸出
  reports/step1_report.md     報告（GitHub Actions 也會顯示在執行摘要 Summary）
  reports/step1_summary.json  給程式用的摘要
  data/raw/<期別>/             解壓出的桃園檔案（已列入 .gitignore，不進 repo）

資料來源：內政部不動產成交案件實際資訊資料供應系統
授權：政府資料開放授權條款－第1版
"""

from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import http.cookiejar
import io
import json
import os
import platform
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT_DIR = ROOT / "reports"
RAW_DIR = ROOT / "data" / "raw"

BASE = os.environ.get("PLVR_BASE", "https://plvr.land.moi.gov.tw").rstrip("/")
PAGE_URL = BASE + "/DownloadOpenData"
CURRENT_URL = BASE + "/Download?type=zip&fileName=lvr_landcsv.zip"
SEASON_URL = BASE + "/DownloadSeason?season={season}&type=zip&fileName=lvr_landcsv.zip"

CITY_PREFIX = "h_lvr_land_"  # 桃園市代碼 H
FILE_RE = re.compile(r"^h_lvr_land_([abc])(?:_(build|land|park))?\.csv$")
KIND_NAMES = {"a": "買賣", "b": "預售屋", "c": "租賃"}
SUB_NAMES = {"main": "主表", "build": "建物明細", "land": "土地明細", "park": "車位明細"}
DELAY_SEC = float(os.environ.get("PLVR_DELAY", "10"))  # 每次請求至少間隔幾秒（開源專案慣例 10 秒），避免造成對方負擔
TZ = dt.timezone(dt.timedelta(hours=8))
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; taoyuan-real-price-map/0.1; personal non-commercial)",
    "Accept": "text/html,application/xhtml+xml,application/zip,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5",
}
BLOCK_MARKERS = ("The requested URL was rejected", "Request Rejected", "Access Denied")
WATCH_PROJECTS = ("安彊", "大方", "中運")  # Phase 2 驗收樣本預查（建案名稱關鍵字）
IN_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"

COL_LABELS = {
    "district": "鄉鎮市區", "target": "交易標的", "address": "門牌", "date": "交易年月日",
    "counts": "交易筆棟數", "floor": "移轉層次", "total_floors": "總樓層數", "btype": "建物型態",
    "built": "建築完成年月", "bldg_area": "建物移轉總面積", "total_price": "總價",
    "unit_price": "單價", "park_type": "車位類別", "park_area": "車位面積",
    "park_price": "車位總價", "note": "備註", "id": "編號", "main_area": "主建物面積",
    "aux_area": "附屬建物面積", "balcony": "陽台面積", "elevator": "電梯",
    "project": "建案名稱", "unit_no": "棟及號", "cancel": "解約情形",
}
_A_KEYS = ["district", "target", "address", "date", "counts", "floor", "total_floors", "btype",
           "built", "bldg_area", "total_price", "unit_price", "park_type", "park_area",
           "park_price", "note", "id", "main_area", "aux_area", "balcony", "elevator"]
EXPECTED = {
    "a": _A_KEYS,
    "b": _A_KEYS + ["project", "unit_no", "cancel"],
    "c": ["district", "target", "address", "date", "total_price", "note", "id"],
}


# ───────────────────────── 連線 ─────────────────────────

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
_last_request = [0.0]


def _polite_wait():
    gap = time.monotonic() - _last_request[0]
    if gap < DELAY_SEC:
        time.sleep(DELAY_SEC - gap)
    _last_request[0] = time.monotonic()


def fetch(url, dest=None, timeout=300, max_bytes=1024 ** 3):
    """GET 一個網址，不丟例外。dest 有值時串流存檔，否則回傳內容。"""
    _polite_wait()
    info = {"url": url, "ok": False, "status": None, "bytes": 0, "seconds": None,
            "content_type": None, "error": None, "snippet": None, "blocked": False}
    head, body = b"", None
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url, headers=HEADERS)
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
        info["blocked"] = True
        info["ok"] = False
        info["error"] = info["error"] or "被網站防火牆擋下"
    if head and not head.startswith(b"PK"):
        info["snippet"] = re.sub(r"\s+", " ", text)[:200]
    return info, body


def probe_page():
    info, body = fetch(PAGE_URL, timeout=60, max_bytes=30 * 1024 * 1024)
    html = (body or b"").decode("utf-8", "replace")
    links = re.findall(r"(?:DownloadSeason|DownloadOpenData|Download)\?[^\"'<>\s)]{3,200}", html)
    info["link_patterns"] = sorted(set(links))[:40]
    info["seasons_on_page"] = sorted(set(re.findall(r"\b1\d{2}S[1-4]\b", html)), key=skey, reverse=True)
    m = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
    info["page_title"] = m.group(1).strip() if m else None
    info["label_zh"] = "下載頁"
    return info


def skey(code):
    y, s = code.split("S")
    return int(y), int(s)


def recent_seasons(today, n=2):
    """最近已結束的 n 個季別，例如 2026-10-18 → ['115S3', '115S2']。"""
    y, s = today.year - 1911, (today.month - 1) // 3
    out = []
    while len(out) < n:
        if s == 0:
            y, s = y - 1, 4
        out.append(f"{y}S{s}")
        s -= 1
    return out


def download_zip(url, label):
    dest = RAW_DIR / "_downloads" / f"{label}.zip"
    info, _ = fetch(url, dest=dest)
    info["label"] = label
    if info["ok"]:
        with open(dest, "rb") as f:
            is_zip = f.read(2) == b"PK"
        if not is_zip:
            info["ok"] = False
            info["error"] = "回傳的不是 zip 檔（可能是錯誤頁）"
    if not info["ok"] and dest.exists():
        dest.unlink()  # 錯誤頁不留，內容開頭已記在 snippet
    return info, (dest if info["ok"] else None)


def extract_city(zip_path, label):
    """只解出桃園檔與 manifest／schema 說明檔。"""
    out = RAW_DIR / label
    out.mkdir(parents=True, exist_ok=True)
    saved, names = [], []
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            base = name.replace("\\", "/").rsplit("/", 1)[-1]
            if not base:
                continue
            names.append(base)
            low = base.lower()
            if low.startswith(CITY_PREFIX) or low.startswith("schema") or "manifest" in low:
                target = out / base  # 只取檔名，避免路徑穿越
                with zf.open(name) as src, open(target, "wb") as dst:
                    dst.write(src.read())
                saved.append(target)
    return saved, names


def collect_local(paths):
    periods = []
    for p in map(Path, paths):
        if p.is_file() and zipfile.is_zipfile(p):
            files, _ = extract_city(p, p.stem)
        elif p.is_dir():
            files = [f for f in sorted(p.iterdir()) if f.is_file()]
        else:
            print(f"略過：{p}（不是 zip 也不是資料夾）")
            continue
        periods.append((p.stem if p.is_file() else p.name, files))
    return periods


# ───────────────────────── 讀檔與欄位 ─────────────────────────

_EN_CELL = re.compile(r"^[A-Za-z0-9 ()\-_/.,&'%:+]*$")


def looks_english(row):
    cells = [c.strip() for c in row if c.strip()]
    if not cells:
        return False
    ascii_like = sum(1 for c in cells if _EN_CELL.match(c))
    letters = sum(1 for c in cells if re.search(r"[A-Za-z]", c))
    return ascii_like / len(cells) >= 0.8 and letters / len(cells) >= 0.5


def read_table(path):
    raw = path.read_bytes()
    text, enc = None, None
    for enc in ("utf-8-sig", "cp950", "big5"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text, enc = raw.decode("utf-8", "replace"), "utf-8（有無法辨識的字元）"
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if not rows:
        return {"header": [], "english": None, "rows": [], "encoding": enc, "bad_rows": 0}
    header = [h.strip().lstrip("﻿") for h in rows[0]]
    body, english = rows[1:], None
    if body and looks_english(body[0]):
        english, body = [c.strip() for c in body[0]], body[1:]
    n, bad, fixed = len(header), 0, []
    for r in body:
        if len(r) != n:
            bad += 1
            r = (r + [""] * n)[:n]
        fixed.append([c.strip() for c in r])
    return {"header": header, "english": english, "rows": fixed, "encoding": enc, "bad_rows": bad}


def find_col(header, *keys, exclude=()):
    for i, h in enumerate(header):
        if all(k in h for k in keys) and not any(x in h for x in exclude):
            return i
    return None


def _first(*idxs):
    for i in idxs:
        if i is not None:
            return i
    return None


def cols_for(header):
    def f(*keys, exclude=()):
        return find_col(header, *keys, exclude=exclude)

    return {
        "district": f("鄉鎮市區"),
        "target": f("交易標的"),
        "address": f("門牌"),
        "date": _first(f("交易年月日"), f("租賃年月日")),
        "counts": f("筆棟數"),
        "floor": _first(f("移轉層次"), f("租賃層次")),
        "total_floors": f("總樓層數"),
        "btype": f("建物型態"),
        "built": f("建築完成年月"),
        "bldg_area": f("建物", "總面積", exclude=("主建物", "附屬")),
        "total_price": _first(f("總價", exclude=("車位",)), f("總額", exclude=("車位",))),
        "unit_price": f("單價"),
        "park_type": f("車位類別"),
        "park_area": f("車位", "面積"),
        "park_price": _first(f("車位", "總價"), f("車位", "總額")),
        "note": f("備註"),
        "id": header.index("編號") if "編號" in header else None,
        "main_area": f("主建物面積"),
        "aux_area": f("附屬建物面積"),
        "balcony": f("陽台"),
        "elevator": f("電梯"),
        "project": f("建案名稱"),
        "unit_no": f("棟及號"),
        "cancel": f("解約"),
    }


def g(row, i):
    return row[i] if i is not None and i < len(row) else ""


def num(s):
    s = (s or "").replace(",", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


_COUNTS = re.compile(r"土地(\d+)建物(\d+)車位(\d+)")


def parse_counts(s):
    m = _COUNTS.search(s or "")
    return tuple(int(x) for x in m.groups()) if m else None


def roc_date(s):
    s = re.sub(r"\D", "", s or "")
    if len(s) == 7:
        y, m, d = int(s[:3]), int(s[3:5]), int(s[5:7])
    elif len(s) == 6:
        y, m, d = int(s[:2]), int(s[2:4]), int(s[4:6])
    else:
        return None
    try:
        return dt.date(y + 1911, max(m, 1), max(d, 1))
    except ValueError:
        return None


def pick_samples(rows, k=5):
    n = len(rows)
    idx = range(n) if n <= k else sorted({round(i * (n - 1) / (k - 1)) for i in range(k)})
    return [rows[i] for i in idx]


# ───────────────────────── 分析 ─────────────────────────

def notes_stats(rows, c):
    vals = [g(r, c["note"]) for r in rows]
    vals = [v for v in vals if v]
    segments = collections.Counter()
    for v in vals:
        for s in re.split(r"[；;。\n]+", v):
            s = s.strip(" ，,、:：")
            if s:
                segments[s] += 1
    return {"n": len(rows), "nonempty": len(vals), "exact": collections.Counter(vals), "segments": segments}


def parking_stats(rows, c, park_detail=None):
    st = {"n": 0, "unpriced": 0, "noarea": 0, "by_type": {}, "unpriced_notes": collections.Counter(),
          "detail_checked": 0, "detail_priced": 0}
    for r in rows:
        target = g(r, c["target"])
        if "建物" not in target:
            continue  # 只看房屋交易（排除純土地、純車位）
        counts = parse_counts(g(r, c["counts"]))
        ptype = g(r, c["park_type"])
        if not ((counts and counts[2] > 0) or "車位" in target or ptype):
            continue
        st["n"] += 1
        price = num(g(r, c["park_price"])) or 0
        area = num(g(r, c["park_area"])) or 0
        bucket = st["by_type"].setdefault(ptype or "（未填類別）", [0, 0])
        bucket[0] += 1
        if area == 0:
            st["noarea"] += 1
        if price == 0:
            st["unpriced"] += 1
            bucket[1] += 1
            note = g(r, c["note"])
            if note:
                st["unpriced_notes"][note[:60]] += 1
            if park_detail is not None:
                rid = g(r, c["id"])
                if rid in park_detail:
                    st["detail_checked"] += 1
                    if any(p > 0 for p in park_detail[rid]):
                        st["detail_priced"] += 1
    return st


def park_detail_map(table):
    if table is None or "編號" not in table["header"]:
        return None
    h = table["header"]
    i_id, i_price = h.index("編號"), find_col(h, "價")
    if i_price is None:
        return None
    m = collections.defaultdict(list)
    for r in table["rows"]:
        m[g(r, i_id)].append(num(g(r, i_price)) or 0)
    return m


def balcony_stats(rows, c):
    st = {"cols": all(c[k] is not None for k in ("balcony", "aux_area", "main_area", "bldg_area")),
          "pos": 0, "aux0": 0, "aux_lt": 0, "aux_eq": 0, "aux_gt": 0,
          "ident_n": 0, "ident_sep": 0, "ident_incl": 0, "over_n": 0, "over": 0}
    if not st["cols"]:
        return st
    for r in rows:
        bal = num(g(r, c["balcony"])) or 0
        aux = num(g(r, c["aux_area"])) or 0
        main = num(g(r, c["main_area"])) or 0
        total = num(g(r, c["bldg_area"])) or 0
        parea = num(g(r, c["park_area"])) or 0
        tol = max(0.05, total * 0.002)
        if main > 0 and total > 0:
            st["over_n"] += 1
            if main + aux + bal > (total - parea) + tol:
                st["over"] += 1
        if bal <= 0:
            continue
        st["pos"] += 1
        if aux == 0:
            st["aux0"] += 1
        elif abs(aux - bal) < 0.01:
            st["aux_eq"] += 1
        elif aux < bal:
            st["aux_lt"] += 1
        else:
            st["aux_gt"] += 1
        # 透天厝通常沒有公設：總面積應剛好等於室內面積，可用來判斷陽台算不算在附屬建物裡
        counts = parse_counts(g(r, c["counts"]))
        if ("透天" in g(r, c["btype"]) and parea == 0 and total > 0 and main > 0
                and (counts is None or counts[1] == 1)):
            st["ident_n"] += 1
            if abs(total - (main + aux + bal)) <= tol:
                st["ident_sep"] += 1
            if abs(total - (main + aux)) <= tol:
                st["ident_incl"] += 1
    return st


def unit_stats(rows, c):
    st = {"available": all(c[k] is not None for k in ("unit_price", "total_price", "bldg_area")),
          "n_priced": 0, "m_gross": 0, "m_net": 0, "n_nopark": 0, "m_nopark": 0,
          "n_unpriced": 0, "m_unpriced_gross": 0, "m_unpriced_net": 0}
    if not st["available"]:
        return st
    for r in rows:
        if "建物" not in g(r, c["target"]):
            continue
        u, tp, a = num(g(r, c["unit_price"])), num(g(r, c["total_price"])), num(g(r, c["bldg_area"]))
        if not u or not tp or not a:
            continue
        pp = num(g(r, c["park_price"])) or 0
        pa = num(g(r, c["park_area"])) or 0

        def close(x):
            return int(abs(u - x) / u < 0.01)

        if pp > 0 and pa > 0 and a > pa:
            st["n_priced"] += 1
            st["m_gross"] += close(tp / a)
            st["m_net"] += close((tp - pp) / (a - pa))
        elif pp == 0 and pa == 0:
            st["n_nopark"] += 1
            st["m_nopark"] += close(tp / a)
        elif pp == 0 and a > pa > 0:
            st["n_unpriced"] += 1
            st["m_unpriced_gross"] += close(tp / a)
            st["m_unpriced_net"] += close(tp / (a - pa))
    return st


def presale_stats(rows, c):
    st = {"projects": collections.Counter(), "watch": {k: collections.Counter() for k in WATCH_PROJECTS},
          "cancel": collections.Counter()}
    if c["project"] is not None:
        st["projects"] = collections.Counter(g(r, c["project"]) or "（空白）" for r in rows)
        for name, n in st["projects"].items():
            for k in WATCH_PROJECTS:
                if k in name:
                    st["watch"][k][name] += n
    if c["cancel"] is not None:
        st["cancel"] = collections.Counter(v for v in (g(r, c["cancel"]) for r in rows) if v)
    return st


def analyze_main(kind, header, rows, park_detail=None):
    c = cols_for(header)
    dates = [d for d in (roc_date(g(r, c["date"])) for r in rows) if d]
    out = {
        "date_min": min(dates).isoformat() if dates else None,
        "date_max": max(dates).isoformat() if dates else None,
        "targets": collections.Counter(g(r, c["target"]) or "（空白）" for r in rows),
        "btypes": collections.Counter(g(r, c["btype"]) or "（空白）" for r in rows),
        "missing": [k for k in EXPECTED[kind] if c.get(k) is None],
        "samples": [{h: v for h, v in zip(header, r) if v} for r in pick_samples(rows)],
        "stats": {"notes": notes_stats(rows, c) if c["note"] is not None else None},
    }
    if kind in ("a", "b"):
        out["stats"]["parking"] = parking_stats(rows, c, park_detail)
        out["stats"]["balcony"] = balcony_stats(rows, c)
        out["stats"]["unit"] = unit_stats(rows, c)
    if kind == "b":
        out["stats"]["presale"] = presale_stats(rows, c)
        out["unit_no_examples"] = [g(r, c["unit_no"]) for r in pick_samples(rows, 8)] if c["unit_no"] is not None else []
    return out


def analyze_period(label, files):
    tables = {}
    for p in files:
        m = FILE_RE.match(p.name.lower())
        if m:
            tables[(m.group(1), m.group(2) or "main")] = (p.name, read_table(p))
    out = {}
    for kind in "abc":
        for sub in ("main", "build", "land", "park"):
            if (kind, sub) not in tables:
                continue
            name, t = tables[(kind, sub)]
            e = {"kind": kind, "sub": sub, "file": name, "rows": len(t["rows"]), "columns": t["header"],
                 "english": t["english"], "encoding": t["encoding"], "bad_rows": t["bad_rows"]}
            if sub == "main":
                park = tables.get((kind, "park"))
                pdm = park_detail_map(park[1]) if park and kind in "ab" else None
                e["analysis"] = analyze_main(kind, t["header"], t["rows"], pdm)
            out[f"{kind}_{sub}"] = e
    return {"label": label, "files": out}


def merge(a, b):
    """把兩期的統計數字相加（Counter 相加、字典逐項相加、[筆數, 未拆價] 逐項相加）。"""
    if a is None:
        return b
    if b is None:
        return a
    if isinstance(a, bool):
        return a or b
    if isinstance(a, (int, float)):
        return a + b
    if isinstance(a, collections.Counter):
        return a + b
    if isinstance(a, list):
        return [x + y for x, y in zip(a, b)]
    if isinstance(a, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = merge(a.get(k), v)
        return out
    return a


def merged_stats(periods):
    merged = {}
    for p in periods:
        for kind in "abc":
            e = p["files"].get(f"{kind}_main")
            if e:
                merged[kind] = merge(merged.get(kind), e["analysis"]["stats"])
    return merged


# ───────────────────────── 判定 ─────────────────────────

def pct(a, b):
    return f"{a / b:.1%}" if b else "—"


def trunc(s, n):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def conn_verdict(probe):
    if probe["ok"]:
        return f"✅ 可以（HTTP {probe['status']}，{probe['seconds']} 秒）"
    if probe["blocked"]:
        return f"❌ 被網站防火牆擋下（{trunc(probe.get('snippet') or '', 60)}）"
    return f"❌ 連不上（{probe['error'] or probe['status']}）"


def size_text(n):
    if not n:
        return "—"
    return f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{n / 1e3:.0f} KB"


def dl_verdict(d):
    if d["ok"]:
        return f"✅ {size_text(d['bytes'])}，{d['seconds']} 秒，桃園檔 {d.get('city_files', 0)} 個"
    if d.get("skipped"):
        return "略過（前面已確認連不上）"
    return f"❌ {d['error'] or ('HTTP ' + str(d['status']))}"


def balcony_verdict(st):
    """回傳（判定, 依據清單）。"""
    if not st or not st.get("cols"):
        return "無法判定（缺陽台或附屬建物欄位）", []
    ev, v_ident, v_ineq = [], None, None
    n = st["ident_n"]
    if n:
        sep, incl = st["ident_sep"] / n, st["ident_incl"] / n
        ev.append(f"透天厝（無公設，總面積應等於室內面積）{n:,} 筆中：總面積＝主建物＋附屬＋陽台 "
                  f"{st['ident_sep']:,} 筆（{sep:.0%}）；總面積＝主建物＋附屬 {st['ident_incl']:,} 筆（{incl:.0%}）")
        if n >= 20 and sep >= 0.5 and sep >= 2 * incl:
            v_ident = "sep"
        elif n >= 20 and incl >= 0.5 and incl >= 2 * sep:
            v_ident = "incl"
    pos = st["pos"]
    if pos:
        lt = st["aux0"] + st["aux_lt"]
        ev.append(f"陽台面積大於 0 的 {pos:,} 筆中：附屬建物＝0 有 {st['aux0']:,} 筆、0＜附屬＜陽台 {st['aux_lt']:,} 筆、"
                  f"附屬＝陽台 {st['aux_eq']:,} 筆、附屬＞陽台 {st['aux_gt']:,} 筆")
        if pos >= 20 and lt / pos >= 0.05:
            v_ineq = "sep"  # 若陽台算在附屬裡，附屬一定 ≥ 陽台
        elif pos >= 20 and st["aux_eq"] / pos >= 0.3:
            v_ineq = "incl?"
    if st["over_n"]:
        ev.append(f"主建物＋附屬＋陽台 ＞ 建物面積－車位面積：{st['over']:,}／{st['over_n']:,} 筆")
    if v_ident == "sep" and v_ineq in (None, "sep"):
        return "不含：陽台與附屬建物分開計，室內面積＝主建物＋附屬建物＋陽台", ev
    if v_ident == "incl" and v_ineq != "sep":
        return "已含：陽台已算在附屬建物內，室內面積＝主建物＋附屬建物", ev
    if v_ident is None and v_ineq == "sep":
        return "不含：常見陽台面積大於附屬建物面積，若已含在內不可能發生", ev
    if v_ident is None and v_ineq == "incl?":
        return "可能已含：附屬建物面積常與陽台面積相同，需人工抽查", ev
    return "無法判定：樣本不足或證據互相矛盾，需人工抽查", ev


def parking_verdict(merged):
    parts = []
    for kind in "ab":
        st = (merged.get(kind) or {}).get("parking")
        if st:
            parts.append(f"{KIND_NAMES[kind]} {pct(st['unpriced'], st['n'])}（{st['unpriced']:,}／{st['n']:,} 筆含車位的房屋交易）")
    return "；".join(parts) or "無法判定"


def unit_verdict(st):
    if not st or not st.get("available") or not st["n_priced"]:
        return "無法判定（缺欄位或沒有車位有拆價的樣本）"
    gross, net = st["m_gross"] / st["n_priced"], st["m_net"] / st["n_priced"]
    if net >= 0.8:
        txt = f"已扣車位：有拆價的 {st['n_priced']:,} 筆中 {net:.0%} 吻合（總價−車位價）÷（建物面積−車位面積）"
    elif gross >= 0.8:
        txt = f"未扣車位：{gross:.0%} 吻合 總價÷建物總面積"
    else:
        txt = f"算法不明：扣車位吻合 {net:.0%}、未扣吻合 {gross:.0%}"
    if st["n_unpriced"]:
        txt += (f"；車位未拆價的 {st['n_unpriced']:,} 筆：總價÷建物總面積 吻合 "
                f"{st['m_unpriced_gross'] / st['n_unpriced']:.0%}，總價÷（建物面積−車位面積） 吻合 "
                f"{st['m_unpriced_net'] / st['n_unpriced']:.0%}")
    return txt


def period_name(label):
    if label == "current":
        return "最新一期（本期）"
    if re.fullmatch(r"1\d{2}S[1-4]", label):
        return f"上一季（{label}）"
    return label


# ───────────────────────── 報告 ─────────────────────────

def md_table(head, rows):
    def esc(v):
        return str(v).replace("|", "｜").replace("\n", " ")

    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(esc(c) for c in r) + " |" for r in rows]
    return "\n".join(lines)


def render(mode, probe, downloads, periods, merged):
    L = []
    add = L.append
    env = "GitHub Actions（雲端，海外 IP）" if IN_ACTIONS else f"本機（{platform.system()}）"
    add("# 第一步報告：連線測試與資料檢查\n")
    add(f"- 產生時間：{dt.datetime.now(TZ):%Y-%m-%d %H:%M}（台灣時間）")
    add(f"- 執行環境：{env}，Python {platform.python_version()}")
    add("- 資料來源：內政部不動產成交案件實際資訊資料供應系統（政府資料開放授權條款－第1版）\n")

    # 一、結論
    add("## 一、結論\n")
    rows = []
    if mode == "online":
        rows.append(["連得到內政部網站嗎", conn_verdict(probe)])
        rows += [[d["label_zh"], dl_verdict(d)] for d in downloads]
    else:
        rows.append(["資料來源", "本機檔案（--local，未做連線測試）"])
    if periods:
        a_stats = merged.get("a") or {}
        rows.append(["陽台是否含在附屬建物（買賣表）", balcony_verdict(a_stats.get("balcony"))[0]])
        rows.append(["車位未拆價比例", parking_verdict(merged)])
        rows.append(["官方單價算法（買賣表）", unit_verdict(a_stats.get("unit"))])
    add(md_table(["問題", "結果"], rows) + "\n")
    if mode == "online" and not any(d["ok"] for d in downloads):
        add("> ⚠️ 沒有下載到資料。若這是 GitHub Actions 的結果，代表內政部網站擋了海外連線，"
            "資料更新要改在你的電腦上執行（見 README「在自己電腦上跑」）。\n")
    if not periods:
        return "\n".join(L)

    # 二、各檔筆數
    add("## 二、各檔筆數\n")
    rows = []
    for p in periods:
        for e in p["files"].values():
            a = e.get("analysis")
            rng = f"{a['date_min']}～{a['date_max']}" if a and a["date_min"] else ""
            rows.append([period_name(p["label"]), KIND_NAMES[e["kind"]] + SUB_NAMES[e["sub"]], f"{e['rows']:,}", rng])
    add(md_table(["期別", "檔案", "筆數", "交易日期範圍"], rows) + "\n")
    for p in periods:
        for e in p["files"].values():
            if e["bad_rows"]:
                add(f"- ⚠️ {period_name(p['label'])} {e['file']}：{e['bad_rows']:,} 列欄位數不符，已補齊或截斷")
            if not str(e["encoding"]).startswith("utf-8"):
                add(f"- {period_name(p['label'])} {e['file']} 編碼為 {e['encoding']}")
    latest = {}
    for p in periods:  # 第一個出現的期別（本期優先）當代表
        for key, e in p["files"].items():
            latest.setdefault(key, (p["label"], e))
    for kind in "ab":
        if f"{kind}_main" in latest:
            a = latest[f"{kind}_main"][1]["analysis"]
            add(f"- {KIND_NAMES[kind]}｜交易標的：" + "、".join(f"{k} {v:,}" for k, v in a["targets"].most_common(6)))
            add(f"- {KIND_NAMES[kind]}｜建物型態：" + "、".join(f"{k} {v:,}" for k, v in a["btypes"].most_common(8)))
    add("")

    # 三、欄位清單
    add("## 三、欄位清單\n")
    for kind in "abc":
        key = f"{kind}_main"
        if key not in latest:
            continue
        _, e = latest[key]
        add(f"### {KIND_NAMES[kind]}主表（{e['file']}，{e['encoding']}）\n")
        eng = e.get("english") or []
        for i, col in enumerate(e["columns"]):
            en = eng[i] if i < len(eng) else ""
            add(f"{i + 1}. {col}" + (f" — {en}" if en else ""))
        if not eng:
            add("\n（沒有英文欄名列）")
        miss = e["analysis"]["missing"]
        if miss:
            add(f"\n⚠️ 找不到預期欄位：{'、'.join(COL_LABELS[m] for m in miss)}")
        for p in periods:
            other = p["files"].get(key)
            if other and other is not e and other["columns"] != e["columns"]:
                plus = [x for x in other["columns"] if x not in e["columns"]]
                minus = [x for x in e["columns"] if x not in other["columns"]]
                diff = f"多 {'、'.join(plus) or '無'}；少 {'、'.join(minus) or '無'}" if plus or minus else "欄位相同但順序不同"
                add(f"\n⚠️ {period_name(p['label'])} 的欄位不同：{diff}")
        add("")
    add("### 明細檔\n")
    for kind in "abc":
        for sub in ("build", "land", "park"):
            if f"{kind}_{sub}" in latest:
                _, e = latest[f"{kind}_{sub}"]
                add(f"- {KIND_NAMES[kind]}{SUB_NAMES[sub]}（{e['file']}）：{'、'.join(e['columns'])}")
    add("")

    # 四、備註
    add("## 四、備註最常見的 20 種寫法（兩期合計）\n")
    for kind in "abc":
        st = (merged.get(kind) or {}).get("notes")
        if not st:
            continue
        add(f"### {KIND_NAMES[kind]}（{st['nonempty']:,}／{st['n']:,} 筆有備註）\n")
        top = st["exact"].most_common(20)
        add(md_table(["#", "備註原文", "筆數"], [[i, trunc(t, 80), f"{n:,}"] for i, (t, n) in enumerate(top, 1)])
            if top else "（沒有備註）")
        if kind in "ab" and st["segments"]:
            add("\n拆句後最常見的片語（用來訂特殊交易關鍵字）：\n")
            add(md_table(["#", "片語", "筆數"],
                         [[i, trunc(t, 60), f"{n:,}"] for i, (t, n) in enumerate(st["segments"].most_common(20), 1)]))
        add("")

    # 五、車位
    add("## 五、車位（兩期合計）\n")
    rows = []
    for kind in "ab":
        st = (merged.get(kind) or {}).get("parking")
        if st:
            rows.append([KIND_NAMES[kind], f"{st['n']:,}", f"{st['unpriced']:,}", pct(st["unpriced"], st["n"]), f"{st['noarea']:,}"])
    add(md_table(["表", "含車位的房屋交易", "車位價為 0", "未拆價比例", "車位面積為 0"], rows) + "\n")
    for kind in "ab":
        st = (merged.get(kind) or {}).get("parking")
        if not st or not st["n"]:
            continue
        add(f"{KIND_NAMES[kind]}依車位類別：\n")
        by = sorted(st["by_type"].items(), key=lambda kv: -kv[1][0])
        add(md_table(["車位類別", "筆數", "未拆價", "比例"], [[k, f"{v[0]:,}", f"{v[1]:,}", pct(v[1], v[0])] for k, v in by]) + "\n")
        if st["unpriced_notes"]:
            add("未拆價案件最常見的備註：\n")
            add("\n".join(f"- {trunc(t, 60)}（{n:,}）" for t, n in st["unpriced_notes"].most_common(5)) + "\n")
        if st["detail_checked"]:
            add(f"車位明細檔交叉檢查：未拆價的 {st['detail_checked']:,} 筆中，明細檔有個別車位價格的 "
                f"{st['detail_priced']:,} 筆（{pct(st['detail_priced'], st['detail_checked'])}）\n")

    # 六、陽台
    add("## 六、陽台是否含在附屬建物：判定依據（兩期合計）\n")
    for kind in "ab":
        st = (merged.get(kind) or {}).get("balcony")
        if st is None:
            continue
        v, ev = balcony_verdict(st)
        add(f"### {KIND_NAMES[kind]}\n")
        add(f"- 判定：{v}")
        add("\n".join(f"- {x}" for x in ev) + "\n")

    # 七、官方單價
    add("## 七、官方「單價元平方公尺」怎麼算（兩期合計）\n")
    for kind in "ab":
        st = (merged.get(kind) or {}).get("unit")
        if st is not None:
            add(f"- {KIND_NAMES[kind]}：{unit_verdict(st)}")
    add("")

    # 八、預售建案
    pre = (merged.get("b") or {}).get("presale")
    if pre:
        add("## 八、預售建案（兩期合計）\n")
        add(f"- 建案數：{len(pre['projects']):,}\n")
        add(md_table(["#", "建案名稱", "筆數"], [[i, k, f"{n:,}"] for i, (k, n) in enumerate(pre["projects"].most_common(15), 1)]) + "\n")
        add("Phase 2 驗收樣本預查（建案名稱含關鍵字）：\n")
        for k in WATCH_PROJECTS:
            hits = pre["watch"].get(k) or collections.Counter()
            names = "、".join(f"{n}（{c:,}）" for n, c in hits.most_common(5))
            add(f"- 「{k}」：{sum(hits.values()):,} 筆" + (f"｜{names}" if names else "｜這兩期沒有"))
        add(f"\n- 解約情形有填的：{sum(pre['cancel'].values()):,} 筆"
            + ("｜例：" + "、".join(f"{k}（{n}）" for k, n in pre["cancel"].most_common(5)) if pre["cancel"] else ""))
        if "b_main" in latest:
            ex = [x for x in latest["b_main"][1]["analysis"].get("unit_no_examples", []) if x]
            if ex:
                add(f"- 棟及號寫法範例：{'、'.join(ex)}")
        add("")

    # 九、樣本
    add("## 九、樣本（每檔 5 筆，平均取自檔案頭到尾）\n")
    for kind in "abc":
        key = f"{kind}_main"
        if key not in latest:
            continue
        label, e = latest[key]
        add(f"### {KIND_NAMES[kind]}（{period_name(label)}）\n")
        for i, s in enumerate(e["analysis"]["samples"], 1):
            add(f"**樣本 {i}**\n")
            add("\n".join(f"- {k}：{v}" for k, v in s.items()) + "\n")

    # 附錄
    if mode == "online":
        add("## 附錄：連線紀錄\n")
        rows = []
        for d in [probe] + downloads:
            rows.append([d.get("label_zh", ""), d["url"], d["status"] or "—", size_text(d.get("bytes")),
                         d["seconds"] if d["seconds"] is not None else "—", d["error"] or "—"])
        add(md_table(["項目", "網址", "HTTP", "大小", "秒", "錯誤"], rows) + "\n")
        if probe.get("link_patterns"):
            add("下載頁上找到的連結格式：\n")
            add("\n".join(f"- `{x}`" for x in probe["link_patterns"]) + "\n")
        if probe.get("seasons_on_page"):
            add("下載頁列出的季別：" + "、".join(probe["seasons_on_page"][:12]) + "\n")
        for d in [probe] + downloads:
            if d.get("snippet") and not d["ok"]:
                add(f"- {d.get('label_zh', '')} 回應內容開頭：{d['snippet']}")
    return "\n".join(L) + "\n"


# ───────────────────────── 主程式 ─────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="第一步：連線測試與桃園實價資料檢查")
    ap.add_argument("--local", nargs="+", metavar="路徑", help="改為分析本機的 zip 或資料夾（不連網）")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # Windows 終端機或被導向時預設不是 UTF-8，中文與符號會出錯
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    probe, downloads, period_files = None, [], []
    if args.local:
        mode = "local"
        period_files = collect_local(args.local)
    else:
        mode = "online"
        print(f"連線測試：{PAGE_URL}")
        probe = probe_page()
        print(f"  → {conn_verdict(probe)}")

        info, path = download_zip(CURRENT_URL, "current")
        info["label_zh"] = "下載最新一期（本期）"
        downloads.append(info)
        if path:
            files, names = extract_city(path, "current")
            info["city_files"] = sum(1 for f in files if f.name.lower().startswith(CITY_PREFIX))
            info["zip_members"] = len(names)
            period_files.append(("current", files))
        print(f"  本期 → {dl_verdict(info)}")

        dead = (not probe["ok"] and probe["status"] is None) and (not info["ok"] and info["status"] is None)
        computed = recent_seasons(dt.datetime.now(TZ).date(), 2)
        on_page = [s for s in probe["seasons_on_page"] if skey(s) <= skey(computed[0])]
        for season in sorted(set(on_page[:2] + computed), key=skey, reverse=True)[:3]:
            if dead:
                downloads.append({"url": SEASON_URL.format(season=season), "ok": False, "status": None,
                                  "bytes": 0, "seconds": None, "error": None, "skipped": True,
                                  "label_zh": f"下載上一季（{season}）"})
                break
            info, path = download_zip(SEASON_URL.format(season=season), season)
            info["label_zh"] = f"下載上一季（{season}）"
            downloads.append(info)
            if path:
                files, names = extract_city(path, season)
                info["city_files"] = sum(1 for f in files if f.name.lower().startswith(CITY_PREFIX))
                info["zip_members"] = len(names)
                period_files.append((season, files))
            print(f"  {season} → {dl_verdict(info)}")
            if path:
                break

    periods = [analyze_period(label, files) for label, files in period_files]
    merged = merged_stats(periods)
    report = render(mode, probe, downloads, periods, merged)
    (REPORT_DIR / "step1_report.md").write_text(report, encoding="utf-8")

    a_stats = merged.get("a") or {}
    summary = {
        "generated_at": dt.datetime.now(TZ).isoformat(timespec="seconds"),
        "environment": "github-actions" if IN_ACTIONS else "local",
        "mode": mode,
        "probe": probe,
        "downloads": downloads,
        "working_urls": [d["url"] for d in downloads if d["ok"]],
        "periods": {p["label"]: {k: {"file": e["file"], "rows": e["rows"], "columns": e["columns"]}
                                 for k, e in p["files"].items()} for p in periods},
        "conclusions": {
            "connectivity": conn_verdict(probe) if probe else None,
            "balcony": balcony_verdict(a_stats.get("balcony"))[0] if periods else None,
            "parking_unpriced": parking_verdict(merged) if periods else None,
            "unit_price": unit_verdict(a_stats.get("unit")) if periods else None,
        },
    }
    (REPORT_DIR / "step1_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    print("\n".join(f"{k}: {v}" for k, v in summary["conclusions"].items() if v))
    print(f"報告：{REPORT_DIR / 'step1_report.md'}")
    if mode == "online" and IN_ACTIONS and not any(d["ok"] for d in downloads):
        print("::error::GitHub Actions 下載不到內政部資料，詳見執行摘要（Summary）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
