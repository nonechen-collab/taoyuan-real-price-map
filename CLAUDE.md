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

## 目前進度（2026-10-18 本機 Claude Code）
- Python 3.13.15 已用 winget 裝在使用者帳號下（`%LOCALAPPDATA%\Programs\Python\Python313`，已加進 PATH）；Git 2.54；沒有 gh CLI（查 GitHub 狀態用公開 API，未登入每小時 60 次）
- GitHub 公開 repo 已建立並推送：https://github.com/nonechen-collab/taoyuan-real-price-map ；git 身分已設成 GitHub 隱藏信箱（repo 本地設定）
- 第一步完成：本機與 GitHub Actions 都能下載內政部資料，結論已填進 SPEC 決策紀錄；`reports/step1_report.md` 是 Actions 版報告（Actions 會把報告 commit 回 repo，本機改檔前先 `git pull --rebase`）
- 「前期下載」網址可補季檔缺口：`DownloadHistory?type=history&fileName=20261001`；10/1 那期已存於 `data/raw/_downloads/20261001.zip`（不進 repo）

## 下一步（照順序）
1. 第一步已由使用者確認（2026-10-19）；室內坪／公設比、預售交屋、特殊交易清單已定案寫進 SPEC「資料清理」
2. 等使用者決定地理編碼來源：建議改用桃園市門牌位置坐標開放資料（研究與實測見 docs/research-2026-10.md §4.1）；定案後改寫 SPEC「地理編碼」一節
3. 之後才進 Phase 1；管線每次要下載「本期＋前期」，避免漏期
