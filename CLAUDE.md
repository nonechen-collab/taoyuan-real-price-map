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

## 目前進度（2026-10-20）
- 本機工具：Python 3.13.15（`%LOCALAPPDATA%\Programs\Python\Python313`）、Node.js 24.22.0（`%LOCALAPPDATA%\Programs\nodejs`），都在使用者 PATH；沒有 gh CLI
- Windows「智慧型應用程式控制」會擋 rolldown 原生 .node：本機要 `npm install --no-save --force @rolldown/binding-wasm32-wasi@<rolldown版本>`（npm 安裝或移除套件後會被清掉，要再裝一次）；不可要求使用者關閉安全設定
- 預覽：`.claude/launch.json` 的 web 設定；內建瀏覽器面板隱藏時 requestAnimationFrame 不會執行，網址加 `?raf`（只在開發模式有效）可強制繪製地圖
- Phase 1 程式完成：`pipeline/`（下載、清理、定位、社區、輸出）、`web/`（React＋MapLibre PWA）、`.github/workflows/update-data.yml`（排程＋Pages 部署）
- 地理編碼：桃園市門牌坐標開放資料（買賣 98% 棟級命中）；預售建案另用土地地號連結交屋社區、同地段推估補位置；OSM Overpass 幾乎都逾時（2026-10-20 查 32 次成功 4 次），只當最後手段
- GitHub Pages 已開啟（2026-10-19），第一次部署成功：https://nonechen-collab.github.io/taoyuan-real-price-map/
- 首屏載入加速已做（2026-10-19）：各區拆近 12 月／更早兩檔、社區併入各區檔、檔名含內容雜湊；前端先載近 12 月，選近 3 年才載更早
- Phase 2 程式完成（2026-10-20）：資料回補到 2012（季檔 101S3 起）、社區／建案歷史檔（64 份）、搜尋、社區頁／建案頁（散布圖、銷控表、樓層價差、去化）、走勢、比較表、收藏與看屋筆記、CSV 匯出、合宜住宅旗標
- Phase 3 程式完成（2026-10-21）：租賃（pipeline/rent.py，近 3 年）、毛租金報酬率、估價助手、新成交提醒與範圍收藏、預售→轉手追蹤、圖層（pipeline/layers.py：淹水潛勢 shapefile 轉矩形、OSM 車站學校公園，結果存 data/layers/；土壤液化用國土測繪中心 WMTS）
- OpenStreetMap Overpass 常 502/504：layers.py 會把成功的查詢存在 data/raw/osm/，重跑只補失敗的
- 本機記憶體只有 8 GB：完整建置要約 2 GB，記憶體吃緊時會用硬碟交換、變很慢（30 分鐘以上）；GitHub Actions 約 10 分鐘

## 下一步（照順序）
1. Phase 2 已由使用者手機驗收通過（2026-10-20）
2. 等使用者手機驗收 Phase 3（驗收清單與已知問題見最後一次回報）；通過後更新 SPEC 進度紀錄
