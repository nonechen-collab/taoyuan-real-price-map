"""排程入口：下載新期別 → 檢查筆數 → 異常就退回（保留舊資料）並留下通知內容。

結束碼
  0  正常（有或沒有新資料）
  2  下載失敗（被擋、連不上）：保留舊資料，workflow 會開 Issue
  3  新期別筆數異常（0 筆或暴增）：新檔已移除、保留舊資料，workflow 會開 Issue
問題說明寫在 reports/update_alert.md，workflow 用它當 Issue 內容。
"""

import statistics
import sys
import zipfile

from . import config, periods

ALERT = config.REPORT_DIR / "update_alert.md"
SURGE = 4.0  # 超過一般期數的幾倍視為暴增


def rows_in(path):
    """期別 zip 內買賣、預售主表的資料列數（扣掉中英文兩列欄名）"""
    out = {}
    with zipfile.ZipFile(path) as zf:
        for kind in "ab":
            name = f"h_lvr_land_{kind}.csv"
            if name in zf.namelist():
                out[kind] = max(0, zf.read(name).count(b"\n") - 2)
    return out


def check(new_names):
    """回傳異常說明清單；空清單代表正常"""
    allp = periods.list_periods()
    issues = [p for p in allp if p["kind"] == "issue" and p["name"] not in new_names]
    seasons = [p for p in allp if p["kind"] == "season" and p["name"] not in new_names]
    base = {}
    for kind in "ab":
        vals = [rows_in(p["path"]).get(kind, 0) for p in issues[-12:]]
        if len(vals) < 3:  # 歷史期數不夠：用季檔 ÷ 9（一季約 9 期）
            vals += [rows_in(p["path"]).get(kind, 0) / 9 for p in seasons[-4:]]
        base[kind] = statistics.median(vals) if vals else None
    problems = []
    for p in allp:
        if p["name"] not in new_names:
            continue
        n = rows_in(p["path"])
        scale = 9 if p["kind"] == "season" else 1
        for kind, label in (("a", "買賣"), ("b", "預售")):
            b = base.get(kind)
            v = n.get(kind, 0)
            if v == 0:
                problems.append(f"{p['name']} 的{label}是 0 筆")
            elif b and v > b * scale * SURGE:
                problems.append(f"{p['name']} 的{label} {v:,} 筆，超過一般的 {SURGE:.0f} 倍（一般約 {b * scale:,.0f} 筆）")
    return problems


def main(argv=None):
    config.utf8_stdout()
    config.REPORT_DIR.mkdir(exist_ok=True)
    if ALERT.exists():
        ALERT.unlink()
    log = periods.update()
    for r in log:
        print(periods._fmt(r))
    failed = [r for r in log if not r["ok"]]
    new = [r["name"] for r in log if r.get("new")]
    if failed:
        lines = ["## 實價登錄資料下載失敗", "", "已保留上一版資料，網站照常顯示舊資料。", ""]
        lines += [f"- {r['label']}：{r.get('error')}{'（疑似被網站防火牆擋下）' if r.get('blocked') else ''}" for r in failed]
        lines += ["", "下次排程會自動重試；連續失敗可改在自己電腦執行 `python -m pipeline.periods update` 後推送。"]
        ALERT.write_text("\n".join(lines) + "\n", encoding="utf-8")
        if not new:
            return 2
    problems = check(new)
    if problems:
        for name in new:
            (config.PERIODS_DIR / f"{name}.zip").unlink(missing_ok=True)
        lines = ["## 新一期實價登錄筆數異常", "", "新檔已移除，網站保留上一版資料。請人工確認內政部資料是否正常：", ""]
        lines += [f"- {x}" for x in problems]
        ALERT.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("\n".join(problems))
        return 3
    print(f"新期別：{', '.join(new) if new else '無'}")
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
