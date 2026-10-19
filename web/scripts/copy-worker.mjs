// MapLibre 6 的 worker 是獨立檔案：複製到 public/ 原樣提供（Vite 開發模式會改寫 node_modules 裡的檔案，worker 會壞掉）
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
copyFileSync(join(dist, "maplibre-gl-worker.mjs"), new URL("../public/maplibre-gl-worker.mjs", import.meta.url));
console.log("已複製 maplibre-gl-worker.mjs → public/");
