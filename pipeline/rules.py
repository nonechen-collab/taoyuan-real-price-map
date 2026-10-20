"""特殊交易關鍵字與計算旗標。關鍵字清單在 special_keywords.csv，可直接改檔調整。

每筆交易的旗標存成一個整數（位元），前端依 meta.json 的 flags 表顯示與篩選。
"""

import csv
from pathlib import Path

KEYWORDS_CSV = Path(__file__).with_name("special_keywords.csv")

# 程式計算出的旗標（排在關鍵字旗標後面）
COMPUTED = [
    # 旗標, 預設排除, 說明
    ("預售交屋", True, "買賣表中由預售屋交屋而來，交易日期是當年簽約日；不進中古屋行情，避免與預售表重複"),
    ("解約", True, "預售屋已解約"),
    ("整棟", True, "大樓、華廈、公寓、套房、辦公整棟移轉（移轉層次「全」）；透天厝不算"),
    ("多棟", True, "一筆交易含 2 棟以上建物，單價失真"),
    ("車位未拆價", False, "有車位但車位價為 0；扣車位單價用同社區／同區車位中位價估算"),
    ("車位面積未拆", False, "有車位但車位面積為 0（面積含在建物裡）；扣車位面積用中位數估算"),
    ("單價估算", False, "扣車位單價含估算成分"),
    ("無單價", True, "總價或面積缺漏，算不出單價"),
    ("合宜住宅", True, "政府合宜住宅配售（資格限定、價格遠低於市價）；依土地段別與簽約期間辨識，見 AFFORDABLE"),
]

# 政府合宜住宅配售：資料沒有欄位可判斷（備註空白、沒有建案名稱），只能用土地段別＋簽約期間辨識
AFFORDABLE = [
    # (行政區, 土地段別, 起日, 迄日, 說明)
    ("龜山區", "牛角坡段樟腦寮小段", "2013-01-01", "2014-12-31", "A7 合宜住宅（2013 年抽籤配售，約 2,600 戶，每坪約 14 萬）"),
]


def affordable(district, sections, date):
    """sections：這筆交易的土地段別集合；date：datetime.date"""
    d = date.isoformat()
    return any(district == dist and sec in sections and a <= d <= b for dist, sec, a, b, _ in AFFORDABLE)


def load_keywords(path=KEYWORDS_CSV):
    """回傳 [(旗標, [關鍵字...], 預設排除), ...]"""
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            kws = [k.strip() for k in r["關鍵字"].split("|") if k.strip()]
            if r["旗標"].strip() and kws:
                out.append((r["旗標"].strip(), kws, r["預設排除"].strip() == "是"))
    return out


class Flags:
    """旗標名稱 ↔ 位元"""

    def __init__(self, keyword_rules=None):
        self.keyword_rules = keyword_rules if keyword_rules is not None else load_keywords()
        self.table = [{"name": n, "exclude": ex, "source": "備註"} for n, _, ex in self.keyword_rules]
        self.table += [{"name": n, "exclude": ex, "source": "計算", "note": note} for n, ex, note in COMPUTED]
        self.bit = {t["name"]: 1 << i for i, t in enumerate(self.table)}
        self.rules = [(n, kws) for n, kws, _ in self.keyword_rules]

    def mask(self, names):
        m = 0
        for n in names:
            m |= self.bit[n]
        return m

    def names(self, mask):
        return [t["name"] for i, t in enumerate(self.table) if mask >> i & 1]

    def default_exclude_mask(self):
        return self.mask(t["name"] for t in self.table if t["exclude"])
