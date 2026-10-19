"""資料清理：純函式，不讀檔、不連網，單元測試在 tests/test_clean.py。

單位約定
  面積：坪（m² × 0.3025）  金額：萬元  單價：萬/坪  日期：datetime.date
"""

import datetime as dt
import re

PING = 0.3025  # 1 m² = 0.3025 坪

# ───────────────────────── 日期 ─────────────────────────


def roc_date(s):
    """民國日期 → 西元 date。'1150821' → 2026-08-21；'0850528' → 1996-05-28；'850528' 也可。
    日為 00 時當 1 日；月為 00 或格式不對回傳 None。"""
    s = re.sub(r"\D", "", s or "")
    if len(s) == 7:
        y, m, d = int(s[:3]), int(s[3:5]), int(s[5:7])
    elif len(s) == 6:
        y, m, d = int(s[:2]), int(s[2:4]), int(s[4:6])
    elif len(s) == 5:  # 只有年月，例如 08505
        y, m, d = int(s[:3]), int(s[3:5]), 1
    else:
        return None
    if not 1 <= m <= 12 or y <= 0:
        return None
    for day in (max(d, 1), 28):  # 日期不合法（例如 2 月 30 日）就退到 28 日
        try:
            return dt.date(y + 1911, m, day)
        except ValueError:
            continue
    return None


def years_between(a, b):
    """兩個 date 相差幾年（小數一位）；任一缺值回傳 None"""
    if not a or not b:
        return None
    return round((b - a).days / 365.25, 1)


# ───────────────────────── 樓層 ─────────────────────────

_DIGIT = {"零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_number(s):
    """國字數字 → int：'十二' → 12、'二十一' → 21、'一百零一' → 101；阿拉伯數字照轉；無法辨識回傳 None"""
    s = (s or "").strip().translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total, cur = 0, 0
    for ch in s:
        if ch in _DIGIT:
            cur = _DIGIT[ch]
        elif ch == "十":
            total += (cur or 1) * 10
            cur = 0
        elif ch == "百":
            total += (cur or 1) * 100
            cur = 0
        else:
            return None
    return total + cur


_FLOOR_TOKEN = re.compile(r"(地下)?([零〇一二兩三四五六七八九十百\d]+)(?:層|樓|F)?$")


def parse_floors(s):
    """移轉層次 → {'floors': [樓層...], 'whole': 整棟, 'extra': [騎樓、夾層等附註]}
    '十二層' → [12]；'地下一層' → [-1]；'一層，二層' → [1, 2]；'一~二層' → [1, 2]；'全' → whole"""
    out = {"floors": [], "whole": False, "extra": []}
    s = (s or "").strip()
    if not s:
        return out
    if s == "全" or s.startswith("全"):
        out["whole"] = True
        return out
    s = s.replace("至", "~").replace("～", "~")
    for part in re.split(r"[，,、+＋;；/\s]+", s):
        if not part:
            continue
        rng = re.match(r"^(地下)?([零〇一二兩三四五六七八九十百\d]+)(?:層|樓)?~(地下)?([零〇一二兩三四五六七八九十百\d]+)(?:層|樓)?$", part)
        if rng:
            a, b = cn_number(rng.group(2)), cn_number(rng.group(4))
            if a is not None and b is not None and 0 < b - a < 100:
                out["floors"] += list(range(a, b + 1))
                continue
        if part == "地下層":
            out["floors"].append(-1)
            continue
        m = _FLOOR_TOKEN.match(part)
        n = cn_number(m.group(2)) if m else None
        if n is not None:
            out["floors"].append(-n if m.group(1) else n)
        else:
            out["extra"].append(part)
    out["floors"] = sorted(set(out["floors"]))
    return out


def main_floor(parsed):
    """代表樓層：地上最低的那層（一層＋二層 → 1）；只有地下層時回傳地下層"""
    above = [f for f in parsed["floors"] if f > 0]
    if above:
        return above[0]
    return parsed["floors"][0] if parsed["floors"] else None


def total_floors(s):
    """總樓層數：'十五層' 或 '15' → 15"""
    s = (s or "").strip().rstrip("層樓")
    return cn_number(s)


# ───────────────────────── 數值 ─────────────────────────


def num(s):
    """'1,234.5' → 1234.5；空白或無法轉換 → None"""
    s = (s or "").replace(",", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_ping(m2):
    return round(m2 * PING, 2) if m2 else 0.0


def to_wan(yuan):
    return round(yuan / 10000, 1) if yuan else 0.0


_COUNTS = re.compile(r"土地\s*(\d+)\s*建物\s*(\d+)\s*車位\s*(\d+)")


def parse_counts(s):
    """'土地1建物1車位1' → (1, 1, 1)；無法解析 → (0, 0, 0)"""
    m = _COUNTS.search(s or "")
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def unit_price_net(total_yuan, park_yuan, area_m2, park_m2):
    """扣車位單價（萬/坪）＝（總價 − 車位總價）÷（建物移轉面積 − 車位面積）。
    與官方「單價元平方公尺」在車位有拆價時相同。分母 ≤ 0 回傳 None。"""
    net_area = (area_m2 or 0) - (park_m2 or 0)
    net_price = (total_yuan or 0) - (park_yuan or 0)
    if net_area <= 0 or net_price <= 0:
        return None
    return round(net_price / 10000 / (net_area * PING), 2)


def area_breakdown(bldg_m2, park_m2, main_m2, aux_m2, balcony_m2):
    """面積拆解（坪）。實測陽台不含在附屬建物內（2026-10-18）：
    權狀（不含車位）＝建物移轉總面積 − 車位面積
    室內＝主建物
    公設＝權狀（不含車位）− 主建物 − 附屬建物 − 陽台
    公設比＝公設 ÷ 權狀（不含車位）
    缺主建物資料（例如預售表）時室內、公設、公設比回傳 None。"""
    net = (bldg_m2 or 0) - (park_m2 or 0)
    out = {"ping": to_ping(net) if net > 0 else 0.0, "ping_with_park": to_ping(bldg_m2 or 0),
           "indoor": None, "public": None, "public_ratio": None}
    if main_m2 and main_m2 > 0 and net > 0:
        public = net - main_m2 - (aux_m2 or 0) - (balcony_m2 or 0)
        out["indoor"] = to_ping(main_m2)
        if public >= -0.05 * net:  # 容許極小誤差；明顯為負代表資料有問題
            public = max(public, 0.0)
            out["public"] = to_ping(public)
            out["public_ratio"] = round(public / net, 3)
    return out


# ───────────────────────── 分類 ─────────────────────────

BTYPE_SHORT = [
    ("住宅大樓", "住宅大樓"), ("華廈", "華廈"), ("公寓", "公寓"), ("透天", "透天"), ("套房", "套房"),
    ("店面", "店面"), ("辦公", "辦公"), ("廠辦", "廠辦"), ("工廠", "工廠"), ("倉庫", "倉庫"), ("農舍", "農舍"),
]


def btype_short(s):
    """建物型態簡稱：'住宅大樓(11層含以上有電梯)' → '住宅大樓'；'透天厝' → '透天'；其他 → '其他'"""
    s = s or ""
    for key, short in BTYPE_SHORT:
        if key in s:
            return short
    return "其他"


def has_elevator(raw, btype):
    """電梯：買賣表有欄位；預售表沒有，依建物型態推定（住宅大樓、華廈定義上有電梯）"""
    if raw in ("有", "無"):
        return raw == "有"
    if btype in ("住宅大樓", "華廈"):
        return True
    if btype in ("公寓", "透天"):
        return False
    return None


PARK_KIND = {"坡道平面": "坡平", "一樓平面": "一樓平面", "升降平面": "升降平面",
             "坡道機械": "坡機", "升降機械": "升降機械", "塔式車位": "塔式", "其他": "其他"}


def park_group(ptype):
    """車位篩選用大類：平面／機械"""
    if not ptype:
        return None
    return "機械" if ("機械" in ptype or "塔式" in ptype) else "平面"


# ───────────────────────── 特殊交易 ─────────────────────────


def match_flags(note, rules):
    """備註比對特殊交易關鍵字。rules：[(旗標, [關鍵字...]), ...]，回傳命中的旗標清單（依 rules 順序）"""
    note = note or ""
    return [flag for flag, kws in rules if any(k in note for k in kws)]


def is_presale_handover(note):
    """買賣表中由預售屋交屋（或土地建物分件登記）而來的紀錄：交易日期是當年簽約日"""
    return "預售屋、或土地及建物分件登記" in (note or "")


def cancel_info(s):
    """預售屋解約情形：'1150725全部解約' → (True, date(2026,7,25))；空白 → (False, None)"""
    s = s or ""
    if "解約" not in s:
        return False, None
    m = re.search(r"(\d{7})", s)
    return True, roc_date(m.group(1)) if m else None


# ───────────────────────── 地址 ─────────────────────────

_FW = str.maketrans("０１２３４５６７８９－～（）", "0123456789-~()")
_PUA = re.compile(r"[-]")  # 私用區字元（內政部資料的罕用字／缺字）


def norm_text(s):
    """全形數字 → 半形、臺 → 台、去空白"""
    return (s or "").translate(_FW).replace("臺", "台").replace(" ", "").replace("　", "")


def has_pua(s):
    return bool(_PUA.search(s or ""))


_ADDR = re.compile(
    r"^(?P<road>.+?)(?P<lane>\d+巷)?(?P<alley>\d+弄)?(?P<xiang>\d+衖)?"
    r"(?P<no>\d+)(?:之(?P<sub1>\d+))?(?:[、,及~-]\d+(?:之\d+)?)*號(?:之(?P<sub2>\d+))?")
_VILLAGE = re.compile(r"^(?:\D{1,4}?[里村])?(?:\d+鄰)?")


def parse_address(addr, district):
    """實價登錄門牌 → 棟級門牌 dict（去樓層）。純地號或無門牌號回傳 None。
    '桃園市中壢區中央西路二段２５０號十二樓之３' → road=中央西路二段, no=250
    '樓之N' 的 N 是戶號不屬於門牌；'號之N'（樓層前）才是門牌之號。"""
    s = norm_text(addr)
    s = re.sub(r"^(桃園市|桃園縣)", "", s)
    s = re.sub("^" + re.escape(district or ""), "", s)
    if "地號" in s:
        return None
    m = _ADDR.match(s)
    if not m:
        return None
    road = m.group("road")
    sub = m.group("sub1") or m.group("sub2")
    return {
        "district": district,
        "road": road,
        "road_no_village": _VILLAGE.sub("", road) or road,
        "lane": m.group("lane") or "",
        "alley": m.group("alley") or "",
        "xiang": m.group("xiang") or "",
        "no": m.group("no") + (f"之{sub}" if sub else ""),
    }


def building_key(p, road=None):
    """棟級門牌鍵，例如 '中壢區|中央西路二段|||250'。road 傳入定位時比對到的正式路名（去掉里鄰前綴）"""
    if not p:
        return None
    return "|".join([p["district"], road or p["road"], p["lane"], p["alley"] + p["xiang"], p["no"]])
