# 桃園市實價登錄地圖系統｜Claude Code 交接檔

需求、決策與進度都以 SPEC.md 為準（下一行會自動載入）：

@SPEC.md

研究摘要（被擋原因、下載網址、資料陷阱、定位、參考專案）：

@docs/research-2026-10.md

個人資訊放在不上傳的 CLAUDE.local.md（只存在使用者電腦上；雲端或 GitHub 上沒有這個檔是正常的）：

@CLAUDE.local.md

## 工作守則
- 使用者沒有程式背景；一律用繁體中文，結論先講、手機好讀、比較用表格
- 使用者的電腦：Windows；手機：只做 Android Chrome，不做 iOS
- 這是公開 repo：姓名、裝置型號、Email 等個人資訊只寫進 CLAUDE.local.md，不要寫進會上傳的檔案
- 需要使用者動手的步驟（安裝軟體、申請金鑰、GitHub 設定），給逐步點擊說明
- SPEC 沒寫到的重大決定先問；每完成一個階段，更新 SPEC 文末的「決策紀錄」「進度紀錄」

## 環境注意
- 這台電腦走台灣家用網路，可以直接連內政部網站（plvr.land.moi.gov.tw）
- 開工前先檢查 `python --version`（或 `py --version`，需 3.10 以上）與 `git --version`；沒裝就引導使用者從 python.org、git-scm.com 安裝（Python 安裝時勾選 Add python.exe to PATH）
- Windows 終端機輸出預設不是 UTF-8：Python 腳本開頭要把 stdout 改成 UTF-8（step1_probe.py 已處理）
- 內政部憑證鏈過不了 Python 3.13 起的嚴格檢查：只關掉 VERIFY_X509_STRICT，不可關閉憑證驗證（step1_probe.py 已處理）

## 目前進度（2026-10-19）
- 本機工具：Python 3.13.15（`%LOCALAPPDATA%\Programs\Python\Python313`）、Node.js 24.22.0（`%LOCALAPPDATA%\Programs\nodejs`），都在使用者 PATH；沒有 gh CLI
- Windows「智慧型應用程式控制」會擋 rolldown 原生 .node：本機要 `npm install --no-save --force @rolldown/binding-wasm32-wasi@<rolldown版本>`（npm 安裝或移除套件後會被清掉，要再裝一次）；不可要求使用者關閉安全設定
- 預覽：`.claude/launch.json` 的 web 設定；內建瀏覽器面板隱藏時 requestAnimationFrame 不會執行，網址加 `?raf`（只在開發模式有效）可強制繪製地圖
- Phase 1 程式完成：`pipeline/`（下載、清理、定位、社區、輸出）、`web/`（React＋MapLibre PWA）、`.github/workflows/update-data.yml`（排程＋Pages 部署）
- 地理編碼：桃園市門牌坐標開放資料（買賣 99.5% 棟級命中）；OSM Overpass 最近常逾時，預售約 11% 建案尚未定位，排程會逐次補
- GitHub Pages 已開啟（2026-10-19），第一次部署成功：https://nonechen-collab.github.io/taoyuan-real-price-map/
- 已知效能問題：首屏要等社區清單（439 KB）與第一區成交（925 KB），本機實測 12 秒才出資料；改善方向：成交拆成近 12 月／更早兩檔、社區併入各區檔、檔名加內容雜湊讓手機快取

## 下一步（照順序）
1. 首屏載入加速（見上方已知效能問題），達成 SPEC「4G 首屏 < 3 秒」
2. 使用者用手機驗收 Phase 1（驗收清單在最後一次回報），收集問題修正
3. 使用者確認後才進 Phase 2；Phase 2 驗收樣本「璞園安彊」「君邑中運路案」在近 3 年資料中查無，需回補 2012 年起歷史資料（Phase 2 項目）
