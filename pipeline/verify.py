"""Phase 1 驗收抽樣：產生 reports/phase1_verify.md（本機執行，需要門牌坐標資料）

A. 抽 20 筆成交：本站顯示的總價、面積、單價 vs 內政部原始欄位，自動檢查換算是否一致
B. 抽 20 筆定位：同一路段前後門牌的距離（官方門牌資料人工標點，偶有標錯；> 100 m 列為疑似）
   並附地圖連結，方便目視確認

用法：python -m pipeline.verify
"""

import json
import math
import random
import re
import sys

from . import clean, config, doorplate
from .build import FIELDS

SEED = 20261019


def load_front():
    meta = json.loads((config.OUT_DIR / "meta.json").read_text(encoding="utf-8"))
    rows, details = [], {}
    for d in meta["districts"]:
        for part in d["parts"]:
            t = json.loads((config.OUT_DIR / part["file"]).read_text(encoding="utf-8"))
            det = json.loads((config.OUT_DIR / part["detail"]).read_text(encoding="utf-8"))
            f = {k: i for i, k in enumerate(t["fields"])}
            for r in t["rows"]:
                rows.append({k: r[f[k]] for k in FIELDS} | {"district": d["name"]})
            for k, v in det["rows"].items():
                details[k] = dict(zip(det["fields"], v))
    return meta, rows, details


def part_a(rows, details, rng):
    pool = [r for r in rows if r["k"] == 0 and r["up"] is not None]
    pick = rng.sample(pool, 20)
    out = ["## A. 抽 20 筆成交：換算是否與官方原始值一致", "",
           "| # | 交易日 | 地址 | 本站總價 | 官方總價元 | 本站權狀坪（含車位） | 官方建物 m² | 本站扣車位單價 | 官方單價 元/m² → 萬/坪 | 判定 |",
           "|---|---|---|---|---|---|---|---|---|---|"]
    ok = 0
    for i, r in enumerate(pick, 1):
        d = details[r["id"]]
        tp_off = clean.num(d["總價元"]) or 0
        area = clean.num(d["建物移轉總面積平方公尺"]) or 0
        unit_off = clean.num(d["單價元平方公尺"]) or 0
        park_price = clean.num(d["車位總價元"]) or 0
        ping_all = (r["pg"] or 0) + (r["pa"] or 0)
        checks = [abs(r["tp"] - tp_off / 1e4) < 0.06, abs(ping_all - area * clean.PING) < 0.11]  # 坪數存到 0.1 坪
        if r["pn"] and park_price == 0:
            verdict = "車位未拆價：本站估算扣除，與官方不同屬預期"
            checks.append(True)
        else:
            checks.append(abs(r["up"] - unit_off / 3025) < 0.06)
            verdict = "一致" if all(checks) else "不一致"
        ok += all(checks)
        out.append(f"| {i} | {str(r['d'])[:4]}/{str(r['d'])[4:6]}/{str(r['d'])[6:]} | {r['district']}{r['addr']} | "
                   f"{r['tp']:,.1f} 萬 | {tp_off:,.0f} | {ping_all:.2f} | {area:.2f} | {r['up']:.2f} | "
                   f"{unit_off:,.0f} → {unit_off / 3025:.2f} | {verdict if all(checks) else '❌ ' + verdict} |")
    out += ["", f"結果：{ok}／20 筆換算正確。可到內政部實價登錄網站（https://lvr.land.moi.gov.tw/）以地址與交易日查同一筆比對。", ""]
    return out, ok


def part_b(rows, details, rng):
    month, path = doorplate.ensure_latest()
    dp = doorplate.DoorPlates(path, month)
    lv = {}
    for r in rows:
        if r["lat"] is not None:
            lv.setdefault(r["geo"], []).append(r)
    # 分層抽樣：門牌 12、鄰近 3、巷弄／路段 2、預售 3
    pick = rng.sample([r for r in lv.get(1, []) if r["k"] == 0], 12)
    pick += rng.sample([r for r in lv.get(2, []) if r["k"] == 0] or lv.get(2, []), 3)
    pick += rng.sample([r for g in (4, 5) for r in lv.get(g, []) if r["k"] == 0] or lv.get(5, []), 2)
    pick += rng.sample([r for g in (1, 2, 3) for r in lv.get(g, []) if r["k"] == 1], 3)
    levels = {1: "門牌", 2: "鄰近門牌", 3: "交叉口", 4: "巷弄", 5: "路段"}
    out = ["## B. 抽 20 筆定位", "",
           "官方門牌資料由戶政事務所人工標點。檢查方式：找同一路段（巷弄）前後最近的門牌，量距離；"
           "> 100 m 列為疑似（可能是官方標點錯誤或推估誤差）。點地圖連結可目視確認。", "",
           "| # | 類別 | 地址 | 精度 | 與前後門牌距離 | 判定 | 地圖 |", "|---|---|---|---|---|---|---|"]
    flagged = 0
    for i, r in enumerate(pick, 1):
        key = details[r["id"]].get("對應門牌", "")
        parts = key.split("|")
        dist = None
        if len(parts) == 5 and parts[4]:
            lk = tuple(parts[:4])
            n = int(re.match(r"\d+", parts[4]).group())
            nums = sorted(dp.lane_nums.get(lk, []), key=lambda t: abs(t[0] - n))
            me = dp.bld.get(tuple(parts))
            near = [k for num, k in nums if k != tuple(parts) and abs(num - n) <= 6][:2]
            if me and near:
                dist = min(math.dist(me, dp.bld[k]) for k in near)
        if dist is None:
            verdict = "推估位置，無前後門牌可比" if r["geo"] >= 3 else "無前後門牌可比"
        elif dist > 100:
            verdict = "⚠ 疑似誤差 > 100 m"
            flagged += 1
        else:
            verdict = "合理"
        link = f"[開地圖](https://www.google.com/maps?q={r['lat']},{r['lon']})"
        out.append(f"| {i} | {'預售' if r['k'] else '買賣'} | {r['district']}{r['addr']} | {levels.get(r['geo'], r['geo'])} | "
                   f"{'—' if dist is None else f'{dist:.0f} m'} | {verdict} | {link} |")
    out += ["", f"結果：{flagged} 筆疑似誤差 > 100 m。", ""]
    return out, flagged


def main():
    config.utf8_stdout()
    rng = random.Random(SEED)
    meta, rows, details = load_front()
    a, ok = part_a(rows, details, rng)
    b, flagged = part_b(rows, details, rng)
    head = ["# Phase 1 驗收抽樣", "", f"- 資料：{meta['generated']}，共 {len(rows):,} 筆（固定亂數種子 {SEED}，可重現）", ""]
    (config.REPORT_DIR / "phase1_verify.md").write_text("\n".join(head + a + b) + "\n", encoding="utf-8")
    print(f"A：{ok}/20 換算正確；B：{flagged} 筆疑似 > 100 m；報告 reports/phase1_verify.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
