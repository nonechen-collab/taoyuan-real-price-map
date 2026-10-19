"""路徑與共用常數"""

import datetime as dt
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PERIODS_DIR = DATA / "periods"          # 每期桃園原始檔一個 zip（只新增、不改寫）
CACHE_DIR = DATA / "cache"
GEOCODE_CACHE = DATA / "geocode_cache.csv"  # 定位結果（只新增、不改寫）
MANUAL_DIR = DATA / "manual"            # 手動修正（社區合併／拆分、建案位置）
RAW_DIR = DATA / "raw"                  # 暫存下載檔（不進 repo）
OUT_DIR = ROOT / "web" / "public" / "data"  # 前端資料（建置時產生，不進 repo）
REPORT_DIR = ROOT / "reports"

TZ = dt.timezone(dt.timedelta(hours=8))
IN_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"
RECENT_YEARS = 3  # 前端預設資料範圍

# 桃園市 13 區（門牌坐標資料的鄉鎮市區代碼）
DISTRICTS = {
    "6800100": "桃園區", "6800200": "中壢區", "6800300": "大溪區", "6800400": "楊梅區",
    "6800500": "蘆竹區", "6800600": "大園區", "6800700": "龜山區", "6800800": "八德區",
    "6800900": "龍潭區", "6801000": "平鎮區", "6801100": "新屋區", "6801200": "觀音區",
    "6801300": "復興區",
}
DISTRICT_CODE = {v: k for k, v in DISTRICTS.items()}


def utf8_stdout():
    """Windows 終端機預設不是 UTF-8，中文會變亂碼"""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def now_tw():
    return dt.datetime.now(TZ)
