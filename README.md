# 桃園市實價登錄地圖

個人自用、手機優先的桃園實價登錄地圖：看屋現場查附近成交、比較預售建案、看區域行情、議價找比較案例。

- 網站：https://nonechen-collab.github.io/taoyuan-real-price-map/
- 需求、決策與進度：[SPEC.md](SPEC.md)
- 欄位、單位、公式：[docs/data-dictionary.md](docs/data-dictionary.md)

## 怎麼用（Android Chrome）

| 想做的事 | 操作 |
|---|---|
| 看附近成交 | 按右下 📍（看屋模式）→ 允許定位 → 面板列出 300／500 m／1 km 內成交，依距離排序 |
| 查某個地點 | 長按地圖任一點設為圓心 |
| 自訂範圍 | 按 ✏️ → 在地圖上點出多邊形頂點 → 完成 |
| 看社區 | 放大到中間層級，點泡泡（件數＋中位單價）；或點成交卡片下方「社區：…」 |
| 社區頁／建案頁 | 選了社區後按面板上的「社區頁 ›／建案頁 ›」：2012 年起全部成交、單價散布圖（點色＝樓層）、車位價、公設比；預售建案另有虛擬銷控表、樓層價差、每月去化、解約 |
| 搜尋建案或社區 | 右上 ☰ →「搜尋建案／社區」，打部分名稱或門牌即可（例：「畾畾青」） |
| 行情走勢 | ☰ →「行情走勢」：最多 4 個行政區／社區／建案疊在一起看季中位數與成交量；社區、建案在各自的頁面按「📈 加入走勢」 |
| 比較表 | ☰ →「比較表」：目前範圍的預售／新成屋／中古屋價差；建案頁按「⚖️ 加入比較」可並排最多 6 個建案 |
| 收藏與看屋筆記 | 社區頁、建案頁按「☆ 收藏」，或成交卡片右下 ☆；筆記（結構、防水、隔音、格局、售後服務、價格）只存在這支手機，☰ →「收藏與看屋筆記」可匯出／匯入備份 |
| 匯出 CSV | 列表上方「⬇ CSV」或 ☰ →「匯出目前列表」，Excel 可直接開 |
| 租金與報酬率 | 上方切到「租賃」：地圖改畫每坪月租，統計卡多一項毛租金報酬率（整層住家租金 × 12 ÷ 同範圍買賣單價）；可再選「整層住家／套房雅房」 |
| 估價助手 | ☰ →「估價助手」：輸入型態、坪數、屋齡、樓層、車位，自動找近 24 個月附近的比較案例，給合理區間；可逐筆剔除、分享比價頁網址 |
| 新成交提醒 | 收藏的社區、建案，或畫好圈／多邊形後按「☆ 收藏範圍」；之後有新成交，右上 ☰ 會出現紅點 |
| 預售 → 轉手 | 建案頁、社區頁的「預售 → 交屋後轉手」：當初預售價與交屋後轉手價對照，同一戶列出漲跌 |
| 液化、淹水、車站學校公園 | 右下 🗺️ 圖層：土壤液化潛勢、淹水潛勢（兩種降雨情境）、車站、學校、公園 |
| 篩選 | 左上「篩選」：類別、期間、行政區、型態、屋齡、房數、總價、單價、坪數、樓層、電梯、車位 |
| 分享目前畫面 | 直接分享網址（篩選、範圍、選中的成交、開著的社區頁都寫在網址裡）；手機返回鍵會先關閉分頁回到地圖 |
| 加到主畫面 | Chrome 選單 →「加到主畫面」，之後可離線看上次載入的資料 |

地圖三層級：縮小看六角格（中位單價色塊）→ 中間看社區泡泡 → 放大看每一筆的扣車位單價。色階預設依畫面內的分位數切 5 級（藍＝較便宜、灰＝居中、紅＝較貴），點圖例可切換固定級距。成交卡片標「比社區中位 +N%」表示偏離同社區中位數 20% 以上。

## 資料怎麼更新

GitHub Actions 每月 2、12、22 日台灣時間 10:00 自動執行 `.github/workflows/update-data.yml`：

1. 下載內政部實價登錄「本期＋前期」（還有剛結束的季檔），只留桃園檔，存成 `data/periods/<期別>.zip`（只新增、不改寫；2012 年第 4 季起的歷史季檔已一次下載保存）
2. 新期別筆數是 0 或暴增 → 保留舊資料、開 GitHub Issue 通知（Issue 會寄信給你）
3. 清理、用桃園市門牌坐標定位、推定社區、估算未拆價車位
4. 產生網站資料、部署到 GitHub Pages；每次的資料報告在 [reports/pipeline_report.md](reports/pipeline_report.md)

**不需要任何金鑰**：實價登錄、門牌坐標都是免申請的政府開放資料；預售建案補位置用 OpenStreetMap。

## 需要你手動做的事

### 第一次：開啟 GitHub Pages（只做一次，約 1 分鐘）

1. 電腦瀏覽器打開 https://github.com/nonechen-collab/taoyuan-real-price-map
2. 點上方 **Settings**（齒輪）
3. 左側點 **Pages**
4. **Build and deployment → Source** 下拉選 **GitHub Actions**（不用按儲存，選了就生效）
5. 點上方 **Actions** → 左側「更新資料並部署網站」→ 右側 **Run workflow** → 綠色 **Run workflow**
6. 約 5 分鐘後，手機打開 https://nonechen-collab.github.io/taoyuan-real-price-map/

### 收到「資料更新異常」Issue 時

- 多半是內政部網站暫時連不上，下一次排程會自動重試，網站照常顯示舊資料
- 連續好幾次都失敗，再請 Claude Code 處理（可改在自己電腦下載後推送）

### 手動合併或拆分社區

推定社區偶爾會把兩個社區合在一起或拆開。在 `data/manual/communities.csv` 加一行「門牌鍵,社區代號,社區名稱」（門牌鍵在成交卡片展開後的「原始欄位」），推送後下次建置生效。

### 調整特殊交易關鍵字

改 `pipeline/special_keywords.csv`（旗標、關鍵字用 `|` 分隔、預設排除 是／否），推送後自動重建。

## 在自己電腦上執行（開發用）

需要 Python 3.10 以上、Node.js 20 以上。

```bash
python -m pipeline.periods update
```

```bash
python -m pipeline.build
```

```bash
python -m unittest discover -s tests -t .
```

```bash
cd web && npm install && npm run dev
```

開發網址：http://localhost:5173/taoyuan-real-price-map/

> Windows 11 若開啟「智慧型應用程式控制」，會擋下建置工具 rolldown 的原生元件，改裝 WebAssembly 版即可（不必改安全設定）：在 `web` 資料夾執行 `npm install --no-save --force @rolldown/binding-wasm32-wasi@<rolldown 版本>`。

## 專案結構

```
SPEC.md                       需求規格、決策紀錄、進度紀錄
CLAUDE.md                     給 Claude Code 的交接檔
pipeline/                     資料管線（只用 Python 標準函式庫）
  periods.py                    下載內政部資料、存期別 zip
  update.py                     排程入口：下載＋筆數異常檢查
  clean.py                      清理（民國日期、國字樓層、面積、單價、公設比、地址）
  rules.py, special_keywords.csv 特殊交易旗標
  doorplate.py                  桃園市門牌坐標：下載、索引、TWD97→WGS84
  geocode.py                    定位（門牌、交叉口推算、OSM）與快取
  community.py                  推定社區
  rent.py                       租賃（近 3 年）清理
  layers.py                     圖層資料一次產生：淹水潛勢（shapefile 轉矩形）、車站學校公園（OpenStreetMap）
  build.py                      主流程：輸出前端資料與報告
  checksize.py, verify.py       檔案大小檢查、驗收抽樣
tests/test_clean.py           清理模組單元測試（真實樣本）
data/periods/                 每期桃園原始檔（只新增）
data/geocode_cache.csv        定位快取（只新增）
data/layers/                  圖層資料（淹水潛勢、車站學校公園），來源更新時重跑 python -m pipeline.layers
data/manual/                  手動修正（社區合併／拆分）
web/                          前端（React + Vite + TypeScript + MapLibre GL JS，PWA）
  src/pages/                    社區頁／建案頁、走勢、比較表、收藏、搜尋
  src/charts/                   SVG 圖表（散布圖、帶狀走勢、柱狀圖，每張可切換表格）
reports/                      第一步報告、每次資料報告、驗收抽樣
docs/                         研究摘要、資料字典
.github/workflows/            update-data.yml（排程＋部署）、step1-probe.yml（連線測試）
```

## 資料來源與授權

- 內政部不動產成交案件實際資訊資料供應系統（https://plvr.land.moi.gov.tw/DownloadOpenData），政府資料開放授權條款－第1版
- 桃園市政府民政局「桃園市門牌位置坐標資料」（https://data.gov.tw/dataset/157689），政府資料開放授權條款－第1版
- 預售建案部分位置、車站學校公園：© OpenStreetMap 貢獻者（ODbL）
- 淹水潛勢：桃園市政府水務局 第三代桃園市淹水潛勢圖，政府資料開放授權條款－第1版
- 土壤液化潛勢：國土測繪中心 WMTS（經濟部地質調查及礦業管理中心）
- 底圖：內政部國土測繪中心 通用版電子地圖

本網站為個人整理，數字以內政部實價登錄網站為準。
