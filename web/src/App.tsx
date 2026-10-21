import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { ZOOM_COMM, ZOOM_TX, type Basemap, type FlyTarget, type ViewState } from "./map/MapView";
import BottomSheet, { type SheetState } from "./components/BottomSheet";
import FilterDrawer from "./components/FilterDrawer";
import StatsCard from "./components/StatsCard";
import TxCard from "./components/TxCard";
import RentCard, { RentStats } from "./components/RentCard";
import { About, LayerMenu, Legend, NO_LAYERS, type LayerState } from "./components/Overlays";
import { getJson, loadMeta, loadPart, loadSearch, newRegistry } from "./data";
import { communityMedians, deviation } from "./analysis";
import { exportCsv, exportRentCsv } from "./csv";
import {
  RENT_FIXED_BREAKS, fmtRu, grossYield, loadRentDistrict, makeRentCtx, passRent, rentBreaks, summarizeRent, type RentKind,
} from "./rent";
import { today, useFavorites, type Fav, type FavArea } from "./favorites";
import ComparePage, { MAX_COMPARE, type ComparePick } from "./pages/ComparePage";
import EntityPage, { txFav } from "./pages/EntityPage";
import FavoritesPage from "./pages/FavoritesPage";
import SearchPage from "./pages/SearchPage";
import TrendPage, { freeSlot, MAX_PICKS, type TrendPick } from "./pages/TrendPage";
import ValuationPage from "./pages/ValuationPage";
import {
  PERIOD_LABEL, activeCount, defaultFilters, filtersFromParams, filtersToParams, makeCtx, pass, type Filters,
} from "./filters";
import { fmtRoc, fmtUnitShort } from "./format";
import { distance, hexKey, hexPolygon, hexSize, pointInPolygon, spiralOffset } from "./geo";
import { FIXED_BREAKS, median, quantileBreaks, summarize } from "./stats";
import type { Community, Entity, LngLat, Meta, Page, Rent, RentMeta, Scope, SearchEntry, Tx } from "./types";

// 預設地圖中心：桃園市中心（桃園市政府／桃園火車站一帶）
const DEFAULT_CENTER: LngLat = [121.3078, 24.9915];
const DEFAULT_ZOOM = 14;
const RADII = [300, 500, 1000];
const PAGE = 80;

type Sort = "date" | "dist" | "up";

function readHash() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 無痕模式等情況存不了，不影響使用 */
  }
}

/** 同一個分頁只自動重新載入一次，避免一直重整 */
function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem("autoReloaded")) return false;
    sessionStorage.setItem("autoReloaded", "1");
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function parseLL(s: string | null): LngLat | null {
  if (!s) return null;
  const [lat, lon] = s.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
}
const llStr = (p: LngLat) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;

/** 網址的 pg 參數 ↔ 分頁 */
function parsePg(h: URLSearchParams): Page | null {
  const v = h.get("pg");
  if (!v) return null;
  if (v.startsWith("c:")) return { kind: "c", id: v.slice(2) };
  if (v.startsWith("p:")) return { kind: "p", id: v.slice(2) };
  if (v === "trend" || v === "cmp" || v === "fav" || v === "search" || v === "val") return { kind: v };
  return null;
}
const pgStr = (p: Page) => (p.kind === "c" || p.kind === "p" ? `${p.kind}:${p.id}` : p.kind);
const entityKind = (id: string): "c" | "p" => (id.startsWith("p") ? "p" : "c");

// ── 買賣與租賃共用：畫面內、範圍、排序、地圖圖層 ──
interface Pt {
  i: number;
  lat: number | null;
  lon: number | null;
  cid: number;
  date: number;
}

function inViewOf<T extends Pt>(xs: T[], view: ViewState | null): T[] {
  if (!view) return [];
  const [w, s, e, n] = view.bounds;
  return xs.filter((t) => t.lat != null && t.lon != null && t.lon >= w && t.lon <= e && t.lat >= s && t.lat <= n);
}

function distOf<T extends Pt>(xs: T[], scope: Scope): Map<number, number> | null {
  if (scope.kind !== "circle") return null;
  const m = new Map<number, number>();
  for (const t of xs) if (t.lat != null && t.lon != null) m.set(t.i, distance(scope.center, [t.lon, t.lat]));
  return m;
}

function scopedOf<T extends Pt>(xs: T[], scope: Scope, inView: T[], dist: Map<number, number> | null): T[] {
  switch (scope.kind) {
    case "circle":
      return xs.filter((t) => (dist?.get(t.i) ?? Infinity) <= scope.radius);
    case "polygon":
      return xs.filter((t) => t.lat != null && t.lon != null && pointInPolygon([t.lon, t.lat], scope.points));
    case "community":
      return xs.filter((t) => t.cid === scope.cid);
    default:
      return inView;
  }
}

function sortedOf<T extends Pt>(xs: T[], sort: Sort, dist: Map<number, number> | null, val: (x: T) => number | null): T[] {
  const arr = [...xs];
  if (sort === "dist" && dist) arr.sort((a, b) => (dist.get(a.i) ?? 1e9) - (dist.get(b.i) ?? 1e9));
  else if (sort === "up") arr.sort((a, b) => (val(b) ?? -1) - (val(a) ?? -1));
  else arr.sort((a, b) => b.date - a.date);
  return arr;
}

function pointFC<T extends Pt>(xs: T[], val: (x: T) => number | null, label: (v: number | null) => string, kind: (x: T) => number): GeoJSON.FeatureCollection {
  const byPt = new Map<string, number>();
  const pts = xs.filter((t) => t.lat != null && t.lon != null).sort((a, b) => b.date - a.date);
  return {
    type: "FeatureCollection",
    features: pts.map((t, o) => {
      const k = `${t.lat},${t.lon}`;
      const n = byPt.get(k) ?? 0;
      byPt.set(k, n + 1);
      const v = val(t);
      return {
        type: "Feature",
        properties: { i: t.i, up: v, l: label(v), k: kind(t), o },
        geometry: { type: "Point", coordinates: spiralOffset([t.lon!, t.lat!], n) },
      };
    }),
  };
}

function commFCOf<T extends Pt>(xs: T[], comms: Community[], val: (x: T) => number | null, label: (v: number | null) => string): GeoJSON.FeatureCollection {
  const groups = new Map<number, number[]>();
  for (const t of xs) {
    const v = val(t);
    if (t.cid < 0 || v == null) continue;
    const g = groups.get(t.cid);
    if (g) g.push(v);
    else groups.set(t.cid, [v]);
  }
  const features: GeoJSON.Feature[] = [];
  for (const [cid, vs] of groups) {
    const c = comms[cid];
    if (!c || c.lat == null || c.lon == null) continue;
    const m = median(vs);
    features.push({
      type: "Feature",
      properties: { c: cid, n: vs.length, m, l: label(m), p: c.presale ? 1 : 0 },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

function hexFCOf<T extends Pt>(xs: T[], val: (x: T) => number | null, zoomBucket: number, label: (v: number | null) => string): GeoJSON.FeatureCollection {
  const size = hexSize(zoomBucket);
  const groups = new Map<string, number[]>();
  for (const t of xs) {
    const v = val(t);
    if (t.lat == null || t.lon == null || v == null) continue;
    const k = hexKey(t.lon, t.lat, size);
    const g = groups.get(k);
    if (g) g.push(v);
    else groups.set(k, [v]);
  }
  const features: GeoJSON.Feature[] = [];
  for (const [k, vs] of groups) {
    const m = median(vs);
    features.push({
      type: "Feature",
      properties: { m, n: vs.length, l: vs.length >= 3 ? label(m) : "", key: k },
      geometry: { type: "Polygon", coordinates: [hexPolygon(k, size)] },
    });
  }
  return { type: "FeatureCollection", features };
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PoiFile {
  stations: { rows: [string, string, number, number, number][] };
  schools: { rows: [string, string, number, number][] };
  parks: { rows: [string, number, number][] };
}

/** 淹水潛勢：西南東北矩形 → 多邊形 */
function floodFC(rects: [number, number, number, number, number][]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: rects.map(([w, s, e, n, c]) => ({
      type: "Feature",
      properties: { c },
      geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    })),
  };
}

function inArea(a: FavArea, lon: number, lat: number): boolean {
  return a.type === "circle" ? distance(a.center, [lon, lat]) <= a.radius : pointInPolygon([lon, lat], a.points);
}

const saleVal = (t: Tx) => t.up;
const rentVal = (r: Rent) => r.ru;

export default function App() {
  const hash = useRef(readHash());
  const initial = useRef({
    center: parseLL(hash.current.get("c")) ?? DEFAULT_CENTER,
    zoom: Number(hash.current.get("z")) || DEFAULT_ZOOM,
  });

  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comms, setComms] = useState<Community[]>([]);
  const [all, setAll] = useState<Tx[]>([]);
  const [loaded, setLoaded] = useState(0); // 已載入「近 12 月」的區數
  const [oldLoaded, setOldLoaded] = useState(0); // 已載入「更早」的區數
  const [oldState, setOldState] = useState<"idle" | "loading" | "done">("idle");
  const [wantOld, setWantOld] = useState(false); // 網址帶的成交／社區不在近 12 月時要載更早資料
  const reg = useRef(newRegistry());
  const nextIdx = useRef(0);
  const order = useRef<Meta["districts"]>([]);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "view" });
  const [view, setView] = useState<ViewState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [sheet, setSheet] = useState<SheetState>("half");
  const [basemap, setBasemap] = useState<Basemap>(() => store("basemap", "emap"));
  const [village, setVillage] = useState<boolean>(() => store("village", false));
  const [colorMode, setColorMode] = useState<"q" | "f">(() => store("colorMode", "q"));
  const [radius, setRadius] = useState(500);
  const [drawing, setDrawing] = useState<LngLat[] | null>(null);
  const [myLoc, setMyLoc] = useState<LngLat | null>(null);
  const [fly, setFly] = useState<FlyTarget | null>(null);
  const [panel, setPanel] = useState<"" | "filter" | "layer" | "about" | "menu">("");
  const [online, setOnline] = useState(navigator.onLine);
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [limit, setLimit] = useState(PAGE);
  const [sort, setSort] = useState<Sort>("date");
  const [toast, setToast] = useState<string | null>(null);
  const pendingTx = useRef<string | null>(hash.current.get("t"));
  const pendingComm = useRef<string | null>(hash.current.get("cm"));
  const [page, setPage] = useState<Page | null>(() => parsePg(hash.current));
  const pushed = useRef(0); // 這次開啟後推進瀏覽紀錄的分頁數（返回鍵用）
  const shardHints = useRef(new Map<string, number>());
  const [hintTick, setHintTick] = useState(0);
  const [trendPicks, setTrendPicks] = useState<TrendPick[]>(() => store("trendPicks", []));
  const [cmpPicks, setCmpPicks] = useState<ComparePick[]>(() => store("cmpPicks", []));
  const favs = useFavorites();
  // 租賃模式（近 3 年租約，切換時才下載）
  const [mode, setMode] = useState<"sale" | "rent">(() => (hash.current.get("m") === "r" ? "rent" : "sale"));
  const [rents, setRents] = useState<Rent[]>([]);
  const [rentLoaded, setRentLoaded] = useState(0);
  const [rentState, setRentState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [rentKind, setRentKind] = useState<RentKind>("all");
  // 圖層：土壤液化、淹水潛勢、車站學校公園
  const [layers, setLayers] = useState<LayerState>(() => ({ ...NO_LAYERS, ...store<Partial<LayerState>>("layers", {}) }));
  const [floodData, setFloodData] = useState<Record<string, GeoJSON.FeatureCollection>>({});
  const [poi, setPoi] = useState<PoiFile | null>(null);

  useEffect(() => save("basemap", basemap), [basemap]);
  useEffect(() => save("village", village), [village]);
  useEffect(() => save("colorMode", colorMode), [colorMode]);
  useEffect(() => save("trendPicks", trendPicks), [trendPicks]);
  useEffect(() => save("cmpPicks", cmpPicks), [cmpPicks]);
  useEffect(() => save("layers", layers), [layers]);
  // Android 返回鍵：關閉分頁（回到上一頁或地圖），不直接離開網站
  useEffect(() => {
    const on = () => {
      pushed.current = Math.max(0, pushed.current - 1);
      setPage(parsePg(readHash()));
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const md = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", md);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      mq.removeEventListener("change", md);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ── 載入：meta → 各區「近 12 月」（離目前位置近的先載）；「更早」按需載入 ──
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await loadMeta();
        if (!alive) return;
        setMeta(m);
        const d = defaultFilters(m);
        setFilters(filtersFromParams(hash.current, d));
        const p = hash.current;
        const sc = p.get("sc");
        const sp = p.get("sp");
        if (sc) {
          const [lat, lon, r] = sc.split(",").map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            setScope({ kind: "circle", center: [lon, lat], radius: r || 500, source: "press" });
            setRadius(r || 500);
            setSort("dist");
          }
        } else if (sp) {
          const pts = sp.split(";").map(parseLL).filter((x): x is LngLat => !!x);
          if (pts.length >= 3) setScope({ kind: "polygon", points: pts });
        }
        const start = initial.current.center;
        const dist = (d: (typeof m.districts)[number]) => (d.lat != null && d.lon != null ? distance(start, [d.lon, d.lat]) : 1e9);
        order.current = [...m.districts].sort((a, b) => dist(a) - dist(b));
        for (const d of order.current) {
          const part = d.parts.find((x) => x.key === "r");
          if (part) {
            const txs = await loadPart(d, part, nextIdx.current, reg.current);
            if (!alive) return;
            nextIdx.current += txs.length;
            setAll((prev) => prev.concat(txs));
            setComms([...reg.current.list]);
          }
          setLoaded((n) => n + 1);
        }
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        // 找不到檔案或格式不符，多半是手機裡的舊程式遇到新版資料：同一次瀏覽自動重新載入一次
        if (/HTTP 404|格式已更新/.test(msg) && reloadOnce()) return;
        setError(msg);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const defaults = useMemo(() => (meta ? defaultFilters(meta) : null), [meta]);
  const latest = useMemo(() => (meta ? Number(meta.range.to.replaceAll("-", "")) : 0), [meta]);
  const recentDone = !!meta && loaded === meta.districts.length;
  const oldDone = oldState === "done";

  // 選「近 3 年」或自訂到更早的期間時，才下載各區「更早」的資料
  const needOld = useMemo(() => {
    if (!meta || !filters) return false;
    const split = Number(meta.split.replaceAll("-", ""));
    if (filters.period === "3y") return true;
    if (filters.period === "custom") return filters.from == null || filters.from * 100 + 31 < split;
    return false;
  }, [meta, filters]);

  useEffect(() => {
    if (!(needOld || wantOld) || !recentDone || oldState !== "idle") return;
    setOldState("loading");
    // 一旦開始就載完（使用者中途切回近 12 月也不中斷，否則狀態會卡在載入中）
    (async () => {
      try {
        for (const d of order.current) {
          const part = d.parts.find((x) => x.key === "o");
          if (part) {
            const txs = await loadPart(d, part, nextIdx.current, reg.current);
            nextIdx.current += txs.length;
            setAll((prev) => prev.concat(txs));
            setComms([...reg.current.list]);
          }
          setOldLoaded((n) => n + 1);
        }
        setOldState("done");
      } catch {
        setToast("更早的資料載入失敗，請稍後再試");
        setOldState("idle");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needOld, wantOld, recentDone]);

  // 切到「租賃」時下載各區租賃檔（離目前位置近的先載）；社區對應要等買賣近 12 月載完
  useEffect(() => {
    if (mode !== "rent" || !meta?.rent || !recentDone || rentState !== "idle") return;
    setRentState("loading");
    (async () => {
      try {
        const rm = meta.rent!;
        const byName = new Map(rm.districts.map((d) => [d.name, d]));
        const near = order.current.map((d) => byName.get(d.name)).filter((d): d is RentMeta["districts"][number] => !!d);
        const rest = rm.districts.filter((d) => !near.includes(d));
        const codeOf = (name: string) => meta.districts.find((x) => x.name === name)?.code ?? name;
        let start = 0;
        for (const d of [...near, ...rest]) {
          const rs = await loadRentDistrict(d, start, reg.current, codeOf);
          start += rs.length;
          setRents((prev) => prev.concat(rs));
          setRentLoaded((n) => n + 1);
        }
        setRentState("done");
      } catch {
        setRents([]);
        setRentLoaded(0);
        setRentState("error");
        setToast("租賃資料載入失敗，請稍後再切換一次");
      }
    })();
  }, [mode, meta, recentDone, rentState]);

  // 圖層資料按需下載
  useEffect(() => {
    const f = meta?.layers?.flood.find((x) => x.key === layers.flood);
    if (!f || floodData[f.key]) return;
    getJson<{ rects: [number, number, number, number, number][] }>(f.file)
      .then((d) => setFloodData((m) => ({ ...m, [f.key]: floodFC(d.rects) })))
      .catch(() => setToast("淹水潛勢圖層載入失敗"));
  }, [meta, layers.flood, floodData]);
  useEffect(() => {
    if (!meta?.layers?.poi || poi || !(layers.st || layers.sc || layers.pk)) return;
    getJson<PoiFile>(meta.layers.poi).then(setPoi).catch(() => setToast("車站、學校、公園圖層載入失敗"));
  }, [meta, poi, layers.st, layers.sc, layers.pk]);
  const poiFC = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!poi) return EMPTY_FC;
    const features: GeoJSON.Feature[] = [];
    const pt = (name: string, t: string, g: string, lat: number, lon: number, sz: number, b = 0): GeoJSON.Feature => ({
      type: "Feature", properties: { name, t, g, sz, b }, geometry: { type: "Point", coordinates: [lon, lat] },
    });
    if (layers.st) for (const [n, k, lat, lon, b] of poi.stations.rows) features.push(pt(n, k, "st", lat, lon, 10, b));
    if (layers.sc) for (const [n, , lat, lon] of poi.schools.rows) features.push(pt(n, "學校", "sc", lat, lon, 13.5));
    if (layers.pk) for (const [n, lat, lon] of poi.parks.rows) features.push(pt(n, "公園", "pk", lat, lon, 14));
    return { type: "FeatureCollection", features };
  }, [poi, layers.st, layers.sc, layers.pk]);

  const switchMode = useCallback((m: "sale" | "rent") => {
    setMode(m);
    setSelected(null);
    setSort((s) => (s === "dist" ? s : "date"));
    if (m === "rent") setRentState((st) => (st === "error" ? "idle" : st));
  }, []);

  // ── 篩選 ──
  const filtered = useMemo(() => {
    if (!meta || !filters) return [];
    const ctx = makeCtx(filters, meta, latest);
    return all.filter((t) => pass(t, filters, ctx));
  }, [all, filters, meta, latest]);

  const inView = useMemo(() => inViewOf(filtered, view), [filtered, view]);

  // 網址帶的社區、成交：資料載入後還原
  useEffect(() => {
    if (!pendingComm.current || !recentDone) return;
    const i = reg.current.byId.get(pendingComm.current);
    if (i !== undefined) {
      setScope({ kind: "community", cid: i });
      pendingComm.current = null;
    } else if (oldDone) pendingComm.current = null;
    else setWantOld(true);
  }, [comms, recentDone, oldDone]);
  useEffect(() => {
    if (!pendingTx.current || !recentDone) return;
    const t = all.find((x) => x.id === pendingTx.current);
    if (t) {
      setSelected(t.i);
      pendingTx.current = null;
    } else if (oldDone) pendingTx.current = null;
    else setWantOld(true);
  }, [all, recentDone, oldDone]);

  // ── 範圍內的成交（列表與統計） ──
  const dist = useMemo(() => distOf(filtered, scope), [filtered, scope]);
  const scoped = useMemo(() => scopedOf(filtered, scope, inView, dist), [scope, filtered, inView, dist]);
  const summary = useMemo(() => summarize(scoped), [scoped]);
  const sorted = useMemo(() => sortedOf(scoped, sort, dist, saleVal), [scoped, sort, dist]);

  // ── 租賃：同一套範圍與排序；毛租金報酬率用同範圍的買賣（不含預售）單價 ──
  const isRent = mode === "rent" && !!meta?.rent;
  const rentFiltered = useMemo(() => {
    if (!isRent || !filters || !meta?.rent) return [];
    const ctx = makeRentCtx(filters, meta.rent);
    return rents.filter((r) => passRent(r, filters, ctx, rentKind));
  }, [isRent, rents, filters, meta, rentKind]);
  const rInView = useMemo(() => inViewOf(rentFiltered, view), [rentFiltered, view]);
  const rDist = useMemo(() => distOf(rentFiltered, scope), [rentFiltered, scope]);
  const rScoped = useMemo(() => scopedOf(rentFiltered, scope, rInView, rDist), [rentFiltered, scope, rInView, rDist]);
  const rSorted = useMemo(() => sortedOf(rScoped, sort, rDist, rentVal), [rScoped, sort, rDist]);
  const rSummary = useMemo(() => (meta ? summarizeRent(rScoped, meta) : null), [rScoped, meta]);
  const saleForYield = useMemo(() => (isRent ? summarize(scoped.filter((t) => t.kind === 0)) : null), [isRent, scoped]);
  const yld = rSummary && saleForYield ? grossYield(rSummary.ruWhole, rSummary.nWhole, saleForYield.upMed, saleForYield.nUnit) : null;

  const breaks = useMemo(() => {
    if (isRent) return colorMode === "f" ? RENT_FIXED_BREAKS : rentBreaks(rInView.map(rentVal).filter((v): v is number => v != null));
    if (colorMode === "f") return FIXED_BREAKS;
    return quantileBreaks(inView.map(saleVal).filter((v): v is number => v != null));
  }, [isRent, rInView, inView, colorMode]);

  useEffect(() => setLimit(PAGE), [scope, filters, sort, mode, rentKind]);

  // ── 地圖圖層資料（租賃模式改畫每坪月租） ──
  const txFC = useMemo(
    () => (isRent ? pointFC(rentFiltered, rentVal, fmtRu, () => 0) : pointFC(filtered, saleVal, fmtUnitShort, (t) => t.kind)),
    [isRent, rentFiltered, filtered],
  );
  const commFC = useMemo(
    () => (isRent ? commFCOf(rentFiltered, comms, rentVal, fmtRu) : commFCOf(filtered, comms, saleVal, fmtUnitShort)),
    [isRent, rentFiltered, filtered, comms],
  );
  const zoomBucket = view ? Math.min(12, Math.floor(view.zoom)) : 12;
  const hexFC = useMemo(
    () => (isRent ? hexFCOf(rentFiltered, rentVal, zoomBucket, fmtRu) : hexFCOf(filtered, saleVal, zoomBucket, fmtUnitShort)),
    [isRent, rentFiltered, filtered, zoomBucket],
  );

  // ── 網址同步 ──
  useEffect(() => {
    if (!filters || !defaults) return;
    const t = window.setTimeout(() => {
      const p = new URLSearchParams();
      filtersToParams(filters, defaults, p);
      if (view) {
        p.set("c", llStr(view.center));
        p.set("z", view.zoom.toFixed(1));
      }
      if (scope.kind === "circle") p.set("sc", `${llStr(scope.center)},${scope.radius}`);
      if (scope.kind === "polygon") p.set("sp", scope.points.map(llStr).join(";"));
      if (scope.kind === "community" && comms[scope.cid]) p.set("cm", comms[scope.cid].id);
      const st = selected != null && mode === "sale" ? all[selected] : null;
      if (st) p.set("t", st.id);
      if (mode === "rent") p.set("m", "r");
      if (page) p.set("pg", pgStr(page));
      if (page?.kind === "val") {
        // 估價條件由估價頁自己寫進網址，這裡保留
        const cur = readHash();
        for (const k of ["vq", "vx"]) {
          const v = cur.get(k);
          if (v) p.set(k, v);
        }
      }
      window.history.replaceState(null, "", `#${p.toString()}`);
    }, 400);
    return () => window.clearTimeout(t);
  }, [filters, defaults, view, scope, selected, comms, all, page, mode]);

  // ── 互動 ──
  const scrollToCard = useCallback((i: number) => {
    window.setTimeout(() => document.getElementById(`tx-${i}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
  }, []);

  const onSelectTx = useCallback(
    (i: number) => {
      setSelected(i);
      setSheet((s) => (s === "min" ? "half" : s));
      const pos = (isRent ? rSorted : sorted).findIndex((t) => t.i === i);
      if (pos >= limit) setLimit(pos + 10);
      scrollToCard(i);
    },
    [isRent, rSorted, sorted, limit, scrollToCard],
  );

  const onRentSelect = useCallback((r: Rent) => {
    setSelected(r.i);
    if (r.lat != null && r.lon != null) setFly({ center: [r.lon, r.lat], zoom: Math.max(view?.zoom ?? 0, 17), key: Date.now() });
  }, [view]);

  const onCardSelect = useCallback((t: Tx) => {
    setSelected(t.i);
    if (t.lat != null && t.lon != null) setFly({ center: [t.lon, t.lat], zoom: Math.max(view?.zoom ?? 0, 17), key: Date.now() });
  }, [view]);

  const onSelectCommunity = useCallback((cid: number) => {
    setScope({ kind: "community", cid });
    setSheet((s) => (s === "min" ? "half" : s));
    setSort("date");
  }, []);

  const onLongPress = useCallback((p: LngLat) => {
    setScope({ kind: "circle", center: p, radius, source: "press" });
    setSort("dist");
    setSheet((s) => (s === "min" ? "half" : s));
    setToast("已設為圓心，列出範圍內成交");
  }, [radius]);

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setToast("這個瀏覽器不支援定位");
      return;
    }
    setToast("定位中…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
        setMyLoc(p);
        setScope({ kind: "circle", center: p, radius, source: "gps" });
        setSort("dist");
        setSheet("half");
        setFly({ center: p, zoom: radius >= 1000 ? 14.5 : 15.5, key: Date.now() });
        setToast(null);
      },
      (err) => {
        setToast(err.code === err.PERMISSION_DENIED ? "未允許定位：請到瀏覽器網站設定開啟位置權限" : "定位失敗，請到戶外或稍後再試");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }, [radius]);

  const setR = (r: number) => {
    setRadius(r);
    if (scope.kind === "circle") setScope({ ...scope, radius: r });
  };

  const finishDraw = () => {
    if (drawing && drawing.length >= 3) {
      setScope({ kind: "polygon", points: drawing });
      setSort("date");
      setSheet("half");
    }
    setDrawing(null);
  };

  // ── Phase 2：分頁、走勢、比較、收藏、匯出 ──
  const openPage = useCallback((p: Page) => {
    const h = readHash();
    h.set("pg", pgStr(p));
    window.history.pushState(null, "", `#${h.toString()}`);
    pushed.current += 1;
    setPage(p);
    setPanel("");
  }, []);
  const closePage = useCallback(() => {
    if (pushed.current > 0) window.history.back();
    else {
      const h = readHash();
      h.delete("pg");
      window.history.replaceState(null, "", `#${h.toString()}`);
      setPage(null);
    }
  }, []);
  const openEntity = useCallback((id: string, shard?: number) => {
    if (shard !== undefined) shardHints.current.set(id, shard);
    openPage({ kind: entityKind(id), id });
  }, [openPage]);

  // 分頁需要的歷史檔份數：先查已載入的社區，再查搜尋索引（舊社區、深連結）
  const pageId = page && (page.kind === "c" || page.kind === "p") ? page.id : null;
  const knownShard = pageId
    ? reg.current.byId.has(pageId)
      ? reg.current.list[reg.current.byId.get(pageId)!].shard
      : shardHints.current.get(pageId)
    : undefined;
  void hintTick;
  useEffect(() => {
    if (!pageId || knownShard !== undefined || !meta) return;
    loadSearch(meta)
      .then((list) => {
        const e = list.find((x) => x.id === pageId);
        shardHints.current.set(pageId, e ? e.shard : -1);
        setHintTick((n) => n + 1);
      })
      .catch(() => setToast("搜尋資料載入失敗，請確認網路"));
  }, [pageId, knownShard, meta]);

  const showEntityOnMap = useCallback((e: Entity) => {
    closePage();
    const cid = reg.current.byId.get(e.info.id);
    if (cid !== undefined) setScope({ kind: "community", cid });
    if (e.info.lat != null && e.info.lon != null) setFly({ center: [e.info.lon, e.info.lat], zoom: 16.5, key: Date.now() });
    setSheet("half");
  }, [closePage]);

  const toggleTrend = useCallback((e: Entity) => {
    setTrendPicks((ps) => {
      if (ps.some((p) => p.type === "e" && p.id === e.info.id)) return ps.filter((p) => !(p.type === "e" && p.id === e.info.id));
      const slot = freeSlot(ps);
      if (slot < 0) {
        setToast(`走勢最多 ${MAX_PICKS} 個，請先到走勢頁移除`);
        return ps;
      }
      setToast("已加入走勢（選單 → 行情走勢）");
      return [...ps, { type: "e", id: e.info.id, name: e.info.name, shard: e.info.shard, presale: e.info.presale, slot }];
    });
  }, []);
  const toggleCompare = useCallback((e: Entity) => {
    setCmpPicks((ps) => {
      if (ps.some((p) => p.id === e.info.id)) return ps.filter((p) => p.id !== e.info.id);
      if (ps.length >= MAX_COMPARE) {
        setToast(`比較最多 ${MAX_COMPARE} 個建案`);
        return ps;
      }
      setToast("已加入比較（選單 → 比較表）");
      return [...ps, { id: e.info.id, name: e.info.name, shard: e.info.shard }];
    });
  }, []);

  const openTrend = useCallback(() => {
    if (!trendPicks.length) {
      // 預設：全市＋畫面內成交最多的行政區
      const cnt = new Map<string, number>();
      for (const t of inView) cnt.set(t.district, (cnt.get(t.district) ?? 0) + 1);
      const top = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0];
      const name = meta?.districts.find((d) => d.code === top)?.name;
      setTrendPicks([{ type: "d", name: "桃園市", slot: 0 }, ...(name ? [{ type: "d" as const, name, slot: 1 }] : [])]);
    }
    openPage({ kind: "trend" });
  }, [trendPicks.length, inView, meta, openPage]);

  const showFavTx = useCallback((f: Fav) => {
    closePage();
    if (f.lat != null && f.lon != null) setFly({ center: [f.lon, f.lat], zoom: 17.5, key: Date.now() });
    const t = all.find((x) => x.id === f.id);
    if (t) setSelected(t.i);
  }, [closePage, all]);

  // ── 新成交提醒：收藏的社區／建案（比對搜尋索引的筆數）、收藏的範圍（比對近 12 月成交編號） ──
  const [entNow, setEntNow] = useState<Record<string, number>>({});
  const entFavCount = favs.favs.filter((f) => f.kind === "c" || f.kind === "p").length;
  useEffect(() => {
    if (!meta || !entFavCount) return;
    let alive = true;
    loadSearch(meta)
      .then((list) => {
        if (!alive) return;
        const byId = new Map(list.map((e) => [e.id, e.n]));
        const now: Record<string, number> = {};
        for (const f of favs.favs) {
          if (f.kind !== "c" && f.kind !== "p") continue;
          const n = byId.get(f.id);
          if (n == null) continue;
          now[f.key] = n;
          if (f.seenN == null) favs.update(f.key, { seenN: n }); // 第一次：當作都看過
        }
        setEntNow(now);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, entFavCount]);
  const areaIds = useCallback(
    (a: FavArea) => {
      if (!meta) return [];
      return all
        .filter((t) => t.part === "r" && t.lat != null && t.lon != null && !(t.fx & meta.defaultExclude) && inArea(a, t.lon, t.lat))
        .map((t) => t.id);
    },
    [all, meta],
  );
  useEffect(() => {
    if (!recentDone) return;
    for (const f of favs.favs) if (f.kind === "a" && f.area && !f.seenIds) favs.update(f.key, { seenIds: areaIds(f.area) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentDone, favs.favs.length]);
  const alerts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of favs.favs) {
      if ((f.kind === "c" || f.kind === "p") && f.seenN != null && entNow[f.key] > f.seenN) out[f.key] = entNow[f.key] - f.seenN;
      if (f.kind === "a" && f.area && f.seenIds && recentDone) {
        const seen = new Set(f.seenIds);
        const n = areaIds(f.area).filter((id) => !seen.has(id)).length;
        if (n) out[f.key] = n;
      }
    }
    return out;
  }, [favs.favs, entNow, areaIds, recentDone]);
  const totalNew = Object.values(alerts).reduce((a, b) => a + b, 0);
  // 開啟收藏的社區頁、建案頁就算看過
  useEffect(() => {
    if (!page || (page.kind !== "c" && page.kind !== "p")) return;
    const key = `${page.kind}:${page.id}`;
    const f = favs.favs.find((x) => x.key === key);
    if (f && entNow[key] != null && f.seenN !== entNow[key]) favs.update(key, { seenN: entNow[key] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, entNow]);
  const openFavArea = useCallback((f: Fav) => {
    if (!f.area) return;
    closePage();
    const a = f.area;
    if (a.type === "circle") {
      setScope({ kind: "circle", center: a.center, radius: a.radius, source: "press" });
      setRadius(a.radius);
      setSort("dist");
      setFly({ center: a.center, zoom: a.radius >= 1000 ? 14.5 : 15.5, key: Date.now() });
    } else {
      setScope({ kind: "polygon", points: a.points });
      setSort("date");
      const c = a.points.reduce((acc, q) => [acc[0] + q[0] / a.points.length, acc[1] + q[1] / a.points.length], [0, 0]) as LngLat;
      setFly({ center: c, zoom: 15, key: Date.now() });
    }
    setSheet("half");
    favs.update(f.key, { seenIds: areaIds(a) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closePage, areaIds]);
  const saveArea = useCallback(() => {
    let area: FavArea | null = null;
    let name = "";
    const d = today();
    const dd = `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6)}`;
    if (scope.kind === "circle") {
      area = { type: "circle", center: scope.center, radius: scope.radius };
      name = `${scope.source === "gps" ? "我附近" : "選定地點"} ${scope.radius >= 1000 ? scope.radius / 1000 + " km" : scope.radius + " m"}（${dd} 收藏）`;
    } else if (scope.kind === "polygon") {
      area = { type: "polygon", points: scope.points };
      name = `自訂範圍（${dd} 收藏）`;
    }
    if (!area) return;
    const c: LngLat = area.type === "circle" ? area.center : area.points[0];
    const key = `a:${Date.now()}`;
    favs.add({ key, kind: "a", id: key, name, district: "", lat: c[1], lon: c[0], area, seenIds: areaIds(area) });
    setToast("已收藏這個範圍：有新成交時選單會出現紅點");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, areaIds]);

  const medians = useMemo(() => (meta ? communityMedians(all, meta) : new Map<string, number>()), [all, meta]);

  const scopeLabel = (() => {
    const per = filters ? PERIOD_LABEL[filters.period] : "";
    if (scope.kind === "circle") return `${scope.source === "gps" ? "我附近" : "選定地點"} ${scope.radius >= 1000 ? scope.radius / 1000 + " km" : scope.radius + " m"} · ${per}`;
    if (scope.kind === "polygon") return `自訂範圍 · ${per}`;
    if (scope.kind === "community") return `${comms[scope.cid]?.name ?? "社區"} · ${per}`;
    return `目前地圖畫面 · ${per}`;
  })();

  // 比較表：目前範圍內，套用篩選但不限類別與屋齡
  const cmpBase = useMemo(() => {
    if (page?.kind !== "cmp" || !meta || !filters) return [];
    const f2: Filters = { ...filters, kinds: [0, 1], ageMin: null, ageMax: null };
    const ctx = makeCtx(f2, meta, latest);
    const [w, s, e, n] = view?.bounds ?? [0, 0, 0, 0];
    return all.filter((t) => {
      if (!pass(t, f2, ctx)) return false;
      if (scope.kind === "community") return t.cid === scope.cid;
      if (t.lat == null || t.lon == null) return false;
      if (scope.kind === "circle") return distance(scope.center, [t.lon, t.lat]) <= scope.radius;
      if (scope.kind === "polygon") return pointInPolygon([t.lon, t.lat], scope.points);
      return t.lon >= w && t.lon <= e && t.lat >= s && t.lat <= n;
    });
  }, [page, all, filters, meta, latest, scope, view]);

  const doExport = useCallback(() => {
    if (!meta) return;
    const n = isRent ? rSorted.length : sorted.length;
    if (isRent) exportRentCsv(rSorted, meta, comms, `租賃；${scopeLabel}；${n} 筆`);
    else exportCsv(sorted, meta, comms, `${scopeLabel}；${n} 筆`);
    setPanel("");
    setToast(`已匯出 ${n.toLocaleString("zh-TW")} 筆`);
  }, [meta, sorted, rSorted, isRent, comms, scopeLabel]);

  const needOldForPage = useCallback(() => setWantOld(true), []);
  const openSearchResult = useCallback((e: SearchEntry) => openEntity(e.id, e.shard), [openEntity]);

  // ── 畫面 ──
  if (error) {
    return (
      <div className="fatal">
        <h1>資料載入失敗</h1>
        <p>{error}</p>
        <p>{online ? "請稍後重新整理。" : "目前離線，且這台手機還沒有下載過資料。"}</p>
        <button className="primary" onClick={() => window.location.reload()}>重新整理</button>
      </div>
    );
  }

  const loading = !meta || loaded < (meta?.districts.length ?? 1);
  const comm = scope.kind === "community" ? comms[scope.cid] : null;
  const zoom = view?.zoom ?? initial.current.zoom;
  const levelHint = isRent
    ? zoom < ZOOM_COMM ? "六角格：每坪月租中位" : zoom < ZOOM_TX ? "泡泡：社區（件數＋每坪月租中位）" : "單筆租約（元/坪/月）"
    : zoom < ZOOM_COMM ? "六角格：中位單價" : zoom < ZOOM_TX ? "泡泡：社區（件數＋中位單價）" : "單筆成交（萬/坪）";
  const rentLoading = isRent && rentState !== "done";
  const listN = isRent ? rScoped.length : scoped.length;

  const header = (
    <div className="sheet-head" onPointerDown={(e) => (e.target as HTMLElement).closest("button") && e.stopPropagation()}>
      <div className="scope-row">
        {scope.kind === "view" && <h2>目前畫面</h2>}
        {scope.kind === "circle" && (
          <>
            <h2>{scope.source === "gps" ? "我附近" : "選定地點"}</h2>
            {RADII.map((r) => (
              <button key={r} className={`chip small ${scope.radius === r ? "on" : ""}`} onClick={() => setR(r)}>
                {r >= 1000 ? `${r / 1000} km` : `${r} m`}
              </button>
            ))}
          </>
        )}
        {scope.kind === "polygon" && <h2>自訂範圍</h2>}
        {comm && (
          <h2 className="comm-title">
            {comm.presale ? "建案" : "社區"}：{comm.name}
            <small>
              {comm.built ? ` · ${comm.built.slice(0, 4)} 年完工` : ""}
              {comm.floors ? ` · ${comm.floors} 樓` : ""}
            </small>
          </h2>
        )}
        {comm && (
          <button className="chip small on" onClick={() => openEntity(comm.id, comm.shard)}>
            {comm.presale ? "建案頁" : "社區頁"} ›
          </button>
        )}
        {(scope.kind === "circle" || scope.kind === "polygon") && (
          <button className="chip small" onClick={saveArea} aria-label="收藏這個範圍">☆ 收藏範圍</button>
        )}
        {scope.kind !== "view" && (
          <button className="icon-btn small" aria-label="清除範圍" onClick={() => { setScope({ kind: "view" }); setSort("date"); }}>
            ✕
          </button>
        )}
        {loading && meta && <span className="muted small">載入 {loaded}/{meta.districts.length} 區</span>}
        {!loading && oldState === "loading" && meta && (
          <span className="muted small">載入更早資料 {oldLoaded}/{meta.districts.length} 區</span>
        )}
        {rentLoading && meta?.rent && (
          <span className="muted small">{rentState === "error" ? "租賃載入失敗" : `載入租賃 ${rentLoaded}/${meta.rent.districts.length} 區`}</span>
        )}
      </div>
      {isRent && rSummary ? (
        <RentStats s={rSummary} yld={yld} nSale={saleForYield?.nUnit ?? 0} loading={rentLoading} />
      ) : (
        <StatsCard s={summary} loading={loading} />
      )}
    </div>
  );

  return (
    <div className={`app ${dark ? "dark" : ""}`}>
      <MapView
        initial={initial.current}
        txFC={txFC}
        commFC={commFC}
        hexFC={hexFC}
        breaks={breaks}
        basemap={basemap}
        village={village}
        dark={dark}
        scope={scope}
        drawing={drawing}
        myLocation={myLoc}
        selected={selected}
        fly={fly}
        onView={setView}
        onSelectTx={onSelectTx}
        onSelectCommunity={onSelectCommunity}
        onLongPress={onLongPress}
        onDrawTap={(p) => setDrawing((d) => (d ? [...d, p] : d))}
        liquefaction={layers.liq}
        floodFC={(layers.flood && floodData[layers.flood]) || EMPTY_FC}
        poiFC={poiFC}
      />

      <header className="topbar">
        <button className="filter-btn" onClick={() => setPanel("filter")} disabled={!filters}>
          篩選{filters && defaults && activeCount(filters, defaults) ? <span className="badge">{activeCount(filters, defaults)}</span> : null}
        </button>
        {filters && meta && (
          <div className="topchips" role="list">
            {meta.rent && (
              <div className="seg mode-seg" role="group" aria-label="買賣或租賃">
                <button className={!isRent ? "on" : ""} onClick={() => switchMode("sale")}>買賣</button>
                <button className={isRent ? "on" : ""} onClick={() => switchMode("rent")}>租賃</button>
              </div>
            )}
            {isRent ? (
              (["all", "whole", "suite"] as const).map((k) => (
                <button key={k} className={`chip small ${rentKind === k ? "on" : ""}`} onClick={() => setRentKind(k)}>
                  {{ all: "全部租約", whole: "整層住家", suite: "套房雅房" }[k]}
                </button>
              ))
            ) : (
              <button className="chip small on" onClick={() => setPanel("filter")}>
                {filters.kinds.length === 2 ? "買賣＋預售" : filters.kinds.includes(1) ? "預售屋" : filters.kinds.includes(0) ? "買賣" : "未選類別"}
              </button>
            )}
            <button className="chip small on" onClick={() => setPanel("filter")}>{PERIOD_LABEL[filters.period]}</button>
            <button className="chip small on" onClick={() => setPanel("filter")}>
              {filters.btypes.length === meta.defaultBtypes.length && filters.btypes.every((b) => meta.defaultBtypes.includes(b))
                ? "住宅類"
                : `${filters.btypes.length} 種型態`}
            </button>
            {filters.districts.length > 0 && (
              <button className="chip small on" onClick={() => setPanel("filter")}>{filters.districts.length} 區</button>
            )}
            <button className={`chip small ${filters.exSpecial ? "on" : ""}`} onClick={() => setFilters({ ...filters, exSpecial: !filters.exSpecial })}>
              {isRent ? (filters.exSpecial ? "已排除社宅包租代管等" : "含社宅包租代管") : filters.exSpecial ? "已排除特殊交易" : "含特殊交易"}
            </button>
          </div>
        )}
        <button className="icon-btn menu-btn" aria-label={totalNew ? `選單（收藏有 ${totalNew} 筆新成交）` : "選單"} aria-expanded={panel === "menu"} onClick={() => setPanel(panel === "menu" ? "" : "menu")} disabled={!meta}>
          ☰{totalNew > 0 && <span className="dot" />}
        </button>
      </header>

      {!online && <div className="offline">離線中：顯示上次載入的資料</div>}

      <div className="legend-wrap">
        <Legend breaks={breaks} mode={colorMode} onMode={setColorMode} unit={isRent ? "元/坪/月" : "萬/坪"} fmt={isRent ? fmtRu : fmtUnitShort} />
        <span className="level-hint">{levelHint}</span>
      </div>

      <div className="fab-col" style={{ bottom: sheet === "full" ? -200 : `calc(${sheet === "min" ? 132 : 46}${sheet === "min" ? "px" : "vh"} + 12px)` }}>
        <button className="fab" aria-label="圖層" onClick={() => setPanel(panel === "layer" ? "" : "layer")}>🗺️</button>
        <button className={`fab ${drawing ? "on" : ""}`} aria-label="畫範圍" onClick={() => (drawing ? setDrawing(null) : setDrawing([]))}>✏️</button>
        <button className="fab primary" aria-label="看屋模式：以我為圓心" onClick={locate}>📍</button>
      </div>

      {drawing && (
        <div className="drawbar">
          <span>點地圖加頂點（{drawing.length}）</span>
          <button onClick={() => setDrawing(drawing.slice(0, -1))} disabled={!drawing.length}>復原</button>
          <button onClick={() => setDrawing(null)}>取消</button>
          <button className="primary" onClick={finishDraw} disabled={drawing.length < 3}>完成</button>
        </div>
      )}

      {panel === "layer" && (
        <LayerMenu
          basemap={basemap} village={village} onBasemap={setBasemap} onVillage={setVillage}
          meta={meta} layers={layers} onLayers={setLayers} onClose={() => setPanel("")}
        />
      )}

      <BottomSheet state={sheet} onState={setSheet} header={header}>
        <div className="list-tools">
          <span className="muted small">
            {listN.toLocaleString("zh-TW")} 筆
            {scope.kind === "view" && zoom < ZOOM_COMM ? "（放大地圖看社區與單筆）" : ""}
          </span>
          <button className="chip small" onClick={doExport} disabled={!listN} aria-label="匯出目前列表為 CSV">⬇ CSV</button>
          <div className="seg">
            <button className={sort === "date" ? "on" : ""} onClick={() => setSort("date")}>最新</button>
            {scope.kind === "circle" && <button className={sort === "dist" ? "on" : ""} onClick={() => setSort("dist")}>最近</button>}
            <button className={sort === "up" ? "on" : ""} onClick={() => setSort("up")}>{isRent ? "租金高" : "單價高"}</button>
          </div>
        </div>
        {(loading || rentLoading) && listN === 0 && (
          <div className="skeleton-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton card" />
            ))}
          </div>
        )}
        {!loading && !rentLoading && listN === 0 && (
          <p className="empty">
            {isRent ? (scope.kind === "view" ? "畫面內沒有符合條件的租約。" : "範圍內沒有符合條件的租約。")
              : scope.kind === "view" ? "畫面內沒有符合條件的成交。可縮小地圖或放寬篩選。" : "範圍內沒有符合條件的成交。"}
            <br />
            長按地圖任一點可設為圓心。
          </p>
        )}
        {meta && isRent &&
          rSorted.slice(0, limit).map((r) => (
            <RentCard
              key={r.i}
              r={r}
              meta={meta}
              community={r.cid >= 0 && scope.kind !== "community" ? comms[r.cid] : undefined}
              dist={rDist?.get(r.i)}
              breaks={breaks}
              selected={selected === r.i}
              onSelect={onRentSelect}
              onCommunity={onSelectCommunity}
            />
          ))}
        {meta && !isRent &&
          sorted.slice(0, limit).map((t) => (
            <TxCard
              key={t.i}
              t={t}
              meta={meta}
              community={t.cid >= 0 && scope.kind !== "community" ? comms[t.cid] : undefined}
              dist={dist?.get(t.i)}
              breaks={breaks}
              selected={selected === t.i}
              onSelect={onCardSelect}
              onCommunity={onSelectCommunity}
              dev={deviation(t, medians)}
              starred={favs.isFav(`t:${t.id}`)}
              onStar={(x) => favs.toggle(txFav(x, x.cid >= 0 ? comms[x.cid]?.name : undefined))}
            />
          ))}
        {listN > limit && (
          <button className="more" onClick={() => setLimit(limit + PAGE)}>
            再顯示 {Math.min(PAGE, listN - limit)} 筆（共 {listN.toLocaleString("zh-TW")}）
          </button>
        )}
        {meta && (
          <footer className="sheet-foot">
            資料：內政部實價登錄（買賣登記至 {fmtRoc(meta.latest?.saleTo)}、預售至 {fmtRoc(meta.latest?.presaleTo)}
            {isRent && meta.rent?.range ? `、租賃至 ${meta.rent.range.to.replaceAll("-", "/")}` : ""}）・
            更新 {meta.generated.slice(0, 10)}・
            <button className="link" onClick={() => setPanel("about")}>來源與計算方式</button>
          </footer>
        )}
      </BottomSheet>

      {panel === "filter" && meta && filters && defaults && (
        <FilterDrawer meta={meta} value={filters} defaults={defaults} count={isRent ? rentFiltered.length : filtered.length} rentMode={isRent} onChange={setFilters} onClose={() => setPanel("")} />
      )}
      {panel === "about" && meta && <About meta={meta} onClose={() => setPanel("")} />}
      {panel === "menu" && meta && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => openPage({ kind: "search" })}>🔍 搜尋建案／社區</button>
          <button role="menuitem" onClick={() => openPage({ kind: "val" })}>🧮 估價助手</button>
          <button role="menuitem" onClick={openTrend}>📈 行情走勢</button>
          <button role="menuitem" onClick={() => openPage({ kind: "cmp" })}>⚖️ 比較表{cmpPicks.length ? `（${cmpPicks.length}）` : ""}</button>
          <button role="menuitem" onClick={() => openPage({ kind: "fav" })}>
            ⭐ 收藏與看屋筆記{favs.favs.length ? `（${favs.favs.length}）` : ""}
            {totalNew > 0 && <span className="new-badge">{totalNew} 筆新成交</span>}
          </button>
          <button role="menuitem" onClick={doExport} disabled={!listN}>⬇ 匯出目前列表（CSV）</button>
          <button role="menuitem" onClick={() => setPanel("about")}>ⓘ 資料說明</button>
        </div>
      )}
      {meta && page && (page.kind === "c" || page.kind === "p") && (
        <EntityPage
          key={page.id}
          meta={meta}
          reg={reg.current}
          id={page.id}
          shard={knownShard}
          mode={dark ? "dark" : "light"}
          breaks={breaks}
          favs={favs}
          onBack={closePage}
          onOpenEntity={(id) => openEntity(id)}
          onShowOnMap={showEntityOnMap}
          onAddTrend={toggleTrend}
          onAddCompare={toggleCompare}
          inTrend={trendPicks.some((t) => t.type === "e" && t.id === page.id)}
          inCompare={cmpPicks.some((c) => c.id === page.id)}
        />
      )}
      {meta && page?.kind === "trend" && (
        <TrendPage
          meta={meta}
          reg={reg.current}
          mode={dark ? "dark" : "light"}
          picks={trendPicks}
          setPicks={setTrendPicks}
          onBack={closePage}
          onOpenEntity={(id) => openEntity(id)}
        />
      )}
      {meta && page?.kind === "cmp" && (
        <ComparePage
          meta={meta}
          reg={reg.current}
          base={cmpBase}
          scopeLabel={scopeLabel}
          picks={cmpPicks}
          setPicks={setCmpPicks}
          onBack={closePage}
          onOpenEntity={(id) => openEntity(id)}
        />
      )}
      {meta && page?.kind === "fav" && (
        <FavoritesPage meta={meta} favs={favs} alerts={alerts} onBack={closePage} onOpenEntity={openEntity} onShowTx={showFavTx} onOpenArea={openFavArea} />
      )}
      {meta && page?.kind === "search" && <SearchPage meta={meta} onBack={closePage} onOpen={openSearchResult} />}
      {meta && page?.kind === "val" && (
        <ValuationPage
          meta={meta}
          all={all}
          comms={comms}
          center={scope.kind === "circle" ? scope.center : (view?.center ?? initial.current.center)}
          oldReady={oldDone}
          onNeedOld={needOldForPage}
          onBack={closePage}
          onToast={setToast}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
