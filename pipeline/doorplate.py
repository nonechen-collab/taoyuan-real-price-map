"""桃園市門牌位置坐標（民政局開放資料，每月更新）：下載、建索引、TWD97 → WGS84。

資料集：https://data.gov.tw/dataset/157689 （政府資料開放授權條款－第1版）
注意：坐標由戶政事務所人工套圖標點，官方註明可能有誤差，僅供參考。
"""

import collections
import csv
import json
import math
import re
import statistics

from . import config, net

DATASET_API = "https://data.gov.tw/api/v2/rest/dataset/157689"
DIR = config.RAW_DIR / "doorplate"
_NO = re.compile(r"^(\d+衖)?(\d+(?:之\d+)?)號")  # 衖寫在號欄，例如「9衖2號」
_FW = str.maketrans("０１２３４５６７８９", "0123456789")


def twd97_to_wgs84(x, y):
    """TWD97 二度分帶（中央經線 121°、尺度 0.9999、東偏 250 km）→ (lat, lon)"""
    a, b = 6378137.0, 6356752.314245
    lon0, k0 = math.radians(121), 0.9999
    e = math.sqrt(1 - (b / a) ** 2)
    x -= 250000
    mu = (y / k0) / (a * (1 - e**2 / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    e1 = (1 - math.sqrt(1 - e**2)) / (1 + math.sqrt(1 - e**2))
    fp = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
          + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
          + (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu))
    e2 = e**2 / (1 - e**2)
    c1, t1 = e2 * math.cos(fp) ** 2, math.tan(fp) ** 2
    r1 = a * (1 - e**2) / (1 - e**2 * math.sin(fp) ** 2) ** 1.5
    n1 = a / math.sqrt(1 - e**2 * math.sin(fp) ** 2)
    d = x / (n1 * k0)
    lat = fp - (n1 * math.tan(fp) / r1) * (
        d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * e2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * e2 - 3 * c1**2) * d**6 / 720)
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d**3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * e2 + 24 * t1**2) * d**5 / 120) / math.cos(fp)
    return round(math.degrees(lat), 6), round(math.degrees(lon), 6)


def latest_resource():
    """回傳 (月份標籤 '11509', 下載網址)；查不到回傳 (None, None)"""
    info, body = net.fetch(DATASET_API, timeout=60, max_bytes=20 * 1024 * 1024, delay=2)
    if not info["ok"]:
        return None, None
    best = None
    for d in json.loads(body).get("result", {}).get("distribution", []):
        m = re.search(r"(\d{3})年0?(\d{1,2})月", d.get("resourceDescription", ""))
        if m and d.get("resourceDownloadUrl"):
            label = f"{m.group(1)}{int(m.group(2)):02d}"
            if best is None or label > best[0]:
                best = (label, d["resourceDownloadUrl"])
    return best or (None, None)


def ensure_latest():
    """確保有最新月份的門牌檔，回傳 (月份標籤, 路徑)。下載失敗時退回已有的最新檔。"""
    label, url = latest_resource()
    if label:
        path = DIR / f"tycg_doorplate_{label}.csv"
        if not path.exists():
            info, _ = net.fetch(url, dest=path.with_suffix(".tmp"), timeout=600, delay=2)
            if info["ok"]:
                path.with_suffix(".tmp").replace(path)
        if path.exists():
            return label, path
    have = sorted(DIR.glob("tycg_doorplate_*.csv"))
    if have:
        return have[-1].stem.rsplit("_", 1)[-1], have[-1]
    raise RuntimeError("無法取得桃園市門牌坐標資料")


class DoorPlates:
    """棟級門牌索引。鍵：(區, 路, 巷, 弄, 號)，號含「之」，例如 '175之2'"""

    def __init__(self, path, label):
        self.label = label
        pts = collections.defaultdict(list)
        for r in csv.DictReader(open(path, encoding="utf-8-sig", newline="")):
            d = config.DISTRICTS.get(r["鄉鎮市區代碼"])
            road = self.norm(r["街路段"] or r["地區"])
            m = _NO.match(self.norm(r["號"]))
            if not (d and road and m):
                continue
            try:
                xy = (float(r["橫座標"]), float(r["縱座標"]))
            except ValueError:
                continue
            pts[(d, road, self.norm(r["巷"]), self.norm(r["弄"]) + (m.group(1) or ""), m.group(2))].append(xy)
        self.bld = {}                                   # 鍵 → (x, y)
        self.lane_nums = collections.defaultdict(list)  # (區, 路, 巷, 弄) → [(號數字, 鍵)]
        self.roads = collections.defaultdict(set)       # 區 → 路名集合
        self.road_lanes = collections.defaultdict(list)  # (區, 路) → [(區, 路, 巷, 弄)]
        for k, v in pts.items():
            xy = (statistics.median(p[0] for p in v), statistics.median(p[1] for p in v))
            self.bld[k] = xy
            self.lane_nums[k[:4]].append((int(k[4].split("之")[0]), k))
            self.roads[k[0]].add(k[1])
        for lk in self.lane_nums:
            self.road_lanes[lk[:2]].append(lk)
        self.bbox = {}
        for (d, *_), (x, y) in self.bld.items():
            b = self.bbox.get(d, (x, y, x, y))
            self.bbox[d] = (min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y))
        self.bbox = {d: (b[0] - 500, b[1] - 500, b[2] + 500, b[3] + 500) for d, b in self.bbox.items()}

    @staticmethod
    def norm(s):
        return (s or "").translate(_FW).replace("臺", "台").replace(" ", "").replace("　", "")

    def resolve_road(self, district, candidates):
        """在該區路名中找出第一個存在的候選；含私用區罕用字時用同區路名模糊比對（唯一才採用）"""
        roads = self.roads.get(district, set())
        for c in candidates:
            if c in roads:
                return c
        for c in candidates:
            if re.search(r"[-]", c):
                pat = re.compile("^" + "".join("." if "" <= ch <= "" else re.escape(ch) for ch in c) + "$")
                hits = [r for r in roads if pat.match(r)]
                if len(hits) == 1:
                    return hits[0]
        return None

    def road_points(self, district, road, lane=None):
        """某路（或某巷）上的棟級坐標，用來推算交叉口與路段中心"""
        out = []
        for lk in self.road_lanes.get((district, road), ()):
            if lane is None or lk[2] == lane:
                out += [self.bld[k] for _, k in self.lane_nums[lk]]
        return out

    def in_district(self, district, x, y):
        b = self.bbox.get(district)
        return bool(b) and b[0] <= x <= b[2] and b[1] <= y <= b[3]
