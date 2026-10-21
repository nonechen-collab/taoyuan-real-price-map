"""租賃清理單元測試。樣本取自內政部桃園實價登錄租賃開放資料 115S3（註明編號，可回查）。

執行：python -m unittest discover -s tests -t .
"""

import datetime as dt
import unittest

from pipeline import rent

SINCE, TODAY = dt.date(2023, 9, 1), dt.date(2026, 10, 21)


def _row(**kw):
    base = {"交易標的": "租賃房屋", "租賃年月日": "1150511", "建物型態": "住宅大樓(11層含以上有電梯)", "出租型態": "整棟(戶)出租",
            "租賃住宅服務": "", "總額元": "20000", "建物總面積平方公尺": "100", "車位面積平方公尺": "0", "車位總額元": "0",
            "租賃層次": "五層", "總樓層數": "11", "備註": "", "鄉鎮市區": "桃園區", "土地位置建物門牌": "桃園市桃園區中正路1號五樓"}
    base.update(kw)
    return base


def _has(r, name):
    i = next(i for i, (n, _, _) in enumerate(rent.FLAGS) if n == name)
    return bool(r["mask"] >> i & 1)


class TestRent(unittest.TestCase):
    def test_social_housing_with_parking(self):
        # RPOPMLLKNHLGFAH08CC 桃園區文中一路 社會住宅包租轉租，總額 27,500 含車位 3,000、車位 23.03 m²
        r, _ = rent.clean_rent(_row(編號="RPOPMLLKNHLGFAH08CC", 交易標的="租賃房屋+車位", 租賃住宅服務="社會住宅包租轉租",
                                    總額元="27500", 建物總面積平方公尺="128.65", 車位面積平方公尺="23.03", 車位總額元="3000"),
                               SINCE, TODAY)
        self.assertEqual(r["rent"], 24500)  # 扣掉車位租金
        self.assertAlmostEqual(r["ping"], (128.65 - 23.03) * 0.3025, places=3)
        self.assertAlmostEqual(r["ru"], 24500 / ((128.65 - 23.03) * 0.3025), places=3)
        self.assertTrue(_has(r, "社宅包租代管"))
        self.assertTrue(_has(r, "含車位"))
        self.assertFalse(_has(r, "非整層"))

    def test_social_management(self):
        # RPXNMLLKNHLGFFH66CC 八德區仁和街 社會住宅代管 公寓 12,000 元、93.95 m²
        r, _ = rent.clean_rent(_row(編號="RPXNMLLKNHLGFFH66CC", 租賃住宅服務="社會住宅代管", 建物型態="公寓(5樓含以下無電梯)",
                                    總額元="12000", 建物總面積平方公尺="93.95", 租賃層次="四層", 總樓層數="5"), SINCE, TODAY)
        self.assertTrue(_has(r, "社宅包租代管"))
        self.assertEqual(r["floor"], 4)
        self.assertAlmostEqual(r["ru"], 12000 / (93.95 * 0.3025), places=3)

    def test_parking_not_priced(self):
        # RPOPMLMKNHLGFAH18CC 桃園區樹仁一街 一般租約，含車位但車位沒有拆價 → 照總額算
        r, _ = rent.clean_rent(_row(編號="RPOPMLMKNHLGFAH18CC", 交易標的="租賃房屋+車位", 建物型態="華廈(10層含以下有電梯)",
                                    總額元="23000", 建物總面積平方公尺="148.42"), SINCE, TODAY)
        self.assertEqual(r["rent"], 23000)
        self.assertFalse(_has(r, "社宅包租代管"))
        self.assertTrue(_has(r, "含車位"))
        self.assertEqual(r["mask"] & rent.default_exclude_mask(), 0)  # 進統計

    def test_exclusions(self):
        self.assertEqual(rent.clean_rent(_row(編號="X1", 交易標的="車位"), SINCE, TODAY)[1], "沒有建物（只租土地或車位）")
        self.assertEqual(rent.clean_rent(_row(編號="X2", 租賃年月日="1100101"), SINCE, TODAY)[1], "不在近 3 年")
        r, _ = rent.clean_rent(_row(編號="X3", 出租型態="獨立套房"), SINCE, TODAY)
        self.assertTrue(_has(r, "非整層"))
        r, _ = rent.clean_rent(_row(編號="X4", 總額元="200"), SINCE, TODAY)  # 每坪 6.6 元：打錯
        self.assertTrue(_has(r, "租金異常"))
        r, _ = rent.clean_rent(_row(編號="X5", 備註="親友間租賃"), SINCE, TODAY)
        self.assertTrue(_has(r, "親友關係"))


if __name__ == "__main__":
    unittest.main()
