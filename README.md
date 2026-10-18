# 桃園市實價登錄地圖系統

個人自用、手機優先的桃園實價登錄地圖。需求、決策與進度都記在 [SPEC.md](SPEC.md)。

## 用 Claude Code 繼續開發（建議）

1. 打開 Claude 桌面 App，點上方的 **Code**
2. 選 **Local**，按 **Select folder**，選這個資料夾（`taoyuan-real-price-map`）
3. 輸入：「讀 CLAUDE.md，從下一步開始做」

Claude Code 每次開啟都會自動讀 `CLAUDE.md`，裡面有目前進度、下一步和資料陷阱。

## 目前進度：第一步（連線測試＋資料檢查）

`scripts/step1_probe.py` 會做三件事：

1. 測試這台機器連不連得到內政部實價登錄網站
2. 下載最新一期與上一季的全國 CSV，只留下桃園（檔名 h 開頭）的檔案
3. 產生報告：欄位清單、各檔筆數與樣本、陽台是否含在附屬建物、車位未拆價比例、備註最常見的 20 種寫法

在 GitHub 上由 `.github/workflows/step1-probe.yml` 執行：推送這兩個檔案時會自動跑，也可以手動按。

### 看結果（手機也可以）

1. 打開 repo 頁面，點上方的 **Actions**
2. 點最新一筆「第一步：連線測試與資料檢查」
3. 往下捲到 **Summary**，報告就在那裡
4. 報告也會自動存成 `reports/step1_report.md`

綠色勾勾＝程式正常跑完；報告第一張表會寫「連得到」或「被擋」。

### 手動再跑一次

Actions → 左側點「第一步：連線測試與資料檢查」→ 右側 **Run workflow** → 再按一次綠色 **Run workflow**。

## 第一次建立 repo（自己上傳的步驟）

用電腦瀏覽器操作比較順手：

1. 登入 github.com，點右上角 **＋** → **New repository**
2. Repository name 填 `taoyuan-real-price-map`，選 **Public**，其他不用勾，按 **Create repository**
3. 在新 repo 頁面點 **uploading an existing file**
4. 把解壓後資料夾裡的所有東西（含 `.github` 資料夾）一起拖進網頁
5. 按 **Commit changes**，約 3–5 分鐘後到 Actions 看結果

> 為什麼要 Public：GitHub 免費方案只有公開 repo 能用 GitHub Pages 架網站。資料本來就是政府公開資料，金鑰之後會放在 Secrets，不會外流。

## 在自己電腦上跑（GitHub 被內政部擋下時的備案）

1. 到 python.org 下載安裝 Python 3.10 以上；Windows 安裝時勾選「Add python.exe to PATH」
2. 在專案資料夾空白處按右鍵 →「在終端機中開啟」
3. 輸入 `python scripts/step1_probe.py` 按 Enter
4. 結果在 `reports/step1_report.md`

已經手動下載好 zip 的話，可以改用 `python scripts/step1_probe.py --local 檔案.zip`，不必連網。

## 專案結構

```
SPEC.md                              需求規格、決策紀錄、進度紀錄
scripts/step1_probe.py               第一步：連線測試＋資料檢查（只用 Python 標準函式庫）
.github/workflows/step1-probe.yml    在 GitHub Actions 執行第一步
reports/                             產出的報告（自動存回 repo）
data/raw/                            下載的原始檔（不進 repo）
```

## 資料來源與授權

內政部不動產成交案件實際資訊資料供應系統（https://plvr.land.moi.gov.tw/DownloadOpenData），依「政府資料開放授權條款－第1版」使用。
