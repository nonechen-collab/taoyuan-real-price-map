"""清理模組單元測試。樣本都取自內政部桃園實價登錄開放資料（註明編號，可回查）。

執行：python -m unittest discover -s tests
"""

import datetime as dt
import unittest

from pipeline import clean, rules


class TestRocDate(unittest.TestCase):
    def test_real_samples(self):
        # RPSOMLLKRHLGFAH68DA 南華街 交易日
        self.assertEqual(clean.roc_date("1150902"), dt.date(2026, 9, 2))
        # RPSNMLKKRHLGFEH88DA 南順六街 建築完成年月（民國 85 年，前面補 0）
        self.assertEqual(clean.roc_date("0850528"), dt.date(1996, 5, 28))
        # RPPNMLLLRHLGFFH88DA 永豐路 建築完成年月
        self.assertEqual(clean.roc_date("1141208"), dt.date(2025, 12, 8))
        # RPPQMLQKRHLGFAH09DA 南平路 建築完成年月
        self.assertEqual(clean.roc_date("0720628"), dt.date(1983, 6, 28))

    def test_edge_cases(self):
        self.assertEqual(clean.roc_date("850528"), dt.date(1996, 5, 28))
        self.assertEqual(clean.roc_date("1150200"), dt.date(2026, 2, 1))   # 日為 00
        self.assertEqual(clean.roc_date("1150230"), dt.date(2026, 2, 28))  # 不存在的日期
        self.assertIsNone(clean.roc_date("1151301"))
        self.assertIsNone(clean.roc_date(""))
        self.assertIsNone(clean.roc_date(None))

    def test_age(self):
        # 南順六街：1996-05-28 完工，2026-08-21 交易 → 30.2 年
        self.assertEqual(clean.years_between(clean.roc_date("0850528"), clean.roc_date("1150821")), 30.2)
        self.assertIsNone(clean.years_between(None, dt.date(2026, 1, 1)))


class TestFloors(unittest.TestCase):
    def test_real_samples(self):
        self.assertEqual(clean.parse_floors("十一層")["floors"], [11])      # 南華街
        self.assertEqual(clean.parse_floors("二十一層")["floors"], [21])
        self.assertEqual(clean.parse_floors("地下一層")["floors"], [-1])
        self.assertEqual(clean.parse_floors("地下層")["floors"], [-1])
        p = clean.parse_floors("一層，騎樓")
        self.assertEqual((p["floors"], p["extra"]), ([1], ["騎樓"]))
        self.assertEqual(clean.parse_floors("一層，二層")["floors"], [1, 2])
        self.assertEqual(clean.parse_floors("一層+二層")["floors"], [1, 2])   # 預售表寫法
        self.assertEqual(clean.parse_floors("一~二層")["floors"], [1, 2])
        self.assertEqual(clean.parse_floors("1，2，3")["floors"], [1, 2, 3])
        self.assertTrue(clean.parse_floors("全")["whole"])
        self.assertEqual(clean.parse_floors("見使用執照")["floors"], [])

    def test_main_floor(self):
        self.assertEqual(clean.main_floor(clean.parse_floors("一層，二層，騎樓")), 1)
        self.assertEqual(clean.main_floor(clean.parse_floors("地下二層")), -2)
        self.assertIsNone(clean.main_floor(clean.parse_floors("全")))

    def test_total_floors(self):
        self.assertEqual(clean.total_floors("十三層"), 13)   # 買賣表：國字
        self.assertEqual(clean.total_floors("二十八層"), 28)
        self.assertEqual(clean.total_floors("15"), 15)       # 預售表：阿拉伯數字
        self.assertIsNone(clean.total_floors(""))

    def test_cn_number(self):
        self.assertEqual(clean.cn_number("十"), 10)
        self.assertEqual(clean.cn_number("三十五"), 35)
        self.assertEqual(clean.cn_number("一百零一"), 101)
        self.assertIsNone(clean.cn_number("騎樓"))


class TestUnitPrice(unittest.TestCase):
    """扣車位單價：車位有拆價時應與官方「單價元平方公尺」一致（萬/坪 × 3025 ＝ 元/m²）"""

    def check(self, total, park, area, park_area, official, expect):
        got = clean.unit_price_net(total, park, area, park_area)
        self.assertEqual(got, expect)
        self.assertAlmostEqual(got, official / 3025, delta=0.01)

    def test_real_samples(self):
        # RPSOMLLKRHLGFAH68DA 桃園區南華街128號十一樓之2
        self.check(17200000, 2100000, 159.47, 46.3, 133428, 44.11)
        # RPRNMLOKRHLGFEH56DA 大園區科七街68號二樓
        self.check(11500000, 1150000, 155.26, 34.13, 85445, 28.25)
        # RPRNMLRJRHLGFAH98DA 桃園區日光路33號九樓（2 個車位）
        self.check(24090000, 4300000, 200.99, 73.92, 155741, 51.48)
        # RPPNMLLLRHLGFFH88DA 八德區永豐路506巷27號十五樓
        self.check(12360000, 1940000, 119.54, 28.11, 113967, 37.68)

    def test_no_parking(self):
        # RPPQMLQKRHLGFAH09DA 南平路108巷16號四樓，無車位：總價 ÷ 面積
        self.assertAlmostEqual(clean.unit_price_net(7500000, 0, 86.33, 0), 86876 / 3025, delta=0.01)

    def test_invalid(self):
        self.assertIsNone(clean.unit_price_net(1000000, 0, 0, 0))
        self.assertIsNone(clean.unit_price_net(1000000, 0, 20, 30))


class TestAreas(unittest.TestCase):
    """公設比＝（權狀不含車位 − 主建物 − 附屬 − 陽台）÷ 權狀不含車位；陽台不含在附屬建物"""

    def test_real_samples(self):
        # RPSOMLLKRHLGFAH68DA 南華街：權狀 159.47、車位 46.3、主建物 68.54、陽台 7.41
        a = clean.area_breakdown(159.47, 46.3, 68.54, 0, 7.41)
        self.assertEqual((a["ping"], a["indoor"], a["public_ratio"]), (34.23, 20.73, 0.329))
        # RPRNMLOKRHLGFEH56DA 科七街
        self.assertEqual(clean.area_breakdown(155.26, 34.13, 73.2, 0, 7.32)["public_ratio"], 0.335)
        # RPRNMLRJRHLGFAH98DA 日光路
        self.assertEqual(clean.area_breakdown(200.99, 73.92, 74.19, 0, 7.98)["public_ratio"], 0.353)
        # RPSNMLKKRHLGFEH88DA 南順六街（有附屬建物 2.68）
        self.assertEqual(clean.area_breakdown(140.69, 0, 73.56, 2.68, 10.49)["public_ratio"], 0.384)

    def test_no_public_area(self):
        # RPPQMLQKRHLGFAH09DA 南平路公寓：總面積剛好等於主建物＋陽台 → 公設比 0
        self.assertEqual(clean.area_breakdown(86.33, 0, 70.2, 0, 16.13)["public_ratio"], 0.0)

    def test_presale_without_main_area(self):
        a = clean.area_breakdown(134.23, 25.76, None, None, None)  # 預售表沒有主建物欄位
        self.assertEqual(a["ping"], 32.81)
        self.assertIsNone(a["public_ratio"])
        self.assertIsNone(a["indoor"])


class TestCounts(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(clean.parse_counts("土地2建物1車位1"), (2, 1, 1))
        self.assertEqual(clean.parse_counts("土地1建物1車位3"), (1, 1, 3))
        self.assertEqual(clean.parse_counts("土地2建物0車位0"), (2, 0, 0))
        self.assertEqual(clean.parse_counts(""), (0, 0, 0))


class TestSpecialFlags(unittest.TestCase):
    """備註原文取自實際資料"""

    @classmethod
    def setUpClass(cls):
        cls.rules = rules.Flags().rules

    def flags(self, note):
        return clean.match_flags(note, self.rules)

    def test_excluded_by_default(self):
        self.assertEqual(self.flags("親友、員工、共有人或其他特殊關係間之交易；"), ["親友關係"])
        self.assertEqual(self.flags("二親等間買賣"), ["親友關係"])
        self.assertEqual(self.flags("瑕疵物件；"), ["瑕疵凶宅"])
        self.assertEqual(self.flags("急買急賣；"), ["急買急賣"])
        self.assertEqual(self.flags("受債權債務關係影響或債務抵償"), ["債權債務"])
        self.assertEqual(self.flags("內含1間標配衛浴毛胚屋；"), ["毛胚"])
        self.assertEqual(self.flags("地清或未辦繼承標售"), ["繼承標售"])

    def test_not_false_positive(self):
        # 免責條款裡的「凶宅」不算
        self.assertEqual(self.flags("買方同意，除海砂、輻射、凶宅外，賣方不負其餘物的瑕疵擔保責任"), [])
        # 車位持分不算持分交易
        self.assertEqual(self.flags("本社區地下室車位共70個，以單獨之建號登記為共有部分，由社區總戶數177戶均分持有，"
                                    "本戶持分之車位價格為50萬。"), [])
        self.assertEqual(self.flags("預售屋、或土地及建物分件登記案件；"), [])

    def test_flag_only(self):
        self.assertEqual(self.flags("陽台外推；其他增建；"), ["增建", "陽台外推"])
        self.assertEqual(self.flags("頂樓加蓋；其他增建；"), ["增建", "頂樓加蓋"])
        self.assertEqual(self.flags("交易總價含下列非屬預售屋價格之費用:傢俱設備費；"), ["含傢俱裝潢"])

    def test_default_exclude(self):
        f = rules.Flags()
        ex = f.default_exclude_mask()
        self.assertTrue(ex & f.bit["親友關係"])
        self.assertFalse(ex & f.bit["增建"])
        self.assertTrue(ex & f.bit["預售交屋"])
        self.assertEqual(f.names(f.mask(["增建", "解約"])), ["增建", "解約"])

    def test_presale_handover_and_cancel(self):
        self.assertTrue(clean.is_presale_handover("115/7/16，父子原價轉讓預售屋、或土地及建物分件登記案件；"))
        self.assertFalse(clean.is_presale_handover("其他增建；"))
        # RPXNMLRKNHIGFCH66DB 三鶯雲深白
        self.assertEqual(clean.cancel_info("1120715全部解約"), (True, dt.date(2023, 7, 15)))
        self.assertEqual(clean.cancel_info(""), (False, None))


class TestClassify(unittest.TestCase):
    def test_btype(self):
        self.assertEqual(clean.btype_short("住宅大樓(11層含以上有電梯)"), "住宅大樓")
        self.assertEqual(clean.btype_short("華廈(10層含以下有電梯)"), "華廈")
        self.assertEqual(clean.btype_short("公寓(5樓含以下無電梯)"), "公寓")
        self.assertEqual(clean.btype_short("透天厝"), "透天")
        self.assertEqual(clean.btype_short("套房(1房1廳1衛)"), "套房")
        self.assertEqual(clean.btype_short("其他"), "其他")

    def test_elevator(self):
        self.assertTrue(clean.has_elevator("有", "公寓"))
        self.assertTrue(clean.has_elevator("", "住宅大樓"))   # 預售表無電梯欄位
        self.assertFalse(clean.has_elevator("", "透天"))
        self.assertIsNone(clean.has_elevator("", "店面"))

    def test_park_group(self):
        self.assertEqual(clean.park_group("坡道平面"), "平面")
        self.assertEqual(clean.park_group("坡道機械"), "機械")
        self.assertEqual(clean.park_group("塔式車位"), "機械")
        self.assertIsNone(clean.park_group(""))


class TestAddress(unittest.TestCase):
    def test_real_samples(self):
        p = clean.parse_address("桃園市中壢區中央西路二段２５０號十二樓之３", "中壢區")
        self.assertEqual((p["road"], p["lane"], p["no"]), ("中央西路二段", "", "250"))
        p = clean.parse_address("桃園市桃園區南平路１０８巷１６號四樓", "桃園區")
        self.assertEqual((p["road"], p["lane"], p["no"]), ("南平路", "108巷", "16"))
        p = clean.parse_address("桃園市平鎮區延平路一段１５０巷２６弄１０號", "平鎮區")
        self.assertEqual((p["lane"], p["alley"], p["no"]), ("150巷", "26弄", "10"))
        self.assertEqual(clean.building_key(p), "平鎮區|延平路一段|150巷|26弄|10")

    def test_sub_number(self):
        # 「之N號」與「號之N」（樓層前）是門牌；「樓之N」是戶號
        self.assertEqual(clean.parse_address("桃園市桃園區三元街１７５之２號", "桃園區")["no"], "175之2")
        self.assertEqual(clean.parse_address("桃園市桃園區三元街１２號之１三樓", "桃園區")["no"], "12之1")
        self.assertEqual(clean.parse_address("桃園市桃園區南華街１２８號十一樓之２", "桃園區")["no"], "128")

    def test_village_prefix_and_multi(self):
        p = clean.parse_address("桃園市新屋區後湖里3鄰中山路１０號", "新屋區")
        self.assertEqual(p["road_no_village"], "中山路")
        self.assertEqual(clean.parse_address("桃園市中壢區大圳路一段1170、1168號", "中壢區")["no"], "1170")

    def test_no_doorplate(self):
        self.assertIsNone(clean.parse_address("埔子段北門埔子小段90-1地號", "桃園區"))
        self.assertIsNone(clean.parse_address("桃園市大園區幸福南路與計畫道路交叉口", "大園區"))

    def test_norm(self):
        self.assertEqual(clean.norm_text("臺北 １２３"), "台北123")
        self.assertTrue(clean.has_pua("光路"))


if __name__ == "__main__":
    unittest.main()
