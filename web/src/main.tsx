import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";
import "./phase2.css";

// 離線快取：網站有新版時，新版在背景裝好後自動重新載入
// （資料格式改版時，手機裡的舊程式讀新資料會出錯，必須換成新程式）
registerSW({ immediate: true });

// 開發測試用：網址加 ?raf 時，在背景分頁也用計時器繪製地圖（隱藏的瀏覽器分頁不會觸發 requestAnimationFrame）
if (import.meta.env.DEV && new URLSearchParams(location.search).has("raf")) {
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
