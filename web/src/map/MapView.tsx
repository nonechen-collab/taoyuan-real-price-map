import { useEffect, useRef } from "react";
import {
  Map as MLMap,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type MapLayerTouchEvent,
  type MapMouseEvent,
  type StyleSpecification,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre 6 的 worker 是獨立檔案，由 scripts/copy-worker.mjs 複製到 public/ 原樣提供
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre-gl-worker.mjs`);
import { COLORS } from "../stats";
import { circlePolygon } from "../geo";
import type { LngLat, Scope } from "../types";

export type Basemap = "emap" | "gray" | "photo";

export interface ViewState {
  bounds: [number, number, number, number]; // w, s, e, n
  zoom: number;
  center: LngLat;
}

export interface FlyTarget {
  center: LngLat;
  zoom?: number;
  key: number;
}

interface Props {
  initial: { center: LngLat; zoom: number };
  txFC: GeoJSON.FeatureCollection;
  commFC: GeoJSON.FeatureCollection;
  hexFC: GeoJSON.FeatureCollection;
  breaks: number[];
  basemap: Basemap;
  village: boolean;
  dark: boolean;
  scope: Scope;
  drawing: LngLat[] | null;
  myLocation: LngLat | null;
  selected: number | null;
  fly: FlyTarget | null;
  onView: (v: ViewState) => void;
  onSelectTx: (i: number) => void;
  onSelectCommunity: (cid: number) => void;
  onLongPress: (p: LngLat) => void;
  onDrawTap: (p: LngLat) => void;
}

export const ZOOM_COMM = 13;
export const ZOOM_TX = 16;
const NLSC = (layer: string, ext = "") =>
  `https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}${ext}`;
const FONTS = ["Roboto", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", "PingFang TC", "sans-serif"];
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const ATTR = '底圖 © <a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener">內政部國土測繪中心</a>';

function stepColor(prop: string, breaks: number[]): ExpressionSpecification {
  const e: unknown[] = ["step", ["to-number", ["get", prop], 0], COLORS[0]];
  breaks.forEach((b, i) => e.push(b, COLORS[i + 1]));
  return ["case", ["==", ["get", prop], null], "#9ca3af", e] as unknown as ExpressionSpecification;
}

function makeStyle(): StyleSpecification {
  const raster = (id: string, url: string, maxzoom = 18) => ({
    [id]: { type: "raster" as const, tiles: [url], tileSize: 256, maxzoom, attribution: ATTR },
  });
  return {
    version: 8,
    sources: {
      ...raster("emap", NLSC("EMAP")),
      ...raster("gray", NLSC("EMAP01")),
      ...raster("photo", NLSC("PHOTO2"), 19),
      ...raster("labels", NLSC("EMAP2")),
      ...raster("village", NLSC("Village"), 17),
      hex: { type: "geojson", data: EMPTY },
      comm: { type: "geojson", data: EMPTY },
      tx: { type: "geojson", data: EMPTY },
      scope: { type: "geojson", data: EMPTY },
      draw: { type: "geojson", data: EMPTY },
      me: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e5e7eb" } },
      { id: "emap", type: "raster", source: "emap" },
      { id: "gray", type: "raster", source: "gray", layout: { visibility: "none" } },
      { id: "photo", type: "raster", source: "photo", layout: { visibility: "none" } },
      { id: "labels", type: "raster", source: "labels", layout: { visibility: "none" } },
      { id: "village", type: "raster", source: "village", layout: { visibility: "none" }, paint: { "raster-opacity": 0.8 } },
      // 縮小：六角格
      {
        id: "hex-fill", type: "fill", source: "hex", maxzoom: ZOOM_COMM,
        paint: { "fill-color": "#9ca3af", "fill-opacity": 0.55, "fill-outline-color": "rgba(255,255,255,0.6)" },
      },
      {
        id: "hex-label", type: "symbol", source: "hex", minzoom: 10.5, maxzoom: ZOOM_COMM,
        layout: { "text-field": ["get", "l"], "text-size": 12, "text-font": FONTS, "text-allow-overlap": false },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      },
      // 中間：社區泡泡
      {
        id: "comm-circle", type: "circle", source: "comm", minzoom: ZOOM_COMM, maxzoom: ZOOM_TX,
        paint: {
          "circle-color": "#9ca3af",
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            ZOOM_COMM, ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 1, 4, 4, 8, 10, 15, 20, 22],
            ZOOM_TX, ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 1, 9, 4, 14, 10, 24, 20, 34],
          ],
          "circle-opacity": 0.85,
          "circle-stroke-width": ["case", ["==", ["get", "p"], 1], 2.5, 1],
          "circle-stroke-color": ["case", ["==", ["get", "p"], 1], "#1d4ed8", "#ffffff"],
        },
      },
      {
        id: "comm-label", type: "symbol", source: "comm", minzoom: ZOOM_COMM, maxzoom: ZOOM_TX,
        // 縮小時只標件數多的社區，放大到 14.5 以上全部標
        filter: ["any", [">=", ["zoom"], 14.5], [">=", ["get", "n"], 3]],
        layout: {
          "text-field": ["format", ["get", "l"], { "font-scale": 1 }, "\n", {}, ["concat", ["get", "n"], " 件"], { "font-scale": 0.75 }],
          "text-size": 12, "text-font": FONTS, "text-line-height": 1.1, "symbol-sort-key": ["-", 0, ["get", "n"]],
        },
        paint: { "text-color": "#111827", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.2 },
      },
      // 放大：單筆
      {
        id: "tx-circle", type: "circle", source: "tx", minzoom: ZOOM_TX,
        paint: {
          "circle-color": "#9ca3af",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 5, 19, 9],
          "circle-stroke-width": ["case", ["==", ["get", "k"], 1], 2, 1],
          "circle-stroke-color": ["case", ["==", ["get", "k"], 1], "#1d4ed8", "#ffffff"],
        },
      },
      {
        id: "tx-label", type: "symbol", source: "tx", minzoom: ZOOM_TX + 0.5,
        layout: {
          "text-field": ["get", "l"], "text-size": 12, "text-font": FONTS, "text-offset": [0, -1.2],
          "text-anchor": "bottom", "symbol-sort-key": ["get", "o"],
        },
        paint: { "text-color": "#111827", "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.5 },
      },
      {
        id: "tx-selected", type: "circle", source: "tx", minzoom: 12, filter: ["==", ["get", "i"], -1],
        paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": "#f43f5e" },
      },
      // 範圍
      { id: "scope-fill", type: "fill", source: "scope", paint: { "fill-color": "#1d4ed8", "fill-opacity": 0.08 } },
      { id: "scope-line", type: "line", source: "scope", paint: { "line-color": "#1d4ed8", "line-width": 2, "line-dasharray": [2, 1] } },
      { id: "draw-line", type: "line", source: "draw", paint: { "line-color": "#f43f5e", "line-width": 2.5 } },
      {
        id: "draw-pt", type: "circle", source: "draw", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 6, "circle-color": "#ffffff", "circle-stroke-width": 2.5, "circle-stroke-color": "#f43f5e" },
      },
      {
        id: "me", type: "circle", source: "me",
        paint: { "circle-radius": 8, "circle-color": "#2563eb", "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" },
      },
    ],
  };
}

function scopeFC(scope: Scope): GeoJSON.FeatureCollection {
  if (scope.kind === "circle") {
    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePolygon(scope.center, scope.radius)] } },
      ],
    };
  }
  if (scope.kind === "polygon" && scope.points.length >= 3) {
    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...scope.points, scope.points[0]]] } },
      ],
    };
  }
  return EMPTY;
}

function drawFC(pts: LngLat[] | null): GeoJSON.FeatureCollection {
  if (!pts || !pts.length) return EMPTY;
  const features: GeoJSON.Feature[] = pts.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
  if (pts.length >= 2) {
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts.length >= 3 ? [...pts, pts[0]] : pts } });
  }
  return { type: "FeatureCollection", features };
}

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const props = useRef(p);
  props.current = p;

  // 建立地圖（只做一次）
  useEffect(() => {
    const m = new MLMap({
      container: el.current!,
      style: makeStyle(),
      center: p.initial.center,
      zoom: p.initial.zoom,
      minZoom: 8,
      maxZoom: 19.5,
      maxBounds: [[120.6, 24.4], [121.9, 25.4]],
      attributionControl: { compact: true },
      localIdeographFontFamily: "'Noto Sans TC', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'PingFang TC', sans-serif",
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    m.touchZoomRotate.disableRotation();
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m;
    m.on("error", (e) => console.warn("[map]", e.error?.message ?? e));

    const emitView = () => {
      const b = m.getBounds();
      const c = m.getCenter();
      props.current.onView({ bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: m.getZoom(), center: [c.lng, c.lat] });
    };
    m.on("load", () => {
      ready.current = true;
      apply(m, props.current, true);
      emitView();
    });
    m.on("moveend", emitView);

    // 點選
    const drawingNow = () => props.current.drawing !== null;
    m.on("click", (e: MapMouseEvent) => {
      if (drawingNow()) props.current.onDrawTap([e.lngLat.lng, e.lngLat.lat]);
    });
    m.on("click", "tx-circle", (e: MapLayerMouseEvent) => {
      if (drawingNow()) return;
      const f = e.features?.[0];
      if (f) props.current.onSelectTx(f.properties.i as number);
    });
    m.on("click", "comm-circle", (e: MapLayerMouseEvent) => {
      if (drawingNow()) return;
      const f = e.features?.[0];
      if (f) props.current.onSelectCommunity(f.properties.c as number);
    });
    m.on("click", "hex-fill", (e: MapLayerMouseEvent) => {
      if (drawingNow()) return;
      m.easeTo({ center: e.lngLat, zoom: Math.min(m.getZoom() + 2, ZOOM_COMM + 0.5) });
    });
    for (const id of ["tx-circle", "comm-circle", "hex-fill"]) {
      m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
    }

    // 長按設圓心（手機）；桌機用右鍵
    let timer: number | undefined;
    let start: { x: number; y: number } | null = null;
    const cancel = () => {
      window.clearTimeout(timer);
      start = null;
    };
    m.on("touchstart", (e: MapLayerTouchEvent) => {
      if (e.originalEvent.touches.length !== 1 || drawingNow()) return cancel();
      start = { x: e.point.x, y: e.point.y };
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (start) {
          navigator.vibrate?.(30);
          props.current.onLongPress(ll);
        }
        start = null;
      }, 550);
    });
    m.on("touchmove", (e: MapLayerTouchEvent) => {
      if (start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10) cancel();
    });
    m.on("touchend", cancel);
    m.on("touchcancel", cancel);
    m.on("movestart", (e: { originalEvent?: Event }) => {
      if (e.originalEvent) cancel();
    });
    m.on("contextmenu", (e: MapMouseEvent) => {
      if (!drawingNow()) props.current.onLongPress([e.lngLat.lng, e.lngLat.lat]);
    });

    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 資料與設定變動
  useEffect(() => {
    if (map.current && ready.current) apply(map.current, p, false);
  });

  // 飛到指定位置
  useEffect(() => {
    if (p.fly && map.current) {
      map.current.flyTo({ center: p.fly.center, zoom: p.fly.zoom ?? Math.max(map.current.getZoom(), 16.5), speed: 1.6 });
    }
  }, [p.fly]);

  return <div ref={el} className="map" />;
}

// 只在值改變時才更新地圖，避免每次重繪都 setData
const last = new WeakMap<MLMap, Record<string, unknown>>();

function apply(m: MLMap, p: Props, force: boolean) {
  const prev = last.get(m) ?? {};
  const changed = (k: string, v: unknown) => {
    if (!force && prev[k] === v) return false;
    prev[k] = v;
    return true;
  };
  const src = (id: string) => m.getSource(id) as GeoJSONSource | undefined;
  if (changed("tx", p.txFC)) src("tx")?.setData(p.txFC);
  if (changed("comm", p.commFC)) src("comm")?.setData(p.commFC);
  if (changed("hex", p.hexFC)) src("hex")?.setData(p.hexFC);
  if (changed("scope", p.scope)) src("scope")?.setData(scopeFC(p.scope));
  if (changed("draw", p.drawing)) src("draw")?.setData(drawFC(p.drawing));
  if (changed("me", p.myLocation)) {
    src("me")?.setData(
      p.myLocation
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p.myLocation } }] }
        : EMPTY,
    );
  }
  if (changed("breaks", p.breaks.join(","))) {
    m.setPaintProperty("hex-fill", "fill-color", stepColor("m", p.breaks));
    m.setPaintProperty("comm-circle", "circle-color", stepColor("m", p.breaks));
    m.setPaintProperty("tx-circle", "circle-color", stepColor("up", p.breaks));
  }
  if (changed("selected", p.selected)) m.setFilter("tx-selected", ["==", ["get", "i"], p.selected ?? -1]);
  if (changed("base", `${p.basemap}|${p.village}|${p.dark}`)) {
    for (const id of ["emap", "gray", "photo"] as const) m.setLayoutProperty(id, "visibility", id === p.basemap ? "visible" : "none");
    m.setLayoutProperty("labels", "visibility", p.basemap === "photo" ? "visible" : "none");
    m.setLayoutProperty("village", "visibility", p.village ? "visible" : "none");
    // 深色模式：電子地圖反轉亮度（raster-brightness 上下限對調）並降低飽和度
    for (const id of ["emap", "gray"]) {
      m.setPaintProperty(id, "raster-brightness-min", p.dark ? 0.92 : 0);
      m.setPaintProperty(id, "raster-brightness-max", p.dark ? 0.08 : 1);
      m.setPaintProperty(id, "raster-saturation", p.dark ? -0.7 : 0);
    }
    m.setPaintProperty("bg", "background-color", p.dark ? "#111827" : "#e5e7eb");
    const halo = p.dark ? "rgba(17,24,39,0.95)" : "rgba(255,255,255,0.95)";
    const text = p.dark ? "#f9fafb" : "#111827";
    for (const id of ["hex-label", "comm-label", "tx-label"]) {
      m.setPaintProperty(id, "text-color", text);
      m.setPaintProperty(id, "text-halo-color", halo);
    }
  }
  last.set(m, prev);
}
