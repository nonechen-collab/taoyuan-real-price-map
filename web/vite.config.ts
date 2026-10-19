import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages 專案網址：https://nonechen-collab.github.io/taoyuan-real-price-map/
const base = process.env.BASE_PATH ?? "/taoyuan-real-price-map/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "桃園實價登錄地圖",
        short_name: "桃園實價",
        description: "桃園市買賣、預售屋實價登錄地圖：看附近成交、比較建案、議價找比較案例",
        lang: "zh-Hant-TW",
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        background_color: "#f6f7f9",
        theme_color: "#1d4ed8",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2}"],
        navigateFallback: `${base}index.html`,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // 成交資料：有網路就拿新的，離線時用上次載入的
            urlPattern: ({ url }) => url.pathname.includes("/data/") && url.pathname.endsWith(".json"),
            handler: "NetworkFirst",
            options: {
              cacheName: "lvr-data",
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
          {
            // 國土測繪中心底圖圖磚
            urlPattern: ({ url }) => url.hostname === "wmts.nlsc.gov.tw",
            handler: "CacheFirst",
            options: {
              cacheName: "nlsc-tiles",
              expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
