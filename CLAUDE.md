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
- Python 3.13.15 已用 winget 裝在使用者帳號下（`%LOCALAPPDATA%\Programs\Python\Python313`，已加進 PATH）；Git 2.54；沒有 gh CLI
- workflow 已移到 `.github/workflows/step1-probe.yml`
- 第一步本機實測完成：本期、115S3 下載成功，報告在 `reports/step1_report.md`，結論已填進 SPEC 決策紀錄
- 發現「前期下載」網址可補季檔缺口：`DownloadHistory?type=history&fileName=20261001`；10/1 那期已存於 `data/raw/_downloads/20261001.zip`
- 還沒有 GitHub repo；GitHub Actions 尚未測

## 下一步（照順序）
1. 使用者在 github.com 建立空的公開 repo `taoyuan-real-price-map`，告知帳號名稱；用 noreply 信箱設定 repo 的 git 身分後 commit、推送（Git Credential Manager 會跳瀏覽器登入）
2. 確認 step1-probe workflow 在 GitHub Actions 上也下載成功，把結果填進 SPEC
3. 等使用者確認第一步，並決定：室內坪／公設比公式、特殊交易關鍵字清單、買賣表內預售交屋的處理（建議見 SPEC 決策紀錄）
4. Phase 1 前必須先和使用者決定「地理編碼來源」：TGOS 自 2025-04-07 起個人可能申請不到（見研究摘要），SPEC 原本的定位順序要重新決定
5. Phase 1 管線每次要下載「本期＋前期」，避免漏期
