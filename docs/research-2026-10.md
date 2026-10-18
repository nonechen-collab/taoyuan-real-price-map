# 研究摘要（2026-10-18）

以下為研究報告的重點摘錄，事實附來源；實作前仍以實測為準。

## 1. 為何被擋
- 被擋的是 Claude 雲端開發環境：所有對外連線經過代理，只放行允許清單（套件庫、GitHub 等），其他網域 CONNECT 回 403。來源：https://code.claude.com/docs/en/cloud-environments
- 沒有找到內政部擋 GitHub Actions 的證據；反而有專案在 2026-09 於 Actions 上實測下載成功（本期全國 zip 200、約 1.9 MB）。來源：https://github.com/BarryHuang/BarryNotification/pull/12
- 台灣政府網站封鎖海外 IP 多半發生在 DDoS 事件期間，屬暫時性；管線要設計成「失敗就重試，連續失敗保留上一版資料」

## 2. 下載網址（他人專案實測）
| 用途 | 網址 |
|---|---|
| 本期・全國 zip | `https://plvr.land.moi.gov.tw/Download?type=zip&fileName=lvr_landcsv.zip` |
| 本期・桃園單檔 | `https://plvr.land.moi.gov.tw/Download?fileName=H_lvr_land_A.csv`（A 買賣、B 預售、C 租賃） |
| 前期・全國 zip（2026-10-18 本機實測） | `https://plvr.land.moi.gov.tw/DownloadHistory?type=history&fileName=20261001`（檔名＝前期發布日，下載頁「前期下載」區塊；只提供前一期） |
| 某季・全國 zip | `https://plvr.land.moi.gov.tw/DownloadSeason?season=115S2&type=zip&fileName=lvr_landcsv.zip` |
| 某季・桃園單檔 | `https://plvr.land.moi.gov.tw/DownloadSeason?season=115S2&fileName=H_lvr_land_A.csv` |

## 3. 資料陷阱（實作必須處理）
1. **TLS**：Python 3.13 以上會因 VERIFY_X509_STRICT 驗證失敗；系統 curl 正常。來源：https://github.com/tonycheng-0118/TW_RealEstate_ETL/issues/4
2. **查無檔案也回 200**：回的是 HTML 錯誤頁，要檢查檔頭（zip 為 PK）、content-type、檔案大小
3. **zip 內檔名是小寫**：`h_lvr_land_a.csv`
4. **季檔與本期檔有缺口**：季檔要等季結束才生成，本期檔只含最近一期；每次執行都要把本期資料累積進自己的資料（以「編號」去重），不可每次重建
5. **編碼**：舊檔多為 Big5（cp950），新檔為 UTF-8-sig；第 1 列中文欄名、第 2 列英文欄名
6. **禮貌下載**：每次請求間隔 10 秒（開源專案慣例）；排程訂在每月 2、12、22 日

## 4. 地理編碼
- 以「棟」去重後再定位；結果存成快取檔進 repo，只對新地址定位
- **TGOS**：比對成功率約 9 成、每日 1 萬筆；但 2025-04-07 起舊批次金鑰停用，新申請限政府機關、法人、學術單位、業界，**個人可能申請不到**（待使用者決定替代方案）
- 參考做法：lvr-price 以「路段＋巷」分組，在瀏覽器端用 Esri 定位（OSM 備援），約 97% 定得到；Esri 儲存定位結果的授權條款尚未查證
- 定位失敗：門牌區間取中間號或退回路段中心，標低信心；可提供手動點選補正

### 4.1 2026-10-19 補充研究與實測
| 來源 | 費用／條件 | 結果能否永久存 | 實測 |
|---|---|---|---|
| **桃園市門牌位置坐標**（民政局開放資料，[data.gov.tw/dataset/157689](https://data.gov.tw/dataset/157689)） | 免費、免申請；每月更新；CSV 約 95 MB、110 萬筆（含樓層），TWD97 二度分帶坐標要換算 WGS84 | 可以（政府資料開放授權第 1 版） | 3 期買賣地址 5,528 棟：**98.8% 直接對到門牌**（交易筆數 99.4%）；失敗多為缺字（私用區字元）、「衖」、多門牌並列，可再修 |
| TGOS | 個人只能用網頁批次比對（每日 1 萬筆）；程式 API 限政府、法人、學術、業界 | — | 未測（個人不能自動化） |
| Google Geocoding | 每月 1 萬次免費，要綁信用卡 | **不行**：服務條款規定坐標最多暫存 30 天 | 未測 |
| Esri ArcGIS | 要存結果需「stored」計價，每千筆 US$4，無免費額度（不存的才有每月 2 萬次免費） | 付費才可以 | 未測 |
| OSM Nominatim | 免費、限每秒 1 次 | 可以（ODbL，需標示） | 一般門牌 **0／10**（台灣門牌幾乎沒收錄） |
| OSM Overpass（找兩路交叉點） | 免費 | 可以（ODbL，需標示） | 門牌資料沒有的新路交叉口 2／2 找到（大園航空城） |

- 門牌資料注意事項：由戶政事務所人工套圖標點，偶有誤差，官方註明「僅供參考」；只有現行門牌，門牌整編前的舊地址可用較舊月份檔（最早 111 年 1 月）補
- 每月最新檔的下載網址：`https://data.gov.tw/api/v2/rest/dataset/157689` 的 `distribution` 清單（最後一筆即最新月份）
- 預售建案 288 個（3 期）：門牌號或「XX號旁」31%、附近門牌（±20 號）9%、「A路與B路交叉口」用門牌資料推算兩路最近點 20%、只有路名（路段中心，概略）25%、新路交叉口／只有地號／其他 15%
- 實價登錄地址的里鄰、全形數字、「號之N」都要正規化；預售地址常見寫法：「XX號旁／對面／附近」「A路與B路交叉口（附近）」「XX段YY地號」

## 5. 可參考的開源專案
| 專案 | 可借用 |
|---|---|
| https://github.com/angel98625/lvr-price | Actions 排程、每縣市一個 gzip JSON、旗標位元排除地下層／社宅、路段＋巷分組定位、taiwan-atlas 行政區界 |
| https://github.com/tonycheng-0118/TW_RealEstate_ETL | curl 下載、編號 upsert、編碼偵測順序 |
| https://github.com/monkey1wizard/taiwan-lvr-geodata | 缺字補正、building_key 門牌正規化 |
| https://github.com/BarryHuang/BarryNotification | Actions 端點探測、房價通知 |

## 6. 候選功能（SPEC 尚未列入，待使用者決定）
- 一樓／樓上層分開計算行情（樂居、lvr-price 做法）
- 新成交推播：收藏社區有新成交時由 Actions 發 LINE 或 Email（信義訂閱、BarryNotification）
- 「降價」標記：最新單價低於該社區一年均價（5168「鄰居真降價」）
- 每筆顯示歷史交易次數（樂屋網）
