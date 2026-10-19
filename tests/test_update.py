"""排程異常偵測：新一期 0 筆或暴增要擋下（保留舊資料），正常筆數要放行"""

import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from pipeline import config, update

HEADER = "鄉鎮市區,編號\nThe villages,serial number\n"


def make_issue(folder, sale_to, a_rows, b_rows=100):
    path = Path(folder) / f"issue-{sale_to}.zip"
    y, rest = str(sale_to)[:3], str(sale_to)[3:]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("h_lvr_land_a.csv", HEADER + "".join(f"桃園區,A{i}\n" for i in range(a_rows)))
        z.writestr("h_lvr_land_b.csv", HEADER + "".join(f"桃園區,B{i}\n" for i in range(b_rows)))
        z.writestr("build_time.xml", f"<lvr_time>資料內容：登記日期 {y}年{rest[:2]}月01日至 {y}年{int(rest[:2])}月{int(rest[2:])}日之買賣案件，"
                                     f"及交易日期{y}年{rest[:2]}月01日至 {y}年{int(rest[:2])}月{int(rest[2:])}日之預售屋案件</lvr_time>")
    return path.stem


class TestAnomaly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = mock.patch.object(config, "PERIODS_DIR", Path(self.tmp.name))
        self.patch.start()
        for i, d in enumerate([1150710, 1150720, 1150731, 1150810, 1150820]):
            make_issue(self.tmp.name, d, 1100 + i * 20)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_rows_in_skips_two_header_lines(self):
        name = make_issue(self.tmp.name, 1150831, 7)
        self.assertEqual(update.rows_in(Path(self.tmp.name) / f"{name}.zip")["a"], 7)

    def test_normal_passes(self):
        name = make_issue(self.tmp.name, 1150910, 1250)
        self.assertEqual(update.check([name]), [])

    def test_zero_rows_flagged(self):
        name = make_issue(self.tmp.name, 1150910, 0)
        problems = update.check([name])
        self.assertTrue(any("0 筆" in p for p in problems))

    def test_surge_flagged(self):
        name = make_issue(self.tmp.name, 1150910, 9000)
        problems = update.check([name])
        self.assertTrue(any("倍" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
