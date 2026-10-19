"""檢查前端資料：單檔 gzip 後不可超過 5 MB（SPEC）。超過時結束碼 1。"""

import gzip
import sys

from . import config

LIMIT = 5 * 1024 * 1024


def main():
    config.utf8_stdout()
    bad = []
    rows = []
    for p in sorted(config.OUT_DIR.rglob("*.json")):
        raw = p.read_bytes()
        gz = len(gzip.compress(raw, 6))
        rows.append((p.relative_to(config.OUT_DIR).as_posix(), len(raw), gz))
        if gz > LIMIT:
            bad.append(p.name)
    for name, raw, gz in sorted(rows, key=lambda r: -r[2])[:8]:
        print(f"  {name:28s} 原始 {raw / 1e6:6.2f} MB  gzip {gz / 1e6:5.2f} MB")
    total = sum(r[2] for r in rows)
    print(f"  共 {len(rows)} 檔，gzip 合計 {total / 1e6:.2f} MB")
    if bad:
        print(f"超過 5 MB：{', '.join(bad)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
