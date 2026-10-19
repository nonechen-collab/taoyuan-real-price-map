"""推定社區（開放資料沒有社區名）。

規則（SPEC）：同一棟級門牌即同社區；不同門牌但距離 ≤ 80 m、建築完成年月與總樓層數都相同者合併。
預售屋以建案名稱為單位。可用 data/manual/communities.csv 手動合併／拆分：
  欄位：門牌鍵,社區代號,社區名稱    （門牌鍵見前端成交卡片「原始欄位」）
"""

import collections
import csv
import hashlib
import math

from . import config

MERGE_M = 80
MANUAL = config.MANUAL_DIR / "communities.csv"


def _id(prefix, text):
    return prefix + hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


def _xy(lat, lon):
    """經緯度 → 近似公尺（桃園範圍內誤差可忽略）"""
    return lon * 111320 * math.cos(math.radians(24.95)), lat * 110574


class _UF:
    def __init__(self):
        self.p = {}

    def find(self, a):
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def load_manual(path=MANUAL):
    out = {}
    if path.exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("門牌鍵") and r.get("社區代號"):
                    out[r["門牌鍵"].strip()] = (r["社區代號"].strip(), (r.get("社區名稱") or "").strip())
    return out


def _label(bkey):
    d, road, lane, alley, no = bkey.split("|")
    return f"{road}{lane}{alley}{no}號"


def infer(buildings, manual=None):
    """buildings：{門牌鍵: {"lat", "lon", "built": 'YYYY-MM', "floors": int, "district"}}
    回傳 ({門牌鍵: 社區代號}, {社區代號: 社區資訊})"""
    manual = load_manual() if manual is None else manual
    uf = _UF()
    grid = collections.defaultdict(list)
    for k, b in buildings.items():
        uf.find(k)
        if b.get("lat") is None or b.get("approx"):
            continue
        x, y = _xy(b["lat"], b["lon"])
        b["_xy"] = (x, y)
        grid[(int(x // MERGE_M), int(y // MERGE_M))].append(k)
    for (cx, cy), keys in grid.items():
        near = [k2 for i in (-1, 0, 1) for j in (-1, 0, 1) for k2 in grid.get((cx + i, cy + j), ())]
        for k in keys:
            a = buildings[k]
            if "_xy" not in a or not (a.get("built") and a.get("floors")):
                continue
            for k2 in near:
                if k2 <= k:
                    continue
                b = buildings[k2]
                if "_xy" in b and (b.get("built") == a["built"] and b.get("floors") == a["floors"]
                        and math.dist(a["_xy"], b["_xy"]) <= MERGE_M):
                    uf.union(k, k2)
    groups = collections.defaultdict(list)
    for k in buildings:
        if k in manual:
            groups["manual:" + manual[k][0]].append(k)
        else:
            groups[uf.find(k)].append(k)
    assign, info = {}, {}
    for g, keys in groups.items():
        keys.sort()
        if g.startswith("manual:"):
            cid = "m" + g[7:]
            name = manual[keys[0]][1] or _label(keys[0])
        else:
            cid = _id("c", keys[0])
            name = _label(keys[0]) + (f"等 {len(keys)} 棟" if len(keys) > 1 else "")
        pts = [buildings[k] for k in keys if buildings[k].get("lat") is not None]
        info[cid] = {
            "id": cid, "name": name, "district": buildings[keys[0]]["district"], "buildings": len(keys),
            "lat": round(sum(p["lat"] for p in pts) / len(pts), 6) if pts else None,
            "lon": round(sum(p["lon"] for p in pts) / len(pts), 6) if pts else None,
            "built": buildings[keys[0]].get("built"), "floors": buildings[keys[0]].get("floors"),
        }
        for k in keys:
            assign[k] = cid
    return assign, info


def project_id(district, name):
    return _id("p", f"{district}|{name}")
