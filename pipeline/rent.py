"""租賃資料（lvr_land_c）：讀檔、清理、輸出前端租賃檔。

只做近 3 年（2020 年前每年只有一、兩千筆）。定位與買賣共用棟級門牌快取（同一棟樓的租約與買賣用同一個鍵）。
前端切換到「租賃」時才下載各區租賃檔，不影響買賣首屏速度。
"""

import collections
import zipfile

from . import clean

RENT_TYPES = ["整棟(戶)出租", "分層出租", "獨立套房", "分租套房", "分租雅房"]
WHOLE_TYPES = {"整棟(戶)出租", "分層出租"}  # 毛租金報酬率只用整層住家
SERVICES = ["社會住宅代管", "社會住宅包租轉租", "一般代管", "一般轉租", "一般包租"]
# 租賃旗標：名稱, 預設排除, 說明
FLAGS = [
    ("社宅包租代管", True, "社會住宅包租代管的租約，租金通常約市價 8 折，預設不進租金統計"),
    ("親友關係", True, "備註寫明親友、員工等特殊關係"),
    ("租金異常", True, "每坪月租低於 50 元或高於 5,000 元，或面積不到 1 坪（多為打錯或只租部分空間）"),
    ("含車位", False, "租約含車位；有車位租金時已扣除，沒拆價的照總額算"),
    ("非整層", False, "套房、雅房等，不進毛租金報酬率"),
]
FIELDS = ["id", "d", "lat", "lon", "geo", "addr", "cm", "bt", "fl", "tf", "age", "rm", "hl", "ba",
          "pg", "rent", "ru", "rt", "sv", "fu", "mg", "el", "pt", "pp", "fx"]
_FRIEND = ("親友", "員工", "特殊關係")


def load(plist):
    """各期依新舊讀入租賃主表，同編號後面（較新）的覆蓋前面。回傳 {編號: (列, 期別)}"""
    from .build import _read_csv  # 共用讀檔（編碼判斷、略過英文欄名列）

    out = {}
    for p in plist:
        with zipfile.ZipFile(p["path"]) as zf:
            if "h_lvr_land_c.csv" not in zf.namelist():
                continue
            header, body = _read_csv(zf, "h_lvr_land_c.csv")
            for r in body:
                d = dict(zip(header, r))
                rid = (d.get("編號") or "").strip()
                if rid:
                    out[rid] = (d, p["name"])
    return out


def _mask(names):
    m = 0
    for i, (n, _, _) in enumerate(FLAGS):
        if n in names:
            m |= 1 << i
    return m


def default_exclude_mask():
    return _mask([n for n, ex, _ in FLAGS if ex])


def clean_rent(d, since, today):
    """回傳 (紀錄, None) 或 (None, 排除原因)"""
    target = d.get("交易標的", "")
    if "建物" not in target and "房屋" not in target:
        return None, "沒有建物（只租土地或車位）"
    date = clean.roc_date(d.get("租賃年月日"))
    if not date:
        return None, "租賃日期無法解析"
    if date < since or date > today:
        return None, "不在近 3 年"
    bt = clean.btype_short(d.get("建物型態"))
    fl = clean.parse_floors(d.get("租賃層次"))
    built = clean.roc_date(d.get("建築完成年月"))
    area = clean.num(d.get("建物總面積平方公尺")) or 0
    park_area = clean.num(d.get("車位面積平方公尺")) or 0
    park_rent = clean.num(d.get("車位總額元")) or 0
    total = clean.num(d.get("總額元")) or 0
    ptype = (d.get("車位類別") or "").strip()
    has_park = "車位" in target or bool(ptype)
    rent = total - park_rent if park_rent and park_rent < total else total
    ping = (area - park_area if park_area and park_area < area else area) * clean.PING
    ru = rent / ping if ping >= 1 else None
    rtype = (d.get("出租型態") or "").strip()
    service = (d.get("租賃住宅服務") or "").strip()
    names = []
    if service.startswith("社會住宅"):
        names.append("社宅包租代管")
    if any(k in (d.get("備註") or "") for k in _FRIEND):
        names.append("親友關係")
    if ru is None or not 50 <= ru <= 5000:
        names.append("租金異常")
    if has_park:
        names.append("含車位")
    if rtype and rtype not in WHOLE_TYPES:
        names.append("非整層")
    yn = {"有": 1, "無": 0}
    return {
        "id": d["編號"].strip(), "district": d.get("鄉鎮市區", ""), "date": date,
        "addr": clean.norm_text(d.get("土地位置建物門牌")),
        "parsed": clean.parse_address(d.get("土地位置建物門牌"), d.get("鄉鎮市區")),
        "btype": bt, "floor": clean.main_floor(fl), "total_floors": clean.total_floors(d.get("總樓層數")),
        "age": clean.years_between(built, date),
        "rooms": _int(d.get("建物現況格局-房")), "halls": _int(d.get("建物現況格局-廳")), "baths": _int(d.get("建物現況格局-衛")),
        "ping": ping, "rent": rent, "ru": ru,
        "rtype": RENT_TYPES.index(rtype) if rtype in RENT_TYPES else -1,
        "service": SERVICES.index(service) if service in SERVICES else -1,
        "furniture": yn.get((d.get("有無附傢俱") or "").strip()),
        "manager": yn.get((d.get("有無管理員") or "").strip()),
        "elevator": yn.get((d.get("有無電梯") or "").strip()),
        "park_type": ptype, "park_rent": park_rent if has_park else None,
        "mask": _mask(names),
    }, None


def _int(s):
    v = clean.num(s)
    return int(v) if v is not None else None


def build(plist, since, today):
    """回傳 (租賃紀錄清單, 排除原因統計)"""
    raw = load(plist)
    recs, excluded = [], collections.Counter()
    for d, _ in raw.values():
        r, why = clean_rent(d, since, today)
        if r:
            recs.append(r)
        else:
            excluded[why] += 1
    return recs, excluded
