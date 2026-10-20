"""下載內政部實價登錄開放資料，只保留桃園（H）檔，每期存成 data/periods/<期別>.zip。

期別命名
  season-115S3     季檔（DownloadSeason）
  issue-1150930    本期／前期檔，以「買賣登記迄日（民國）」命名，內容相同就同名

已存在的期別不重抓、不改寫（repo 不會因為重跑而膨脹）。

用法
  python -m pipeline.periods update                 抓本期＋前期，並補最近結束、尚未存檔的季
  python -m pipeline.periods backfill 112S3 115S2   補抓一段季檔
  python -m pipeline.periods import 檔案.zip ...      匯入手動下載的全國 zip
"""

import argparse
import datetime as dt
import io
import re
import sys
import zipfile
from pathlib import Path

from . import config, net

BASE = "https://plvr.land.moi.gov.tw"
CURRENT_URL = BASE + "/Download?type=zip&fileName=lvr_landcsv.zip"
PREV_LIST_URL = BASE + "/DownloadHistory_ajax_list"
PREV_URL = BASE + "/DownloadHistory?type=history&fileName={date}"
SEASON_URL = BASE + "/DownloadSeason?season={season}&type=zip&fileName=lvr_landcsv.zip"
CITY_FILE = re.compile(r"^h_lvr_land_[abc](?:_(?:build|land|park))?\.csv$")
FIXED_TIME = (2000, 1, 1, 0, 0, 0)  # zip 內固定時間，同內容產生同樣的檔


def roc_ymd(s):
    """'115年9月30日' → 1150930"""
    m = re.search(r"(\d{2,3})年\s*(\d{1,2})月\s*(\d{1,2})日", s)
    return int(f"{int(m.group(1))}{int(m.group(2)):02d}{int(m.group(3)):02d}") if m else None


def parse_build_time(text):
    """build_time.xml 的資料內容說明 → 買賣登記起迄、預售交易起迄（民國 yyymmdd）"""
    out = {"text": re.sub(r"<[^>]+>|\s+", " ", text).strip()}
    m = re.search(r"登記日期\s*(?:自\s*)?(.+?日)\s*至\s*(.+?日)之買賣", text)
    if m:
        out["sale_from"], out["sale_to"] = roc_ymd(m.group(1)), roc_ymd(m.group(2))
    m = re.search(r"交易日期\s*(.+?日)\s*至\s*(.+?日)之預售屋", text)
    if m:
        out["presale_from"], out["presale_to"] = roc_ymd(m.group(1)), roc_ymd(m.group(2))
    return out


def season_key(code):
    y, s = code.split("S")
    return int(y), int(s)


def recent_ended_seasons(today, n=2):
    """最近已結束的 n 個季別，例如 2026-10-18 → ['115S3', '115S2']"""
    y, s = today.year - 1911, (today.month - 1) // 3
    out = []
    while len(out) < n:
        if s == 0:
            y, s = y - 1, 4
        out.append(f"{y}S{s}")
        s -= 1
    return out


def season_range(a, b):
    y, s = season_key(a)
    out = []
    while (y, s) <= season_key(b):
        out.append(f"{y}S{s}")
        y, s = (y + 1, 1) if s == 4 else (y, s + 1)
    return out


def store(src_zip, kind, season=None):
    """把全國 zip 裡的桃園檔另存成 data/periods/<name>.zip；已存在就略過。回傳 (name, 是否新存)"""
    with zipfile.ZipFile(src_zip) as zf:
        names = {n.replace("\\", "/").rsplit("/", 1)[-1].lower(): n for n in zf.namelist()}
        bt = parse_build_time(zf.read(names["build_time.xml"]).decode("utf-8", "replace")) \
            if "build_time.xml" in names else {}
        if kind == "season":
            name = f"season-{season}"
        else:
            if not bt.get("sale_to"):
                raise ValueError("本期／前期 zip 缺 build_time.xml，無法判斷期別")
            name = f"issue-{bt['sale_to']}"
        dest = config.PERIODS_DIR / f"{name}.zip"
        if dest.exists():
            return name, False
        city = sorted(k for k in names if CITY_FILE.match(k))
        main = [k for k in city if k in ("h_lvr_land_a.csv", "h_lvr_land_b.csv")]
        rows = sum(max(0, zf.read(names[k]).count(b"\n") - 2) for k in main)
        if kind == "season" and rows == 0:
            return None, False  # 空季：實價登錄 2012/8 才開始，101S1–101S3 只有欄位說明
        if "h_lvr_land_a.csv" not in city:
            raise ValueError("zip 內找不到桃園買賣檔（h_lvr_land_a.csv）")
        config.PERIODS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for k in city + (["build_time.xml"] if "build_time.xml" in names else []):
                info = zipfile.ZipInfo(k, FIXED_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(info, zf.read(names[k]))
        tmp.replace(dest)
        return name, True


def _download(url, label):
    dest = config.RAW_DIR / "_downloads" / f"{label}.zip"
    info, _ = net.fetch(url, dest=dest)
    if info["ok"]:
        with open(dest, "rb") as f:
            if f.read(2) != b"PK":
                info.update(ok=False, error="回傳的不是 zip 檔（可能是查無檔案的錯誤頁）")
    if not info["ok"] and dest.exists():
        dest.unlink()
    return info, (dest if info["ok"] else None)


def previous_issue_date():
    info, body = net.fetch(PREV_LIST_URL, timeout=60, max_bytes=5 * 1024 * 1024)
    m = re.search(r"downloadLast\('(\d{8})'\)", (body or b"").decode("utf-8", "replace"))
    return (m.group(1) if m else None), info


def list_periods():
    """已存的期別，依資料新舊排序（同一迄日時季檔排後面，視為較新的整理版）"""
    out = []
    for p in sorted(config.PERIODS_DIR.glob("*.zip")):
        with zipfile.ZipFile(p) as zf:
            bt = parse_build_time(zf.read("build_time.xml").decode("utf-8", "replace")) \
                if "build_time.xml" in zf.namelist() else {}
        name = p.stem
        if name.startswith("season-") and not bt.get("sale_to"):
            y, s = season_key(name[7:])
            bt["sale_to"] = int(f"{y}{s * 3:02d}10")
        out.append({"name": name, "path": p, "kind": name.split("-")[0], **bt})
    out.sort(key=lambda r: (r.get("sale_to") or 0, r["kind"] == "season"))
    return out


def update(today=None, seasons_to_check=1):
    """排程用：本期＋前期，加上最近結束但還沒存的季。回傳每個動作的紀錄。"""
    today = today or config.now_tw().date()
    log = []
    info, path = _download(CURRENT_URL, "current")
    log.append(_record("本期", info, path, "issue"))
    date, pinfo = previous_issue_date()
    if date:
        info, path = _download(PREV_URL.format(date=date), f"prev-{date}")
        log.append(_record(f"前期（{date} 發布）", info, path, "issue"))
    else:
        log.append({"label": "前期", "ok": False, "error": pinfo.get("error") or "找不到前期下載連結"})
    have = {p["name"] for p in list_periods()}
    for season in recent_ended_seasons(today, seasons_to_check):
        if f"season-{season}" in have:
            continue
        info, path = _download(SEASON_URL.format(season=season), season)
        rec = _record(f"季 {season}", info, path, "season", season)
        if not info["ok"] and "不是 zip" in (info.get("error") or ""):
            rec.update(ok=True, note="季檔尚未發布", new=False)
        log.append(rec)
    return log


def backfill(first, last):
    have = {p["name"] for p in list_periods()}
    log = []
    for season in season_range(first, last):
        if f"season-{season}" in have:
            log.append({"label": f"季 {season}", "ok": True, "new": False, "note": "已存在"})
            continue
        info, path = _download(SEASON_URL.format(season=season), season)
        log.append(_record(f"季 {season}", info, path, "season", season))
        print(_fmt(log[-1]), flush=True)
    return log


def _record(label, info, path, kind, season=None):
    rec = {"label": label, "ok": info["ok"], "error": info.get("error"), "bytes": info.get("bytes"),
           "seconds": info.get("seconds"), "blocked": info.get("blocked"), "new": False}
    if path:
        try:
            rec["name"], rec["new"] = store(path, kind, season)
            if rec["name"] is None:
                rec["note"] = "空季（沒有桃園資料，略過）"
        except (ValueError, zipfile.BadZipFile, KeyError) as e:
            rec.update(ok=False, error=f"存檔失敗：{e}")
    return rec


def _fmt(r):
    if not r["ok"]:
        return f"  ❌ {r['label']}：{r.get('error')}"
    extra = r.get("note") or ("新存 " + r["name"] if r.get("new") else f"已有 {r.get('name', '')}")
    return f"  ✅ {r['label']}：{extra}"


def main(argv=None):
    config.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("update")
    b = sub.add_parser("backfill")
    b.add_argument("first")
    b.add_argument("last")
    i = sub.add_parser("import")
    i.add_argument("zips", nargs="+")
    i.add_argument("--season", help="匯入的是季檔時填季別，例如 115S3")
    args = ap.parse_args(argv)
    if args.cmd == "update":
        log = update()
        for r in log:
            print(_fmt(r))
        return 0 if all(r["ok"] for r in log) else 1
    if args.cmd == "backfill":
        log = backfill(args.first, args.last)
        return 0 if all(r["ok"] for r in log) else 1
    for z in args.zips:
        name, new = store(Path(z), "season" if args.season else "issue", args.season)
        print(f"  {'新存' if new else '已有'} {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
