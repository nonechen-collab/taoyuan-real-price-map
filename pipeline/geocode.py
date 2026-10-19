"""地理編碼：桃園市門牌坐標（離線）為主，預售建案再用交叉口推算與 OpenStreetMap 補。

結果寫入 data/geocode_cache.csv（只新增、不改寫），成功的永不重查；
失敗的記下門牌資料月份，等門牌資料更新到新月份才重試（新建案的門牌會晚幾個月才編好）。
"""

import collections
import concurrent.futures
import csv
import json
import math
import os
import re
import statistics
import time
import urllib.parse

from . import clean, config, net
from .doorplate import DoorPlates, twd97_to_wgs84

LEVELS = {1: "門牌", 2: "鄰近門牌", 3: "交叉口", 4: "巷弄", 5: "路段", 9: "未定位"}
APPROX = {4, 5}  # 前端標「概略位置」
FIELDS = ["鍵", "緯度", "經度", "精度", "來源", "門牌資料月份", "日期", "對應門牌", "版本"]
VERSION = "2"  # 比對規則改進時加 1：之前失敗（精度 9）的地址會重比
# 主站優先，失敗（逾時、5xx）才換鏡像站
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
MAX_OSM_PER_RUN = int(os.environ.get("OSM_LIMIT", "40"))
OSM_WALL_SEC = 30  # 單次查詢最多等幾秒
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="osm")
OSM_BUDGET_SEC = int(os.environ.get("OSM_BUDGET", "120"))  # 每次執行 OSM 最多花的總時間（Overpass 偶爾很慢，不能拖住排程）
_CN = "零一二三四五六七八九"


def building_cache_key(p):
    return "B|" + clean.building_key(p)


def address_cache_key(addr, district):
    return f"A|{district}|{clean.norm_text(addr)}"


class Cache:
    def __init__(self, path=config.GEOCODE_CACHE):
        self.path = path
        self.rows = collections.defaultdict(list)
        if path.exists():
            with open(path, encoding="utf-8-sig", newline="") as f:
                for r in csv.DictReader(f):
                    self.rows[r["鍵"]].append(r)
        self.pending = []

    def best(self, key):
        """同一鍵多筆時取精度最好、其次最新的一筆"""
        rows = self.rows.get(key)
        if not rows:
            return None
        return min(rows, key=lambda r: (int(r["精度"]), [-ord(c) for c in r["日期"]]))

    def needs(self, key, doorplate_month):
        b = self.best(key)
        if b is None:
            return True
        return int(b["精度"]) == 9 and ((b["門牌資料月份"] or "") < (doorplate_month or "") or (b.get("版本") or "1") != VERSION)

    def add(self, key, res, month):
        row = {"鍵": key, "緯度": res.get("lat") or "", "經度": res.get("lon") or "", "精度": res["level"],
               "來源": res.get("source", ""), "門牌資料月份": month or "",
               "日期": config.now_tw().strftime("%Y-%m-%d"), "對應門牌": res.get("matched", ""), "版本": VERSION}
        row = {k: str(v) for k, v in row.items()}
        self.rows[key].append(row)
        self.pending.append(row)

    def save(self):
        if not self.pending:
            return 0
        new = not self.path.exists()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
            if new:
                w.writeheader()
            w.writerows(self.pending)
        n = len(self.pending)
        self.pending = []
        return n


def _ll(xy):
    return twd97_to_wgs84(*xy)


def _center(pts):
    return statistics.median(p[0] for p in pts), statistics.median(p[1] for p in pts)


def _digit_section(road):
    """'中正路2段' → '中正路二段'"""
    return re.sub(r"(\d)段", lambda m: _CN[int(m.group(1))] + "段", road)


_NAMED_LANE = re.compile(r"^(.+?(?:路|街|大道)(?:[一二三四五六七八九十]+段)?(?:\D{1,3}段)?)(\D{1,3}巷)$")


def geocode_building(dp: DoorPlates, p):
    d = p["district"]
    road = dp.resolve_road(d, [p["road"], p["road_no_village"], _digit_section(p["road_no_village"])])
    if not road and not p["lane"]:
        # 有名字的巷子（例如「中豐路山頂段興峰巷」）：門牌資料把「興峰巷」放在巷欄
        m = _NAMED_LANE.match(p["road_no_village"])
        if m:
            road = dp.resolve_road(d, [m.group(1), _digit_section(m.group(1))])
            if road:
                p = {**p, "lane": m.group(2)}
    if not road:
        return {"level": 9, "source": "找不到路名"}
    alley = p["alley"] + p["xiang"]
    k = (d, road, p["lane"], alley, p["no"])
    matched = "|".join(k)
    if k in dp.bld:
        return _res(dp.bld[k], 1, f"門牌坐標{dp.label}", matched)
    nums = dp.lane_nums.get(k[:4])
    n = int(p["no"].split("之")[0])
    if nums:
        same = [t for t in nums if t[0] % 2 == n % 2] or nums  # 台灣門牌單雙號分邊
        gap, key = min((abs(t[0] - n), t[1]) for t in same)
        if gap <= 10:
            return _res(dp.bld[key], 2, f"門牌坐標{dp.label}", "|".join(key))
        return _res(dp.bld[key], 4, f"門牌坐標{dp.label}", "|".join(key))
    if p["lane"]:
        pts = dp.road_points(d, road, p["lane"])
        if pts:
            return _res(_center(pts), 4, f"門牌推算{dp.label}", f"{d}|{road}|{p['lane']}")
    pts = dp.road_points(d, road)
    if pts:
        return _res(_center(pts), 5, f"門牌推算{dp.label}", f"{d}|{road}")
    return {"level": 9, "source": "找不到門牌"}


def _res(xy, level, source, matched):
    lat, lon = _ll(xy)
    return {"lat": lat, "lon": lon, "level": level, "source": source, "matched": matched, "xy": xy}


# ───────────────────────── 預售建案 ─────────────────────────

_ROADISH = re.compile(r"^(?P<road>\D+?(?:路|街|大道|巷)(?:[一二三四五六七八九十]+段)?(?:\d+巷)?)")


def _split_lane(text):
    m = re.match(r"^(.+?)(\d+巷)$", text)
    return (m.group(1), m.group(2)) if m else (text, None)


def _road_pts(dp, d, text):
    base, lane = _split_lane(text)
    road = dp.resolve_road(d, [base, _digit_section(base)])
    if not road:
        # 沒寫段：合併該路所有段
        cands = [r for r in dp.roads.get(d, ()) if re.sub(r"[一二三四五六七八九十]+段$", "", r) == base]
        pts = [p for r in cands for p in dp.road_points(d, r, lane)]
        return pts, (cands[0] if cands else None)
    return dp.road_points(d, road, lane), road


def _nearest_pair(A, B, cell=100):
    grid = collections.defaultdict(list)
    for q in B:
        grid[(int(q[0] // cell), int(q[1] // cell))].append(q)
    best = (float("inf"), None)
    for p in A:
        cx, cy = int(p[0] // cell), int(p[1] // cell)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for q in grid.get((cx + i, cy + j), ()):
                    dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2
                    if dd < best[0]:
                        best = (dd, ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2))
    return (math.sqrt(best[0]), best[1]) if best[1] else (None, None)


class OSM:
    """OpenStreetMap Overpass：門牌資料沒有的新路。結果 © OpenStreetMap 貢獻者（ODbL）"""

    def __init__(self, limit=MAX_OSM_PER_RUN, budget=OSM_BUDGET_SEC, log=None):
        self.left = limit
        self.used = 0
        self.spent = 0.0
        self.budget = budget
        self.log = log or (lambda *_: None)
        self.skipped = False  # 本筆是否因額度用完而沒查 OSM

    def _query(self, q):
        if self.left <= 0 or self.spent >= self.budget:
            self.skipped = True
            return None
        self.left -= 1
        self.used += 1
        for url in OVERPASS:
            # Overpass 滿載時會讓請求排隊、連線不斷，socket 逾時擋不住：用另一個執行緒限制總等待時間
            t0 = time.monotonic()
            fut = _POOL.submit(net.fetch, url, data=urllib.parse.urlencode({"data": q}).encode(),
                               timeout=25, delay=2, retries=0, headers=net.API_HEADERS)
            try:
                info, body = fut.result(timeout=OSM_WALL_SEC)
            except concurrent.futures.TimeoutError:
                info, body = {"ok": False, "error": f"超過 {OSM_WALL_SEC} 秒未回應"}, None
            self.spent += time.monotonic() - t0
            if info["ok"]:
                break
            self.log(f"    OSM 查詢失敗（{url.split('/')[2]}）：{info.get('error')}")
            if self.spent >= self.budget:
                return None
        else:
            return None
        try:
            return json.loads(body).get("elements", [])
        except ValueError:
            return None

    def intersection(self, bbox, a, b):
        """bbox：(南, 西, 北, 東)。用經緯度方框查比用行政區範圍快很多"""
        q = (f'[out:json][timeout:25][bbox:{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}];'
             f'way["highway"]["name"="{a}"]->.a;way["highway"]["name"="{b}"]->.b;'
             f'node(w.a)->.na;node(w.b)->.nb;node.na.nb;out;')
        els = self._query(q)
        if els:
            return statistics.median(e["lat"] for e in els), statistics.median(e["lon"] for e in els)
        return None

    def road_center(self, bbox, a):
        q = (f'[out:json][timeout:25][bbox:{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}];'
             f'way["highway"]["name"="{a}"];out center;')
        els = self._query(q)
        if els:
            return (statistics.median(e["center"]["lat"] for e in els),
                    statistics.median(e["center"]["lon"] for e in els))
        return None


def _bbox_ll(dp, district):
    """門牌資料算出的行政區範圍（TWD97）→ (南, 西, 北, 東) 經緯度"""
    b = dp.bbox.get(district)
    if not b:
        return (24.58, 120.98, 25.13, 121.52)
    s, w = twd97_to_wgs84(b[0], b[1])
    n, e = twd97_to_wgs84(b[2], b[3])
    return (round(s, 4), round(w, 4), round(n, 4), round(e, 4))


def geocode_presale(dp: DoorPlates, addr, district, osm: OSM):
    s = re.sub(r"^(桃園市|桃園縣)", "", clean.norm_text(addr))
    s = _strip_village(dp, district, re.sub("^" + re.escape(district), "", s))
    # 1) 門牌號（含「號旁」「對面」「附近」）
    p = clean.parse_address(s, district)
    if p:
        r = geocode_building(dp, p)
        if r["level"] == 1 and re.search(r"號(旁|對面|附近|鄰)", s):
            r["level"] = 2
        if r["level"] <= 4:
            return r
    # 2) A 路與 B 路交叉口
    m = re.match(r"^(?P<a>.+?)(?:與|和|及|、|/|跟)(?P<b>.+?)(?:交叉口|交岔口|交界|路口|口)", s)
    if m:
        a, b = m.group("a"), re.sub(r"(附近|旁)$", "", m.group("b"))
        A, ra = _road_pts(dp, district, a)
        B, rb = _road_pts(dp, district, b)
        if A and B:
            dist, mid = _nearest_pair(A, B)
            if dist is not None and dist <= 150:
                return _res(mid, 3, f"門牌推算{dp.label}", f"{district}|{ra}×{rb}")
        ll = osm.intersection(_bbox_ll(dp, district), a, b)
        if ll and _in_taoyuan(ll):
            return {"lat": round(ll[0], 6), "lon": round(ll[1], 6), "level": 3, "source": "OSM", "matched": f"{a}×{b}"}
        for pts, rd in ((A, ra), (B, rb)):
            if pts:
                return _res(_center(pts), 5, f"門牌推算{dp.label}", f"{district}|{rd}")
    # 3) 只有路名（或路名＋巷）
    m = _ROADISH.match(s)
    if m:
        text = m.group("road")
        pts, rd = _road_pts(dp, district, text)
        if pts:
            return _res(_center(pts), 4 if re.search(r"\d+巷$", text) else 5, f"門牌推算{dp.label}", f"{district}|{rd}")
        ll = osm.road_center(_bbox_ll(dp, district), _split_lane(text)[0])
        if ll and _in_taoyuan(ll):
            return {"lat": round(ll[0], 6), "lon": round(ll[1], 6), "level": 5, "source": "OSM", "matched": text}
    return {"level": 9, "source": "無法解析地址"}


def _strip_village(dp, district, s):
    """去掉開頭的「XX里3鄰」，但只在剩下的字串以已知路名開頭時才去（避免把「萬里路」切掉）"""
    m = re.match(r"^\D{1,4}?[里村](?:\d+鄰)?", s)
    if m:
        rest = s[m.end():]
        if any(rest.startswith(r) for r in dp.roads.get(district, ())):
            return rest
    return s


def _in_taoyuan(ll):
    return 24.58 <= ll[0] <= 25.13 and 120.98 <= ll[1] <= 121.52


# ───────────────────────── 整批 ─────────────────────────


def run(buildings, presale_addrs, log=print):
    """buildings：{快取鍵: parse_address 結果}；presale_addrs：{快取鍵: (地址, 區)}
    回傳 (results {快取鍵: 快取列}, 統計)"""
    cache = Cache()
    stats = {"cached": 0, "new": 0, "osm": 0, "osm_deferred": 0, "doorplate_month": None}
    temp = {}
    todo_b = {k: p for k, p in buildings.items() if cache.best(k) is None or int(cache.best(k)["精度"]) == 9}
    todo_a = {k: v for k, v in presale_addrs.items() if cache.best(k) is None or int(cache.best(k)["精度"]) == 9}
    if todo_b or todo_a:
        try:
            month, path = _doorplate()
        except Exception as e:  # 海外 IP 被擋等情況：這次先不定位新地址，下次再試
            log(f"  ⚠ 取不到門牌坐標資料（{e}），新地址這次先不定位")
            stats["doorplate_error"] = str(e)
            stats["new"] += cache.save()
            keys = list(buildings) + list(presale_addrs)
            return {k: cache.best(k) for k in keys}, stats
        stats["doorplate_month"] = month
        todo_b = {k: p for k, p in todo_b.items() if cache.needs(k, month)}
        todo_a = {k: v for k, v in todo_a.items() if cache.needs(k, month)}
        if todo_b or todo_a:
            log(f"  載入門牌坐標 {month}（待定位：棟 {len(todo_b):,}、預售地址 {len(todo_a):,}）")
            dp = DoorPlates(path, month)
            osm = OSM(log=log)
            log("  門牌索引完成，開始比對")
            for n, (k, p) in enumerate(todo_b.items(), 1):
                cache.add(k, geocode_building(dp, p), month)
                if n % 5000 == 0:
                    log(f"    棟 {n:,}／{len(todo_b):,}")
            stats["new"] += cache.save()
            for n, (k, (addr, d)) in enumerate(todo_a.items(), 1):
                osm.skipped = False
                res = geocode_presale(dp, addr, d, osm)
                if osm.skipped and res["level"] >= 5:
                    temp[k] = _as_row(k, res, month)  # 這次先用，不寫快取，下次再查 OSM
                    stats["osm_deferred"] += 1
                else:
                    cache.add(k, res, month)
                if n % 500 == 0:
                    log(f"    預售地址 {n:,}／{len(todo_a):,}（OSM 已查 {osm.used} 次）")
            stats["osm"] = osm.used
    stats["new"] += cache.save()
    keys = list(buildings) + list(presale_addrs)
    stats["cached"] = len(keys) - stats["new"]
    return {k: temp.get(k) or cache.best(k) for k in keys}, stats


def _as_row(key, res, month):
    return {"鍵": key, "緯度": str(res.get("lat") or ""), "經度": str(res.get("lon") or ""), "精度": str(res["level"]),
            "來源": res.get("source", ""), "門牌資料月份": month or "", "日期": "", "對應門牌": res.get("matched", "")}


def _doorplate():
    from . import doorplate
    return doorplate.ensure_latest()
