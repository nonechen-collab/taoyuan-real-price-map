"""主流程：讀 data/periods → 去重 → 清理 → 定位 → 推定社區 → 車位估價 → 輸出前端資料與報告。

用法
  python -m pipeline.build              完整建置（需要時會下載門牌坐標、查 OSM）
  python -m pipeline.build --offline    不連網，只用定位快取（沒快取的地址當作未定位）
"""

import argparse
import bisect
import collections
import csv
import datetime as dt
import hashlib
import io
import json
import math
import re
import shutil
import statistics
import sys
import zipfile

from . import clean, community, config, geocode, periods, rules

BTYPES = ["住宅大樓", "華廈", "公寓", "透天", "套房", "店面", "辦公", "廠辦", "工廠", "倉庫", "農舍", "其他"]
DEFAULT_BTYPES = ["住宅大樓", "華廈", "公寓", "透天", "套房"]
MULTI_UNIT = {"住宅大樓", "華廈", "公寓", "套房", "辦公"}  # 這些型態整棟移轉才排除
TODAY = config.now_tw().date()  # 交易日期晚於今天（＋31 天）視為打錯
PARK_TYPES = ["坡道平面", "一樓平面", "升降平面", "坡道機械", "升降機械", "塔式車位", "其他"]
FIELDS = ["id", "k", "d", "lat", "lon", "geo", "addr", "cid", "bt", "fl", "tf", "age", "rm", "hl", "ba",
          "tp", "up", "pg", "ip", "pr", "pn", "pt", "pp", "pa", "el", "fx", "un"]
DETAIL_FIELDS = ["移轉層次", "交易筆棟數", "交易標的", "備註", "建物型態", "主要用途", "主要建材", "建築完成年月",
                 "建物移轉總面積平方公尺", "主建物面積", "附屬建物面積", "陽台面積", "車位類別",
                 "車位移轉總面積平方公尺", "車位總價元", "總價元", "單價元平方公尺", "解約情形", "期別",
                 "門牌鍵", "定位來源", "對應門牌", "車位估價依據"]
SOURCES = [
    "內政部不動產成交案件實際資訊（實價登錄）開放資料，政府資料開放授權條款－第1版",
    "桃園市政府民政局 桃園市門牌位置坐標資料，政府資料開放授權條款－第1版",
    "預售建案部分位置 © OpenStreetMap 貢獻者（ODbL）",
    "底圖：內政部國土測繪中心 通用版電子地圖",
]


# ───────────────────────── 讀檔 ─────────────────────────

def _read_csv(zf, name):
    raw = zf.read(name)
    for enc in ("utf-8-sig", "cp950", "big5hkscs"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return [], []
    header = [h.strip() for h in rows[0]]
    body = rows[1:]
    if body and re.match(r"^[A-Za-z ]", (body[0][0] if body[0] else "")):  # 第二列英文欄名
        body = body[1:]
    return header, body


def load_raw():
    """各期依新舊讀入，同編號後面（較新）的覆蓋前面。
    回傳 ({(表, 編號): (列, 期別)}, 期別清單, 各期筆數, {(表, 編號): 土地地號鍵集合})"""
    plist = periods.list_periods()
    recs, per_counts, parcels = {}, {}, {}
    for p in plist:
        cnt = collections.Counter()
        with zipfile.ZipFile(p["path"]) as zf:
            names = set(zf.namelist())
            for kind in "ab":
                name = f"h_lvr_land_{kind}.csv"
                if name not in names:
                    continue
                header, body = _read_csv(zf, name)
                dist = {}
                for r in body:
                    d = dict(zip(header, r))
                    rid = (d.get("編號") or "").strip()
                    if rid:
                        recs[(kind, rid)] = (d, p["name"])
                        dist[rid] = d.get("鄉鎮市區", "")
                        cnt[kind] += 1
                # 土地明細：預售建案與交屋買賣以同一塊地（地段＋地號）連結
                lname = f"h_lvr_land_{kind}_land.csv"
                if lname in names:
                    lh, lb = _read_csv(zf, lname)
                    if all(c in lh for c in ("編號", "土地位置", "地號")):
                        i_id, i_sec, i_no = lh.index("編號"), lh.index("土地位置"), lh.index("地號")
                        tmp = collections.defaultdict(set)
                        for r in lb:
                            if len(r) > max(i_id, i_sec, i_no):
                                rid = r[i_id].strip()
                                k = clean.parcel_key(dist.get(rid, ""), r[i_sec], r[i_no])
                                if k:
                                    tmp[rid].add(sys.intern(k))
                        for rid, ks in tmp.items():
                            parcels[(kind, rid)] = frozenset(ks)
        per_counts[p["name"]] = dict(cnt)
    return recs, plist, per_counts, parcels


# ───────────────────────── 清理 ─────────────────────────

def clean_record(kind, d, period, flags):
    """回傳 (紀錄 dict, None) 或 (None, 排除原因)"""
    target = d.get("交易標的", "")
    if "建物" not in target:
        return None, "純土地" if target == "土地" else ("純車位" if target == "車位" else f"其他標的（{target}）")
    date = clean.roc_date(d.get("交易年月日"))
    if not date:
        return None, "交易日期無法解析"
    if date.year < 1990 or date > TODAY + dt.timedelta(days=31):
        return None, "交易日期不合理（打錯，例如 2101 年）"
    counts = clean.parse_counts(d.get("交易筆棟數"))
    fl = clean.parse_floors(d.get("移轉層次"))
    bt = clean.btype_short(d.get("建物型態"))
    built = clean.roc_date(d.get("建築完成年月")) if kind == "a" else None
    note = d.get("備註", "")
    names = clean.match_flags(note, flags.rules)
    if kind == "a" and clean.is_presale_handover(note):
        names.append("預售交屋")
    cancelled, _ = clean.cancel_info(d.get("解約情形")) if kind == "b" else (False, None)
    if cancelled:
        names.append("解約")
    if fl["whole"] and bt in MULTI_UNIT:  # 透天厝本來就是整棟（移轉層次「全」），不算
        names.append("整棟")
    if counts[1] > 1:
        names.append("多棟")
    ptype = (d.get("車位類別") or "").strip()
    park_price = clean.num(d.get("車位總價元")) or 0
    park_area = clean.num(d.get("車位移轉總面積平方公尺")) or 0
    park_n = counts[2] or (1 if ("車位" in target or ptype) else 0)
    if park_n and park_price == 0:
        names.append("車位未拆價")
    if park_n and park_area == 0:
        names.append("車位面積未拆")
    p = clean.parse_address(d.get("土地位置建物門牌"), d.get("鄉鎮市區"))
    return {
        "kind": kind, "id": d["編號"].strip(), "period": period, "district": d.get("鄉鎮市區", ""),
        "addr": clean.norm_text(d.get("土地位置建物門牌")), "parsed": p, "date": date,
        "floor": clean.main_floor(fl), "floors_all": fl["floors"], "total_floors": clean.total_floors(d.get("總樓層數")),
        "btype": bt, "built": built, "age": clean.years_between(built, date),
        "rooms": _int(d.get("建物現況格局-房")), "halls": _int(d.get("建物現況格局-廳")), "baths": _int(d.get("建物現況格局-衛")),
        "area": clean.num(d.get("建物移轉總面積平方公尺")) or 0,
        "main": clean.num(d.get("主建物面積")), "aux": clean.num(d.get("附屬建物面積")), "bal": clean.num(d.get("陽台面積")),
        "total": clean.num(d.get("總價元")) or 0, "park_price": park_price, "park_area": park_area,
        "park_n": park_n, "park_type": ptype, "elevator": clean.has_elevator(d.get("電梯"), bt),
        "flags": names, "project": (d.get("建案名稱") or "").strip(), "unit_no": (d.get("棟及號") or "").strip(),
        "raw": d,
    }, None


def _int(s):
    v = clean.num(s)
    return int(v) if v is not None else None


# ───────────────────────── 車位估價 ─────────────────────────

SCOPE_LABEL = {"c": "同社區", "d": "同區", "t": "全市"}


class ParkPool:
    """同社區（不足則同區、再不足全市）、同車位類別、交易日前後 1 年內的每位車位中位價／中位面積。
    各池依日期排序、用二分搜尋取時間窗；同一池同一個月的結果只算一次。"""

    def __init__(self, recs, field):
        raw = collections.defaultdict(list)
        for r in recs:
            if not r["park_n"]:
                continue
            v = r["park_price"] if field == "price" else r["park_area"]
            if v and v > 0:
                per = v / r["park_n"]
                o = r["date"].toordinal()
                for key in ((r["kind"], "c", r.get("cid"), r["park_type"]), (r["kind"], "d", r["district"], r["park_type"]),
                            (r["kind"], "t", "", r["park_type"])):
                    raw[key].append((o, per))
        self.idx = {}
        for k, v in raw.items():
            v.sort()
            self.idx[k] = ([o for o, _ in v], [x for _, x in v])
        self.memo = {}

    def _window(self, key, date):
        ym = (date.year, date.month)
        if (key, ym) in self.memo:
            return self.memo[(key, ym)]
        dates, vals = self.idx.get(key, ([], []))
        mid = dt.date(date.year, date.month, 15).toordinal()
        lo, hi = bisect.bisect_left(dates, mid - 366), bisect.bisect_right(dates, mid + 366)
        win = vals[lo:hi]
        res = (statistics.median(win) if win else None, len(win), statistics.median(vals) if vals else None, len(vals))
        self.memo[(key, ym)] = res
        return res

    def estimate(self, r):
        for scope, owner, need in (("c", r.get("cid"), 3), ("d", r["district"], 5), ("t", "", 5)):
            key = (r["kind"], scope, owner, r["park_type"])
            if key not in self.idx:
                continue
            m_win, n_win, m_all, n_all = self._window(key, r["date"])
            if n_win >= need:
                return m_win * r["park_n"], f"{SCOPE_LABEL[scope]}近 1 年 {n_win} 筆中位數"
            if scope == "t" and n_all >= need:
                return m_all * r["park_n"], f"{SCOPE_LABEL[scope]}全期 {n_all} 筆中位數"
        return None, None


def finish_prices(recs, flags):
    price_pool, area_pool = ParkPool(recs, "price"), ParkPool(recs, "area")
    est = collections.Counter()
    for r in recs:
        park_price, park_area, basis = r["park_price"], r["park_area"], []
        if r["park_n"] and park_price == 0:
            v, why = price_pool.estimate(r)
            if v:
                park_price = v
                basis.append(f"車位價 {v / 10000:.0f} 萬（{why}）")
                est["price"] += 1
        if r["park_n"] and park_area == 0:
            v, why = area_pool.estimate(r)
            if v:
                park_area = v
                basis.append(f"車位面積 {v * clean.PING:.1f} 坪（{why}）")
                est["area"] += 1
        r["park_price_eff"], r["park_area_eff"] = park_price, park_area
        r["park_basis"] = "；".join(basis)
        r["unit"] = clean.unit_price_net(r["total"], park_price, r["area"], park_area)
        if basis and r["unit"] is not None:
            r["flags"].append("單價估算")
        if r["unit"] is None:
            r["flags"].append("無單價")
        r["areas"] = clean.area_breakdown(r["area"], park_area, r["main"], r["aux"], r["bal"])
        r["mask"] = flags.mask(r["flags"])
    return est


# ───────────────────────── 主流程 ─────────────────────────

def build(offline=False, log=print):
    t0 = config.now_tw()
    flags = rules.Flags()
    raw, plist, per_counts, parcels = load_raw()
    log(f"讀入 {len(plist)} 期，去重後 {len(raw):,} 筆（買賣＋預售）")
    recs, excluded = [], collections.Counter()
    for (kind, _), (d, period) in raw.items():
        r, why = clean_record(kind, d, period, flags)
        if r:
            recs.append(r)
        else:
            excluded[why] += 1

    # 定位
    bld_keys, pre_keys = {}, {}
    for r in recs:
        if r["kind"] == "a" and r["parsed"]:
            r["gkey"] = geocode.building_cache_key(r["parsed"])
            bld_keys[r["gkey"]] = r["parsed"]
        elif r["kind"] == "b":
            r["gkey"] = geocode.address_cache_key(r["addr"], r["district"])
            pre_keys[r["gkey"]] = (r["addr"], r["district"])
        elif r["kind"] == "a":
            r["gkey"] = None
    if offline:
        cache = geocode.Cache()
        geo = {k: cache.best(k) for k in list(bld_keys) + list(pre_keys)}
        gstats = {"cached": sum(1 for v in geo.values() if v), "new": 0, "osm": 0, "doorplate_month": None}
    else:
        geo, gstats = geocode.run(bld_keys, pre_keys, log=log)
    for r in recs:
        g = geo.get(r["gkey"]) if r.get("gkey") else None
        r["geo"] = g
        r["level"] = int(g["精度"]) if g else 9
        r["lat"] = float(g["緯度"]) if g and g["緯度"] else None
        r["lon"] = float(g["經度"]) if g and g["經度"] else None

    log(f"  定位完成（{(config.now_tw() - t0).seconds} 秒）")
    # 預售建案位置：同建案取最準的一筆
    proj = collections.defaultdict(list)
    for r in recs:
        if r["kind"] == "b" and r["project"]:
            proj[(r["district"], r["project"])].append(r)
    proj_info = {}
    for (d, name), rs in proj.items():
        best = min(rs, key=lambda r: (r["level"], r["date"]))
        pid = community.project_id(d, name)
        proj_info[pid] = {"id": pid, "name": name, "district": d, "lat": best["lat"], "lon": best["lon"],
                          "level": best["level"], "presale": True, "buildings": None,
                          "floors": max((r["total_floors"] or 0) for r in rs) or None, "built": None}
        for r in rs:
            r["cid"] = pid
            if best["lat"] is not None and (r["lat"] is None or r["level"] > best["level"]):
                r["lat"], r["lon"], r["level"] = best["lat"], best["lon"], best["level"]

    # 推定社區（買賣）
    blds = {}
    for r in recs:
        if r["kind"] != "a" or not r["parsed"]:
            continue
        g = r["geo"]
        road = None
        if g and g.get("對應門牌") and int(g["精度"]) <= 4:
            road = g["對應門牌"].split("|")[1]
        r["bkey"] = clean.building_key(r["parsed"], road)
        b = blds.setdefault(r["bkey"], {"district": r["district"], "lat": r["lat"], "lon": r["lon"],
                                        "approx": r["level"] >= 4,  # 概略位置不參與 80 m 合併
                                        "_built": collections.Counter(), "_floors": collections.Counter()})
        if r["built"]:
            b["_built"][r["built"].strftime("%Y-%m")] += 1
        if r["total_floors"]:
            b["_floors"][r["total_floors"]] += 1
    for b in blds.values():
        b["built"] = b.pop("_built").most_common(1)[0][0] if b["_built"] else None
        b["floors"] = b.pop("_floors").most_common(1)[0][0] if b["_floors"] else None
    assign, comm_info = community.infer(blds)
    for r in recs:
        if r["kind"] == "a":
            r["cid"] = assign.get(r.get("bkey"))

    log(f"  社區推定完成：{len(comm_info):,} 個（{(config.now_tw() - t0).seconds} 秒）")
    naff = mark_affordable(recs, parcels)
    if naff:
        log(f"  合宜住宅：{naff:,} 筆（預設不進統計）")
    nlink = link_projects(recs, parcels, proj_info, comm_info)
    log(f"  預售建案以地號連結交屋門牌：{nlink:,} 個建案")
    t1 = config.now_tw()
    nsec, errs = locate_by_section(recs, parcels, proj_info)
    log(f"  （同地段推估花 {(config.now_tw() - t1).seconds} 秒）")
    if errs:
        errs.sort()
        log(f"  同地段推估位置：{nsec:,} 個建案（驗證 {len(errs):,} 個已知位置的建案：誤差中位 {errs[len(errs) // 2]:.0f} m、"
            f"P90 {errs[len(errs) * 9 // 10]:.0f} m、300 m 內 {sum(e <= 300 for e in errs) / len(errs):.0%}）")
    est = finish_prices(recs, flags)
    fill_project_ratios(recs, proj_info)
    log(f"  車位估價完成（{(config.now_tw() - t0).seconds} 秒）")
    out_stats = write_outputs(recs, comm_info, proj_info, plist, flags, t0)
    summary = make_summary(recs, raw, plist, per_counts, excluded, gstats, est, out_stats, flags, t0)
    write_report(summary)
    return summary


def mark_affordable(recs, parcels):
    """政府合宜住宅配售（rules.AFFORDABLE）加上旗標；回傳筆數"""
    n = 0
    for r in recs:
        secs = {k.split("|")[1] for k in parcels.get((r["kind"], r["id"]), ())}
        if secs and rules.affordable(r["district"], secs, r["date"]):
            r["flags"].append("合宜住宅")
            n += 1
    return n


def link_projects(recs, parcels, proj_info, comm_info):
    """預售建案 ↔ 交屋後的買賣：土地明細寫的是同一塊地（地段＋地號）。
    連得到時，建案位置改用交屋社區的門牌坐標（精度 2「鄰近門牌」等級），並記下交屋社區與其公設比中位數。
    2021 年前的預售地址多半只有地號，這是舊建案唯一精準的定位方式。回傳連結成功的建案數。"""
    by_parcel = collections.defaultdict(list)
    for r in recs:
        if r["kind"] == "a" and r.get("cid") and r["level"] <= 2:
            for k in parcels.get(("a", r["id"]), ()):
                by_parcel[k].append(r)
    proj_parcels = collections.defaultdict(set)
    for r in recs:
        if r["kind"] == "b" and r.get("cid"):
            proj_parcels[r["cid"]].update(parcels.get(("b", r["id"]), ()))
    linked = 0
    for pid, ps in proj_parcels.items():
        votes = collections.Counter()
        for k in ps:
            for a in by_parcel.get(k, ()):
                votes[a["cid"]] += 1
        if not votes:
            continue
        cid, n = votes.most_common(1)[0]
        c = comm_info.get(cid)
        if n < 2 or n / sum(votes.values()) < 0.5 or not c or c.get("lat") is None:
            continue  # 一塊地分給好幾個社區時不採用
        pi = proj_info[pid]
        pi["link"] = cid
        if pi.get("lat") is None or pi["level"] > 1:
            pi["lat"], pi["lon"], pi["level"] = c["lat"], c["lon"], 2
        linked += 1
    _sync_presale(recs, proj_info)
    return linked


def _sync_presale(recs, proj_info):
    """預售各筆的位置跟著建案更新"""
    for r in recs:
        if r["kind"] == "b" and r.get("cid") in proj_info:
            pi = proj_info[r["cid"]]
            if pi.get("lat") is not None and (r["lat"] is None or r["level"] > pi["level"]):
                r["lat"], r["lon"], r["level"] = pi["lat"], pi["lon"], pi["level"]


SECTION_K = 5  # 取地號最接近的幾棟已定位建物
SECTION_MAX_GAP = 60  # 地號（母號）相差超過這個就不採用
SECTION_MAX_SPREAD = 500  # 參考建物離推估中心最遠超過這個（公尺）就放棄，避免亂猜


def _parcel_main(code):
    """地號 '02070000' → 母號 207；格式不明回傳 None"""
    if len(code) == 8:
        return int(code[:4])
    if len(code) <= 4:
        return int(code)
    return None


def _section_index(recs, parcels):
    """已精準定位（門牌、鄰近門牌、交叉口）的成交：{(區, 地段): 依母號排序的 [(母號, 緯度, 經度, 社區或建案)]}"""
    idx = collections.defaultdict(set)  # 同一棟的多筆成交只留一筆
    for r in recs:
        if r["lat"] is None or r["level"] > 3 or not r.get("cid"):
            continue
        for k in parcels.get((r["kind"], r["id"]), ()):
            d, sec, code = k.split("|")
            m = _parcel_main(code)
            if m is not None:
                idx[(d, sec)].add((m, r["lat"], r["lon"], r["cid"]))
    return {k: sorted(v) for k, v in idx.items()}


def _estimate(idx, keys, exclude):
    """同地段、母號最接近的已定位建物取中位數位置；參考點太散或地號差太多回傳 None"""
    pts = {}
    for d, sec, m in {(k.split("|")[0], k.split("|")[1], _parcel_main(k.split("|")[2])) for k in keys}:
        lst = idx.get((d, sec))
        if m is None or not lst:
            continue
        # 從最接近的母號往兩邊各取，取到 SECTION_K 棟或地號差超過門檻為止（不掃整段，大地段也快）
        hi = bisect.bisect_left(lst, (m,))
        lo, got = hi - 1, 0
        while got < SECTION_K and (lo >= 0 or hi < len(lst)):
            if hi < len(lst) and (lo < 0 or lst[hi][0] - m <= m - lst[lo][0]):
                e, hi = lst[hi], hi + 1
            else:
                e, lo = lst[lo], lo - 1
            gap = abs(e[0] - m)
            if gap > SECTION_MAX_GAP:
                break
            if e[3] in exclude:
                continue
            ll = (e[1], e[2])
            if ll not in pts:
                got += 1
            pts[ll] = min(gap, pts.get(ll, gap))
    if not pts:
        return None
    near = sorted(pts, key=pts.get)[:SECTION_K]
    lat = statistics.median(p[0] for p in near)
    lon = statistics.median(p[1] for p in near)
    c = community._xy(lat, lon)
    if max(math.dist(c, community._xy(*p)) for p in near) > SECTION_MAX_SPREAD:
        return None
    return lat, lon


def locate_by_section(recs, parcels, proj_info):
    """還沒定位的預售建案（新路、只寫地號）：用同地段、地號最接近的已定位建物推估，標「概略位置」（精度 5）。
    先拿已知位置的建案假裝不知道位置來推估，回報誤差。回傳 (推估建案數, 驗證誤差公尺清單)"""
    idx = _section_index(recs, parcels)
    proj_parcels = collections.defaultdict(set)
    for r in recs:
        if r["kind"] == "b" and r.get("cid") in proj_info:
            proj_parcels[r["cid"]].update(parcels.get(("b", r["id"]), ()))
    errs = []
    for pid, ks in proj_parcels.items():
        pi = proj_info[pid]
        if pi.get("lat") is None or pi["level"] not in (1, 3):
            continue
        est = _estimate(idx, ks, {pid, pi.get("link")})
        if est:
            errs.append(math.dist(community._xy(*est), community._xy(pi["lat"], pi["lon"])))
    n = 0
    for pid, ks in proj_parcels.items():
        pi = proj_info[pid]
        if pi.get("lat") is not None:
            continue
        est = _estimate(idx, ks, {pid})
        if est:
            pi["lat"], pi["lon"], pi["level"] = round(est[0], 6), round(est[1], 6), 5
            n += 1
    _sync_presale(recs, proj_info)
    return n, errs


def fill_project_ratios(recs, proj_info):
    """建案交屋後社區的公設比中位數（預售表沒有主建物欄位，SPEC：交屋後由買賣表補）"""
    by_cid = collections.defaultdict(list)
    for r in recs:
        if r["kind"] == "a" and r.get("cid") and r["areas"]["public_ratio"] is not None:
            by_cid[r["cid"]].append(r["areas"]["public_ratio"])
    for pi in proj_info.values():
        prs = by_cid.get(pi.get("link"), [])
        pi["pr"] = round(statistics.median(prs), 3) if prs else None


def _r(v, n):
    return None if v is None else round(v, n)


COMM_FIELDS = ["id", "name", "district", "lat", "lon", "built", "floors", "buildings", "presale",
               "shard", "link", "pr", "level"]
N_SHARDS = 64  # 社區／建案歷史檔分成幾份（社區頁只下載自己那一份）
SEARCH_FIELDS = ["id", "name", "district", "lat", "lon", "presale", "n", "last", "shard"]
PARTS = (("r", "近 12 月"), ("o", "更早（近 3 年內）"))


def _months_ago(d, months):
    """d 往前推 months 個月的同一天（月底不存在就取當月最後一天）；與前端「近 N 月」同規則"""
    y, m = d.year, d.month - months
    while m <= 0:
        m += 12
        y -= 1
    for day in (d.day, 30, 29, 28):
        try:
            return dt.date(y, m, day)
        except ValueError:
            continue


def _write_hashed(folder, stem, obj):
    """寫成 <stem>.<內容雜湊8碼>.json：內容不變檔名就不變，手機可以長期快取"""
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    name = f"{stem}.{hashlib.sha1(data).hexdigest()[:8]}.json"
    (folder / name).write_bytes(data)
    return name, len(data)


def _tx_row(r, district, lidx):
    a = r["areas"]
    return [
        r["id"], 0 if r["kind"] == "a" else 1, int(r["date"].strftime("%Y%m%d")),
        _r(r["lat"], 5), _r(r["lon"], 5), r["level"], short_addr(r["addr"], district), lidx.get(r.get("cid"), -1),
        BTYPES.index(r["btype"]), r["floor"], r["total_floors"], _r(r["age"], 1),
        r["rooms"], r["halls"], r["baths"],
        _r(r["total"] / 10000, 1), _r(r["unit"], 2), _r(a["ping"], 1), _r(a["indoor"], 1), _r(a["public_ratio"], 2),
        r["park_n"], PARK_TYPES.index(r["park_type"]) if r["park_type"] in PARK_TYPES else -1,
        _r(r["park_price_eff"] / 10000, 1) if r["park_n"] else None,
        _r(r["park_area_eff"] * clean.PING, 1) if r["park_n"] else None,
        None if r["elevator"] is None else int(r["elevator"]), r["mask"], r["unit_no"] or None,
    ]


def _detail_row(r):
    d, g = r["raw"], r["geo"] or {}
    return [d.get(k, "") for k in DETAIL_FIELDS[:18]] + [
        r["period"], r.get("bkey") or "", g.get("來源", ""), g.get("對應門牌", ""), r["park_basis"]]


def shard_of(cid):
    return int(hashlib.sha1(cid.encode("utf-8")).hexdigest()[:8], 16) % N_SHARDS


def _comm_row(ci):
    return [ci["id"], ci["name"], ci["district"], _r(ci["lat"], 5), _r(ci["lon"], 5),
            ci.get("built"), ci.get("floors"), ci.get("buildings"), 1 if ci.get("presale") else 0,
            shard_of(ci["id"]), ci.get("link"), ci.get("pr"), ci.get("level")]


def write_history(recs, comms, out):
    """社區與預售建案從 2012 年起的全部成交，依代號雜湊分成 N_SHARDS 份。
    社區頁、建案頁、走勢圖點開時才下載對應那一份（約數百 KB）。"""
    folder = out / "ent"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    groups = collections.defaultdict(list)
    for r in recs:
        if r.get("cid") in comms:
            groups[r["cid"]].append(r)
    shards = collections.defaultdict(dict)
    search = []
    for cid, rs in groups.items():
        rs.sort(key=lambda r: r["date"], reverse=True)
        ci = comms[cid]
        shards[shard_of(cid)][cid] = {"c": _comm_row(ci), "rows": [_tx_row(r, ci["district"], {}) for r in rs]}
        search.append([cid, ci["name"], ci["district"], _r(ci["lat"], 4), _r(ci["lon"], 4),
                       1 if ci.get("presale") else 0, len(rs), int(rs[0]["date"].strftime("%Y%m")), shard_of(cid)])
    files, sizes = [], []
    for i in range(N_SHARDS):
        name, size = _write_hashed(folder, f"{i:02d}", {"fields": FIELDS, "commFields": COMM_FIELDS,
                                                         "ents": shards.get(i, {})})
        files.append(f"ent/{name}")
        sizes.append(size)
    search.sort(key=lambda x: (-x[5], -x[6]))  # 預售建案在前、成交多的在前
    sname, _ = _write_hashed(out, "search", {"fields": SEARCH_FIELDS, "rows": search})
    return files, sname, len(groups), sizes


def write_outputs(recs, comm_info, proj_info, plist, flags, t0):
    """前端資料：每區拆「近 12 月」與「更早」兩檔（各自帶用到的社區），檔名含內容雜湊。
    前端先載近 12 月（預設期間），選「近 3 年」或自訂更早期間時才載更早的檔。"""
    out = config.OUT_DIR
    for sub in ("tx", "detail"):  # 檔名有版本碼，舊檔不刪會越積越多
        shutil.rmtree(out / sub, ignore_errors=True)
        (out / sub).mkdir(parents=True, exist_ok=True)
    (out / "communities.json").unlink(missing_ok=True)  # 舊版格式，社區已併入各區檔
    today = t0.date()
    since = _months_ago(today, 12 * config.RECENT_YEARS)
    recent = [r for r in recs if r["date"] >= since]
    latest = max(r["date"] for r in recent)
    split = _months_ago(latest, 12)
    comms = {**comm_info, **proj_info}

    by_d = collections.defaultdict(list)
    for r in recent:
        by_d[r["district"]].append(r)
    dist_meta, sizes, n_comm = [], {}, set()
    for name, rs in sorted(by_d.items(), key=lambda kv: -len(kv[1])):
        code = config.DISTRICT_CODE.get(name, name)
        rs.sort(key=lambda r: r["date"], reverse=True)
        parts, size = [], [0, 0]
        for key, label in PARTS:
            sub = [r for r in rs if (r["date"] >= split) == (key == "r")]
            local = sorted({r.get("cid") for r in sub if r.get("cid")})
            n_comm.update(local)
            lidx = {c: i for i, c in enumerate(local)}
            tx_name, tx_bytes = _write_hashed(out / "tx", f"{code}.{key}", {
                "fields": FIELDS, "commFields": COMM_FIELDS,
                "comms": [_comm_row(comms[c]) for c in local], "rows": [_tx_row(r, name, lidx) for r in sub]})
            det_name, det_bytes = _write_hashed(out / "detail", f"{code}.{key}", {
                "fields": DETAIL_FIELDS, "rows": {r["id"]: _detail_row(r) for r in sub}})
            parts.append({"key": key, "label": label, "n": len(sub), "file": f"tx/{tx_name}",
                          "detail": f"detail/{det_name}", "bytes": tx_bytes})
            size[0] += tx_bytes
            size[1] += det_bytes
        sizes[name] = tuple(size)
        pts = [(r["lat"], r["lon"]) for r in rs if r["lat"] is not None]
        dist_meta.append({"code": code, "name": name, "n": len(rs), "parts": parts,
                          "lat": round(statistics.median(p[0] for p in pts), 4) if pts else None,
                          "lon": round(statistics.median(p[1] for p in pts), 4) if pts else None})
    (out / "stats_quarterly.json").unlink(missing_ok=True)  # 舊版檔名，改為含版本碼
    for old in [*out.glob("stats.*.json"), *out.glob("search.*.json")]:
        old.unlink()  # 上次的版本（檔名含雜湊，不刪會越積越多）
    stats_name, _ = _write_hashed(out, "stats", quarterly(recs, flags))
    hist_files, search_name, n_ent, hist_sizes = write_history(recs, comms, out)
    first = min(r["date"] for r in recs)
    latest_issue = max((p for p in plist if p["kind"] == "issue"), key=lambda p: p.get("sale_to") or 0, default=None)
    meta = {
        "version": 2,
        "generated": t0.isoformat(timespec="seconds"),
        "range": {"from": since.isoformat(), "to": latest.isoformat()},
        "split": split.isoformat(),
        "latest": {"name": latest_issue["name"], "text": latest_issue.get("text", ""),
                   "saleTo": latest_issue.get("sale_to"), "presaleTo": latest_issue.get("presale_to")} if latest_issue else None,
        "periods": [p["name"] for p in plist],
        "counts": {"total": len(recent), "a": sum(1 for r in recent if r["kind"] == "a"),
                   "b": sum(1 for r in recent if r["kind"] == "b"),
                   "located": sum(1 for r in recent if r["lat"] is not None),
                   "recent": sum(1 for r in recent if r["date"] >= split)},
        "fields": FIELDS, "commFields": COMM_FIELDS, "detailFields": DETAIL_FIELDS,
        "flags": [{"bit": i, **t} for i, t in enumerate(flags.table)],
        "defaultExclude": flags.default_exclude_mask(),
        "btypes": BTYPES, "defaultBtypes": [BTYPES.index(b) for b in DEFAULT_BTYPES],
        "parkTypes": PARK_TYPES, "geoLevels": geocode.LEVELS, "approxLevels": sorted(geocode.APPROX),
        "districts": dist_meta, "sources": SOURCES,
        "rangeAll": {"from": first.isoformat(), "to": latest.isoformat()},
        "history": {"n": N_SHARDS, "files": hist_files},
        "search": search_name, "searchFields": SEARCH_FIELDS, "stats": stats_name,
    }
    _dump(out / "meta.json", meta, indent=1)
    return {"recent": len(recent), "districts": dist_meta, "sizes": sizes, "communities": len(n_comm),
            "entities": n_ent, "history_max": max(hist_sizes), "history_total": sum(hist_sizes)}


def short_addr(addr, district):
    """前端地址省略「桃園市（縣）」與行政區前綴，含升格前舊名（前端顯示時補回現在的行政區），檔案小約兩成"""
    return clean.strip_city(addr, district)


def _dump(path, obj, indent=None):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":") if indent is None else (",", ": "), indent=indent)


def _q(vals, q):
    vals = sorted(vals)
    if not vals:
        return None
    pos = (len(vals) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(vals) - 1)
    return round(vals[lo] + (vals[hi] - vals[lo]) * (pos - lo), 2)


TREND_START = dt.date(2012, 7, 1)  # 實價登錄 2012/8/1 上路；更早的交易日期多為補登或打錯，筆數太少不畫走勢


def quarterly(recs, flags):
    """季統計：各區（及全市）× 類別 × 季 的扣車位單價中位數、P25、P75、件數（排除預設特殊交易）"""
    ex = flags.default_exclude_mask()
    groups = {"大樓華廈": ("住宅大樓", "華廈"), "公寓": ("公寓",), "透天": ("透天",), "套房": ("套房",)}
    acc = collections.defaultdict(list)
    for r in recs:
        if r["mask"] & ex or r["unit"] is None or r["date"] < TREND_START:
            continue
        q = f"{r['date'].year}Q{(r['date'].month - 1) // 3 + 1}"
        if r["kind"] == "b":
            if r["btype"] not in DEFAULT_BTYPES:
                continue  # 預售的店面、辦公不算住宅行情
            g = "預售"
        else:
            g = next((k for k, v in groups.items() if r["btype"] in v), None)
        if not g:
            continue
        for d in (r["district"], "桃園市"):
            acc[(d, g, q)].append(r["unit"])
    rows = [[d, g, q, len(v), _q(v, 0.25), _q(v, 0.5), _q(v, 0.75)] for (d, g, q), v in sorted(acc.items())]
    return {"fields": ["district", "group", "quarter", "n", "p25", "p50", "p75"], "unit": "萬/坪", "rows": rows}


# ───────────────────────── 報告 ─────────────────────────

def make_summary(recs, raw, plist, per_counts, excluded, gstats, est, out_stats, flags, t0):
    lv_a = collections.Counter(r["level"] for r in recs if r["kind"] == "a")
    lv_b_proj = collections.Counter()
    seen = set()
    for r in recs:
        if r["kind"] == "b" and r.get("cid") and r["cid"] not in seen:
            seen.add(r["cid"])
            lv_b_proj[r["level"]] += 1
    fl = collections.Counter(n for r in recs for n in r["flags"])
    ex_mask = flags.default_exclude_mask()
    return {
        "generated": t0.isoformat(timespec="seconds"),
        "periods": [{"name": p["name"], "text": p.get("text", ""), **per_counts.get(p["name"], {})} for p in plist],
        "raw_total": len(raw), "kept": len(recs), "excluded": dict(excluded.most_common()),
        "geocode": {**gstats, "buildings": dict(sorted(lv_a.items())), "projects": dict(sorted(lv_b_proj.items()))},
        "flags": dict(fl.most_common()),
        "stats_excluded": sum(1 for r in recs if r["mask"] & ex_mask),
        "park_estimated": dict(est),
        "output": {"recent": out_stats["recent"], "communities": out_stats["communities"],
                   "entities": out_stats["entities"], "history_max": out_stats["history_max"],
                   "history_total": out_stats["history_total"],
                   "files": {k: v for k, v in out_stats["sizes"].items()}},
    }


def write_report(s):
    L = ["# 資料管線報告", "", f"- 產生時間：{s['generated']}",
         f"- 原始（去重後）：{s['raw_total']:,} 筆；保留房屋交易 {s['kept']:,} 筆；前端（近 {config.RECENT_YEARS} 年）{s['output']['recent']:,} 筆",
         f"- 推定社區＋預售建案：近 3 年 {s['output']['communities']:,} 個、2012 年起 {s['output']['entities']:,} 個",
         f"- 社區／建案歷史檔：{N_SHARDS} 份，合計 {s['output']['history_total'] / 1e6:.1f} MB（最大一份 {s['output']['history_max'] / 1e6:.2f} MB，未壓縮）",
         "", "## 各期筆數", "",
         "| 期別 | 買賣 | 預售 | 內容 |", "|---|---|---|---|"]
    for p in s["periods"]:
        L.append(f"| {p['name']} | {p.get('a', 0):,} | {p.get('b', 0):,} | {p['text'][:60]} |")
    g = s["geocode"]
    tot_a = sum(g["buildings"].values()) or 1
    tot_p = sum(g["projects"].values()) or 1
    L += ["", "## 定位", "", f"- 本次新定位 {g['new']:,} 個地址（OSM 查詢 {g['osm']} 次）；門牌資料月份 {g['doorplate_month'] or '（沿用快取）'}",
          "", "| 精度 | 買賣（筆） | 比例 | 預售建案（個） | 比例 |", "|---|---|---|---|---|"]
    for lv, name in geocode.LEVELS.items():
        a, b = g["buildings"].get(lv, 0), g["projects"].get(lv, 0)
        L.append(f"| {name} | {a:,} | {a / tot_a:.1%} | {b:,} | {b / tot_p:.1%} |")
    L += ["", "## 排除（不上地圖）", "", "| 原因 | 筆數 |", "|---|---|"]
    L += [f"| {k} | {v:,} |" for k, v in s["excluded"].items()]
    L += ["", f"## 旗標（預設不進統計 {s['stats_excluded']:,} 筆）", "", "| 旗標 | 筆數 |", "|---|---|"]
    L += [f"| {k} | {v:,} |" for k, v in s["flags"].items()]
    L += ["", f"車位估價：估車位價 {s['park_estimated'].get('price', 0):,} 筆、估車位面積 {s['park_estimated'].get('area', 0):,} 筆", "",
          "## 前端檔案大小", "", "| 行政區 | 成交檔 | 明細檔 |", "|---|---|---|"]
    L += [f"| {k} | {v[0] / 1e6:.2f} MB | {v[1] / 1e6:.2f} MB |" for k, v in s["output"]["files"].items()]
    config.REPORT_DIR.mkdir(exist_ok=True)
    (config.REPORT_DIR / "pipeline_report.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    with open(config.REPORT_DIR / "pipeline_summary.json", "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1, default=str)


def main(argv=None):
    config.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    s = build(offline=args.offline)
    print(f"完成：前端 {s['output']['recent']:,} 筆、社區 {s['output']['communities']:,} 個；報告 reports/pipeline_report.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
