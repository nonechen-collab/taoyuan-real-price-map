"""地圖圖層資料（一次產生、存進 data/layers/，之後建置直接複製到前端）。

  python -m pipeline.layers flood   淹水潛勢：桃園市水務局「第三代桃園市淹水潛勢圖」shapefile → 40 m 網格合併成矩形
  python -m pipeline.layers osm     車站、學校、公園：OpenStreetMap Overpass 一次抓取（© OpenStreetMap 貢獻者，ODbL）

土壤液化潛勢直接用國土測繪中心 WMTS 圖磚，不需要產生檔案。
"""

import argparse
import collections
import json
import math
import re
import sys
import time
import urllib.parse
import zipfile

from . import config, net
from .doorplate import twd97_to_wgs84

LAYER_DIR = config.DATA / "layers"
FLOOD_URL = ("https://opendata.tycg.gov.tw/api/dataset/a0c037b1-9857-4ac9-a453-f3ae4524087a/"
             "resource/929ca7cb-9dd5-489a-8778-36f8442e4137/download")
FLOOD_SCENARIOS = {"24H_500mm": "24 小時 500 毫米", "06H_150mm": "6 小時 150 毫米"}
FLOOD_CLASSES = ["0.3–0.5 m", "0.5–1 m", "1–2 m", "2–3 m", "3 m 以上"]  # GRIDCODE 2–6；1（< 0.3 m）不畫
CELL = 40.0  # 淹水潛勢圖的網格大小（公尺），網格線在 x ≡ 20 (mod 40)
# 桃園市範圍（TWD97），網格線對齊原始資料
X0, Y0, X1, Y1 = 245020.0, 2715020.0, 310020.0, 2785020.0
OVERPASS = ["https://overpass.private.coffee/api/interpreter", "https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
BBOX = "24.58,120.98,25.13,121.52"


# ───────────────────────── 淹水潛勢 ─────────────────────────

def _dbf_codes(b):
    """dbf → 每筆的 GRIDCODE"""
    n = int.from_bytes(b[4:8], "little")
    hl = int.from_bytes(b[8:10], "little")
    rl = int.from_bytes(b[10:12], "little")
    fields, o, off = [], 32, 1
    while b[o] != 0x0D:
        name = b[o:o + 11].split(b"\0")[0].decode("ascii")
        length = b[o + 16]
        fields.append((name, off, length))
        off += length
        o += 32
    _, fo, fl = next(f for f in fields if f[0].upper() == "GRIDCODE")
    return [int(float(b[hl + i * rl + fo:hl + i * rl + fo + fl].decode("ascii").strip() or 0)) for i in range(n)]


def _polygons(b):
    """shp（多邊形）→ 每筆的環清單 [[(x, y), ...], ...]"""
    o, out = 100, []
    mv = memoryview(b)
    while o < len(b):
        clen = int.from_bytes(b[o + 4:o + 8], "big")
        st = int.from_bytes(b[o + 8:o + 12], "little")
        rings = []
        if st in (5, 15, 25):
            nparts = int.from_bytes(b[o + 44:o + 48], "little")
            npts = int.from_bytes(b[o + 48:o + 52], "little")
            parts = [int.from_bytes(b[o + 52 + 4 * i:o + 56 + 4 * i], "little") for i in range(nparts)] + [npts]
            base = o + 52 + 4 * nparts
            xy = mv[base:base + 16 * npts].cast("d")
            for i in range(nparts):
                rings.append([(xy[2 * k], xy[2 * k + 1]) for k in range(parts[i], parts[i + 1])])
        out.append(rings)
        o += 8 + clen * 2
    return out


def taoyuan_mask():
    """桃園市範圍（近似）：有門牌的 1 km 格子再往外擴 1 格。淹水潛勢檔含鄰近縣市，用這個裁掉"""
    import csv
    files = sorted((config.RAW_DIR / "doorplate").glob("*.csv"))
    if not files:
        from . import doorplate
        files = [doorplate.ensure_latest()[1]]
    cells = set()
    with open(files[-1], encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                cells.add((int(float(r["橫座標"]) // 1000), int(float(r["縱座標"]) // 1000)))
            except (ValueError, KeyError):
                continue
    return {(x + i, y + j) for x, y in cells for i in (-1, 0, 1) for j in (-1, 0, 1)}


def rasterize(polys, codes):
    """偶奇規則掃描線填色：每格記錄最深的分級（GRIDCODE）"""
    nx, ny = int((X1 - X0) / CELL), int((Y1 - Y0) / CELL)
    grid = bytearray(nx * ny)
    for rings, code in sorted(zip(polys, codes), key=lambda rc: rc[1]):  # 淺的先畫，深的覆蓋
        if code < 2:
            continue
        rows = collections.defaultdict(list)
        for ring in rings:
            for (xa, ya), (xb, yb) in zip(ring, ring[1:]):
                if ya == yb:
                    continue
                lo = math.ceil((min(ya, yb) - Y0) / CELL - 0.5)
                hi = math.ceil((max(ya, yb) - Y0) / CELL - 0.5) - 1
                for r in range(max(lo, 0), min(hi, ny - 1) + 1):
                    yc = Y0 + (r + 0.5) * CELL
                    rows[r].append(xa + (yc - ya) * (xb - xa) / (yb - ya))
        val = bytes([code])
        for r, xs in rows.items():
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                c0 = max(math.ceil((xs[k] - X0) / CELL - 0.5), 0)
                c1 = min(math.ceil((xs[k + 1] - X0) / CELL - 0.5) - 1, nx - 1)
                if c1 >= c0:
                    grid[r * nx + c0:r * nx + c1 + 1] = val * (c1 - c0 + 1)
    return grid, nx, ny


def rectangles(grid, nx, ny):
    """同一列連續同級的格子併成一段，上下列完全相同的段再併成矩形 → [(c0, r0, c1, r1, code)]"""
    open_runs, out = {}, []
    for r in range(ny):
        row = grid[r * nx:(r + 1) * nx]
        runs, c = {}, 0
        while c < nx:
            v = row[c]
            if v:
                c0 = c
                while c < nx and row[c] == v:
                    c += 1
                runs[(c0, c - 1, v)] = True
            else:
                c += 1
        for key, r0 in list(open_runs.items()):
            if key not in runs:
                out.append((key[0], r0, key[1], r - 1, key[2]))
                del open_runs[key]
        for key in runs:
            open_runs.setdefault(key, r)
    out += [(k[0], r0, k[1], ny - 1, k[2]) for k, r0 in open_runs.items()]
    return out


def flood(log=print):
    path = config.RAW_DIR / "flood_tycg.zip"
    if not path.exists():
        log("下載第三代桃園市淹水潛勢圖（約 80 MB）…")
        path.parent.mkdir(parents=True, exist_ok=True)
        info, _ = net.fetch(FLOOD_URL, dest=path, timeout=600)
        if not info["ok"]:
            raise SystemExit(f"下載失敗：{info.get('error') or info.get('status')}")
    zf = zipfile.ZipFile(path)
    LAYER_DIR.mkdir(parents=True, exist_ok=True)
    mask = taoyuan_mask()
    for sc, label in FLOOD_SCENARIOS.items():
        t0 = time.monotonic()
        polys = _polygons(zf.read(f"{sc}/{sc}.shp"))
        codes = _dbf_codes(zf.read(f"{sc}/{sc}.dbf"))
        grid, nx, ny = rasterize(polys, codes)
        for r in range(ny):  # 裁掉桃園市以外
            ky = int((Y0 + (r + 0.5) * CELL) // 1000)
            for c in range(nx):
                if grid[r * nx + c] and (int((X0 + (c + 0.5) * CELL) // 1000), ky) not in mask:
                    grid[r * nx + c] = 0
        rects = rectangles(grid, nx, ny)
        feats = []
        for c0, r0, c1, r1, code in rects:
            s, w = twd97_to_wgs84(X0 + c0 * CELL, Y0 + r0 * CELL)
            n, e = twd97_to_wgs84(X0 + (c1 + 1) * CELL, Y0 + (r1 + 1) * CELL)
            feats.append([round(w, 5), round(s, 5), round(e, 5), round(n, 5), code - 2])
        obj = {"scenario": label, "classes": FLOOD_CLASSES,
               "source": "桃園市政府水務局 第三代桃園市淹水潛勢圖（政府資料開放授權條款－第1版）",
               "fields": ["w", "s", "e", "n", "cls"], "rects": feats}
        (LAYER_DIR / f"flood_{sc}.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), "utf-8")
        cells = sum(1 for v in grid if v)
        log(f"  {label}：淹水格 {cells:,}（{cells * CELL * CELL / 1e6:.1f} km²）→ 矩形 {len(rects):,} 個（{time.monotonic() - t0:.0f} 秒）")


# ───────────────────────── OpenStreetMap ─────────────────────────

def _overpass(q, log):
    for attempt in range(4):
        for url in OVERPASS:
            info, body = net.fetch(url, data=urllib.parse.urlencode({"data": q}).encode(), timeout=180,
                                   delay=5, retries=0, headers=net.API_HEADERS)
            if info["ok"] and body and body.lstrip().startswith(b"{"):
                return json.loads(body)["elements"]
            log(f"    {url.split('/')[2]} 失敗（{info.get('status') or info.get('error')}），稍後重試")
        time.sleep(30 * (attempt + 1))
    raise SystemExit("OpenStreetMap 一直沒回應，請稍後再執行")


def _ll(e):
    if "lat" in e:
        return e["lat"], e["lon"]
    c = e.get("center")
    return (c["lat"], c["lon"]) if c else (None, None)


def _rail_kind(t):
    """機場捷運只認桃園捷運（避免把臺北捷運算進來）；臺北捷運等其他路網不收"""
    s = " ".join(t.get(k, "") for k in ("network", "operator", "name", "railway", "construction", "construction:railway"))
    net_op = t.get("network", "") + t.get("operator", "")
    if "綠線" in s or "Green Line" in s:
        return "捷運綠線"
    # 機場捷運先判斷：A18「高鐵桃園站」名稱有「高鐵」但屬於桃園捷運
    if "機場" in s or "桃園" in net_op or "Taoyuan" in net_op:
        if "高鐵" not in net_op and "高速鐵路" not in net_op:
            return "機場捷運" if "臺北" not in net_op and "台北" not in net_op else None
    if "高鐵" in s or "高速鐵路" in s:
        return "高鐵"
    if "臺鐵" in s or "台鐵" in s or "臺灣鐵路" in s or "Taiwan Railway" in s:
        return "台鐵"
    return None


def wgs84_to_twd97(lat, lon):
    """WGS84 → TWD97 二度分帶（只用來判斷是否在桃園範圍，公尺級誤差即可）"""
    a, f = 6378137.0, 1 / 298.257222101
    b = a * (1 - f)
    e2 = (a * a - b * b) / (a * a)
    ep2 = e2 / (1 - e2)
    k0, lon0, dx = 0.9999, math.radians(121), 250000.0
    phi, p = math.radians(lat), math.radians(lon) - lon0
    n = (a - b) / (a + b)
    nu = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    A = a * (1 - n + 5 / 4 * (n ** 2 - n ** 3) + 81 / 64 * (n ** 4 - n ** 5))
    B = 3 * a * n / 2 * (1 - n + 7 / 8 * (n ** 2 - n ** 3) + 55 / 64 * (n ** 4 - n ** 5))
    C = 15 * a * n ** 2 / 16 * (1 - n + 3 / 4 * (n ** 2 - n ** 3))
    D = 35 * a * n ** 3 / 48 * (1 - n + 11 / 16 * (n ** 2 - n ** 3))
    E = 315 * a * n ** 4 / 51 * (1 - n)
    S = A * phi - B * math.sin(2 * phi) + C * math.sin(4 * phi) - D * math.sin(6 * phi) + E * math.sin(8 * phi)
    c, t = math.cos(phi), math.tan(phi)
    y = S * k0 + k0 * nu * math.sin(2 * phi) / 4 * p ** 2 + \
        k0 * nu * math.sin(phi) * c ** 3 / 24 * (5 - t ** 2 + 9 * ep2 * c ** 2 + 4 * ep2 ** 2 * c ** 4) * p ** 4
    x = k0 * nu * c * p + k0 * nu * c ** 3 / 6 * (1 - t ** 2 + ep2 * c ** 2) * p ** 3 + dx
    return x, y


OSM_QUERIES = {
    "stations": ('nwr["railway"~"^(station|halt)$"];out tags center;'
                 'nwr["construction"="station"];out tags center;'
                 'nwr["construction:railway"~"^(station|halt)$"];out tags center;'),
    "schools": 'nwr["amenity"~"^(school|university|college)$"]["name"];out tags center;',
    "parks": 'nwr["leisure"="park"]["name"];out tags center;',
}


def osm(log=print):
    """各查詢的原始回應存在 data/raw/osm/（失敗重跑時已成功的不再查），整理後只留桃園市範圍內的點"""
    LAYER_DIR.mkdir(parents=True, exist_ok=True)
    raw_dir = config.RAW_DIR / "osm"
    raw_dir.mkdir(parents=True, exist_ok=True)
    els = {}
    for name, body in OSM_QUERIES.items():
        f = raw_dir / f"{name}.json"
        if not f.exists():
            log(f"  查詢 {name}…")
            f.write_text(json.dumps(_overpass(f"[out:json][timeout:120][bbox:{BBOX}];" + body, log), ensure_ascii=False), "utf-8")
        els[name] = json.loads(f.read_text("utf-8"))
    mask = taoyuan_mask()

    def inside(lat, lon):
        x, y = wgs84_to_twd97(lat, lon)
        return (int(x // 1000), int(y // 1000)) in mask

    stations, seen = [], set()
    for e in els["stations"]:
        t = e.get("tags", {})
        kind = _rail_kind(t)
        lat, lon = _ll(e)
        name = t.get("name", "").strip()
        if not kind or lat is None or not name or (kind, name) in seen or not inside(lat, lon):
            continue
        seen.add((kind, name))
        building = "construction" in t.get("railway", "") or "construction" in t or kind == "捷運綠線"
        stations.append([name, kind, round(lat, 5), round(lon, 5), 1 if building else 0])
    log(f"  車站 {len(stations)} 個：{dict(collections.Counter(x[1] for x in stations))}")
    schools, seen = [], set()
    for e in els["schools"]:
        t = e["tags"]
        lat, lon = _ll(e)
        n = t["name"]
        if lat is None or n in seen or not inside(lat, lon):
            continue
        seen.add(n)
        level = ("大學" if t["amenity"] in ("university", "college") or "大學" in n or "科大" in n else
                 "高中職" if re.search(r"高中|高級中學|高職|高工|高商|高農", n) else
                 "國中" if "國中" in n or "國民中學" in n else
                 "國小" if "國小" in n or "國民小學" in n else "其他")
        schools.append([n, level, round(lat, 5), round(lon, 5)])
    log(f"  學校 {len(schools)} 所：{dict(collections.Counter(x[1] for x in schools))}")
    parks, seen = [], set()
    for e in els["parks"]:
        lat, lon = _ll(e)
        n = e["tags"]["name"]
        if lat is not None and n not in seen and inside(lat, lon):
            seen.add(n)
            parks.append([n, round(lat, 5), round(lon, 5)])
    log(f"  公園 {len(parks)} 個")
    obj = {"source": "© OpenStreetMap 貢獻者（ODbL）", "fetched": config.now_tw().date().isoformat(),
           "stations": {"fields": ["name", "kind", "lat", "lon", "building"], "rows": stations},
           "schools": {"fields": ["name", "level", "lat", "lon"], "rows": schools},
           "parks": {"fields": ["name", "lat", "lon"], "rows": parks}}
    (LAYER_DIR / "poi.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), "utf-8")


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["flood", "osm"])
    a = ap.parse_args(argv)
    flood() if a.what == "flood" else osm()


if __name__ == "__main__":
    main()
