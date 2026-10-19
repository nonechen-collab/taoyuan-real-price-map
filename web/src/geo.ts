import type { LngLat } from "./types";

const R = 6378137;

/** 兩點距離（公尺） */
export function distance(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function pointInPolygon(p: LngLat, poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 圓形範圍的多邊形（畫在地圖上） */
export function circlePolygon(center: LngLat, radius: number, steps = 64): LngLat[] {
  const out: LngLat[] = [];
  const latR = radius / 110574;
  const lonR = radius / (111320 * Math.cos((center[1] * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([center[0] + lonR * Math.cos(a), center[1] + latR * Math.sin(a)]);
  }
  return out;
}

// ── 六角格（Web Mercator 公尺座標，尖頂朝上） ──

const mercX = (lon: number) => (lon * Math.PI * R) / 180;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invX = (x: number) => (x / R) * (180 / Math.PI);
const invY = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

/** 各縮放層級的六角格大小（中心到頂點，Mercator 公尺；桃園緯度約 ×0.9 為實際公尺） */
export function hexSize(zoom: number): number {
  if (zoom < 10) return 2400;
  if (zoom < 11) return 1300;
  if (zoom < 12) return 700;
  return 380;
}

export function hexKey(lon: number, lat: number, size: number): string {
  const x = mercX(lon);
  const y = mercY(lat);
  const q = ((Math.sqrt(3) / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  // cube rounding
  let rx = Math.round(q);
  let rz = Math.round(r);
  const ry = Math.round(-q - r);
  const dx = Math.abs(rx - q);
  const dy = Math.abs(ry - (-q - r));
  const dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (!(dy > dz)) rz = -rx - ry;
  return `${rx},${rz}`;
}

export function hexPolygon(key: string, size: number): LngLat[] {
  const [q, r] = key.split(",").map(Number);
  const cx = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const cy = size * (1.5 * r);
  const pts: LngLat[] = [];
  for (let i = 0; i <= 6; i++) {
    const a = ((60 * (i % 6) - 30) * Math.PI) / 180;
    pts.push([invX(cx + size * Math.cos(a)), invY(cy + size * Math.sin(a))]);
  }
  return pts;
}

export function hexCenter(key: string, size: number): LngLat {
  const [q, r] = key.split(",").map(Number);
  return [invX(size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r)), invY(size * 1.5 * r)];
}

/** 同一棟多筆成交：以黃金角螺旋錯開幾公尺，放大時才看得到每一筆 */
export function spiralOffset(center: LngLat, n: number): LngLat {
  if (n === 0) return center;
  const a = n * 2.39996;
  const d = 3.2 * Math.sqrt(n);
  return [
    center[0] + (d * Math.cos(a)) / (111320 * Math.cos((center[1] * Math.PI) / 180)),
    center[1] + (d * Math.sin(a)) / 110574,
  ];
}
