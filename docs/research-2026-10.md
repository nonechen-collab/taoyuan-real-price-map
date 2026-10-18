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
