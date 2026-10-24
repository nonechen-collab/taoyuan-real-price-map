"""建置流程中的小工具：同地段推估預售建案位置。

執行：python -m unittest discover -s tests -t .
"""

import unittest

from pipeline import build


def _rec(rid, lat, lon, level, cid):
    return {"kind": "a", "id": rid, "lat": lat, "lon": lon, "level": level, "cid": cid}


class TestSectionEstimate(unittest.TestCase):
    def setUp(self):
        recs = [
            _rec("A1", 25.0000, 121.0000, 1, "c1"),
            _rec("A2", 25.0005, 121.0005, 1, "c2"),
            _rec("A3", 25.0010, 121.0010, 3, "c3"),
            _rec("A4", 24.9000, 121.1000, 1, "c4"),  # 地號差太多，不採用
            _rec("A5", 25.2000, 121.2000, 5, "c5"),  # 概略位置不當參考點
            _rec("B1", 25.0000, 121.0000, 1, "c6"),  # 另一段：兩點相距約 15 公里
            _rec("B2", 25.1000, 121.1000, 1, "c7"),
        ]
        parcels = {
            ("a", "A1"): {"中壢區|中運段|02000000"},
            ("a", "A2"): {"中壢區|中運段|02050000"},
            ("a", "A3"): {"中壢區|中運段|02100001"},
            ("a", "A4"): {"中壢區|中運段|09000000"},
            ("a", "A5"): {"中壢區|中運段|02070000"},
            ("a", "B1"): {"中壢區|散段|01000000"},
            ("a", "B2"): {"中壢區|散段|01010000"},
        }
        self.idx = build._section_index(recs, parcels)

    def test_parcel_main(self):
        self.assertEqual(build._parcel_main("02070000"), 207)
        self.assertEqual(build._parcel_main("207"), 207)
        self.assertIsNone(build._parcel_main("123456"))

    def test_nearest(self):
        lat, lon = build._estimate(self.idx, {"中壢區|中運段|02070000"}, set())
        self.assertAlmostEqual(lat, 25.0005, places=4)
        self.assertAlmostEqual(lon, 121.0005, places=4)

    def test_exclude_self(self):
        # 驗證時要排除建案自己與交屋社區
        lat, lon = build._estimate(self.idx, {"中壢區|中運段|02070000"}, {"c2"})
        self.assertAlmostEqual(lat, 25.0005, places=4)  # 剩 c1、c3 的中點

    def test_gap_too_large(self):
        self.assertIsNone(build._estimate(self.idx, {"中壢區|中運段|05000000"}, set()))

    def test_other_district_or_section(self):
        self.assertIsNone(build._estimate(self.idx, {"平鎮區|中運段|02070000"}, set()))

    def test_too_scattered(self):
        self.assertIsNone(build._estimate(self.idx, {"中壢區|散段|01000000"}, set()))



class TestTradesAndDrops(unittest.TestCase):
    def _r(self, rid, date, unit, addr="桃園市中壢區中正路1號五樓", cid="c1", mask=0, btype="住宅大樓"):
        import datetime as dt
        return {"kind": "a", "id": rid, "district": "中壢區", "addr": addr, "date": dt.date(*date), "unit": unit,
                "cid": cid, "mask": mask, "btype": btype, "flags": []}

    def test_count_trades(self):
        recs = [self._r("A", (2015, 3, 1), 20), self._r("B", (2021, 6, 1), 30),
                self._r("C", (2018, 1, 1), 25, addr="桃園縣中壢市中正路1號五樓"),  # 升格前的舊地址也算同一戶
                self._r("D", (2020, 1, 1), 28, addr="桃園市中壢區中正路1號六樓")]
        self.assertEqual(build.count_trades(recs), 3)
        by = {r["id"]: r for r in recs}
        self.assertEqual((by["A"]["to"], by["C"]["to"], by["B"]["to"]), (1, 2, 3))
        self.assertEqual(by["B"]["tn"], 3)
        self.assertNotIn("tn", by["D"])

    def test_price_drop(self):
        from pipeline import rules
        flags = rules.Flags()
        recs = [self._r(f"P{i}", (2025, m, 1), 40, addr=f"x{i}") for i, m in enumerate((1, 2, 3, 4))]
        cheap = self._r("Q", (2025, 6, 1), 37.5, addr="q")  # 比前 12 個月中位 40 低 6.25%
        near = self._r("R", (2025, 7, 1), 39, addr="r")  # 只低 2.5%，不算
        excluded = self._r("S", (2025, 8, 1), 20, addr="s", mask=flags.default_exclude_mask() & -flags.default_exclude_mask())
        recs += [cheap, near, excluded]
        self.assertEqual(build.mark_price_drops(recs, flags), 1)
        self.assertIn("降價", cheap["flags"])
        self.assertNotIn("降價", near["flags"])
        self.assertNotIn("降價", excluded["flags"])
        self.assertTrue(cheap["mask"] & flags.bit["降價"])


if __name__ == "__main__":
    unittest.main()
