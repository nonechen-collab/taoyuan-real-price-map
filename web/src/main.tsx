import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

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
