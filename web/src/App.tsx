import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { ZOOM_COMM, ZOOM_TX, type Basemap, type FlyTarget, type ViewState } from "./map/MapView";
import BottomSheet, { type SheetState } from "./components/BottomSheet";
import FilterDrawer from "./components/FilterDrawer";
import StatsCard from "./components/StatsCard";
import TxCard from "./components/TxCard";
import { About, LayerMenu, Legend } from "./components/Overlays";
import { loadMeta, loadPart, newRegistry } from "./data";
import {
  PERIOD_LABEL, activeCount, defaultFilters, filtersFromParams, filtersToParams, makeCtx, pass, type Filters,
} from "./filters";
import { fmtRoc, fmtUnitShort } from "./format";
import { distance, hexCenter, hexKey, hexPolygon, hexSize, pointInPolygon, spiralOffset } from "./geo";
import { FIXED_BREAKS, median, quantileBreaks, summarize } from "./stats";
import type { Community, LngLat, Meta, Scope, Tx } from "./types";

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
  const [panel, setPanel] = useState<"" | "filter" | "layer" | "about">("");
  const [online, setOnline] = useState(navigator.onLine);
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [limit, setLimit] = useState(PAGE);
  const [sort, setSort] = useState<Sort>("date");
  const [toast, setToast] = useState<string | null>(null);
  const pendingTx = useRef<string | null>(hash.current.get("t"));
  const pendingComm = useRef<string | null>(hash.current.get("cm"));

  useEffect(() => save("basemap", basemap), [basemap]);
  useEffect(() => save("village", village), [village]);
  useEffect(() => save("colorMode", colorMode), [colorMode]);
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

  // ── 篩選 ──
  const filtered = useMemo(() => {
    if (!meta || !filters) return [];
    const ctx = makeCtx(filters, meta, latest);
    return all.filter((t) => pass(t, filters, ctx));
  }, [all, filters, meta, latest]);

  const inView = useMemo(() => {
    if (!view) return [];
    const [w, s, e, n] = view.bounds;
    return filtered.filter((t) => t.lat != null && t.lon != null && t.lon >= w && t.lon <= e && t.lat >= s && t.lat <= n);
  }, [filtered, view]);

  const breaks = useMemo(() => {
    if (colorMode === "f") return FIXED_BREAKS;
    return quantileBreaks(inView.map((t) => t.up).filter((v): v is number => v != null));
  }, [inView, colorMode]);

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
  const dist = useMemo(() => {
    if (scope.kind !== "circle") return null;
    const m = new Map<number, number>();
    for (const t of filtered) if (t.lat != null && t.lon != null) m.set(t.i, distance(scope.center, [t.lon, t.lat]));
    return m;
  }, [filtered, scope]);

  const scoped = useMemo(() => {
    switch (scope.kind) {
      case "view":
        return inView;
      case "circle":
        return filtered.filter((t) => (dist?.get(t.i) ?? Infinity) <= scope.radius);
      case "polygon":
        return filtered.filter((t) => t.lat != null && t.lon != null && pointInPolygon([t.lon, t.lat], scope.points));
      case "community":
        return filtered.filter((t) => t.cid === scope.cid);
      default:
        return inView;
    }
  }, [scope, filtered, inView, dist]);

  const summary = useMemo(() => summarize(scoped), [scoped]);

  const sorted = useMemo(() => {
    const arr = [...scoped];
    if (sort === "dist" && dist) arr.sort((a, b) => (dist.get(a.i) ?? 1e9) - (dist.get(b.i) ?? 1e9));
    else if (sort === "up") arr.sort((a, b) => (b.up ?? -1) - (a.up ?? -1));
    else arr.sort((a, b) => b.date - a.date);
    return arr;
  }, [scoped, sort, dist]);

  useEffect(() => setLimit(PAGE), [scope, filters, sort]);

  // ── 地圖圖層資料 ──
  const txFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const byPt = new Map<string, number>();
    const pts = filtered.filter((t) => t.lat != null && t.lon != null).sort((a, b) => b.date - a.date);
    return {
      type: "FeatureCollection",
      features: pts.map((t, o) => {
        const k = `${t.lat},${t.lon}`;
        const n = byPt.get(k) ?? 0;
        byPt.set(k, n + 1);
        return {
          type: "Feature",
          properties: { i: t.i, up: t.up, l: fmtUnitShort(t.up), k: t.kind, o },
          geometry: { type: "Point", coordinates: spiralOffset([t.lon!, t.lat!], n) },
        };
      }),
    };
  }, [filtered]);

  const commFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const groups = new Map<number, number[]>();
    for (const t of filtered) {
      if (t.cid < 0 || t.up == null) continue;
      const g = groups.get(t.cid);
      if (g) g.push(t.up);
      else groups.set(t.cid, [t.up]);
    }
    const features: GeoJSON.Feature[] = [];
    for (const [cid, ups] of groups) {
      const c = comms[cid];
      if (!c || c.lat == null || c.lon == null) continue;
      const m = median(ups);
      features.push({
        type: "Feature",
        properties: { c: cid, n: ups.length, m, l: fmtUnitShort(m), p: c.presale ? 1 : 0 },
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      });
    }
    return { type: "FeatureCollection", features };
  }, [filtered, comms]);

  const zoomBucket = view ? Math.min(12, Math.floor(view.zoom)) : 12;
  const hexFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const size = hexSize(zoomBucket);
    const groups = new Map<string, number[]>();
    for (const t of filtered) {
      if (t.lat == null || t.lon == null || t.up == null) continue;
      const k = hexKey(t.lon, t.lat, size);
      const g = groups.get(k);
      if (g) g.push(t.up);
      else groups.set(k, [t.up]);
    }
    const features: GeoJSON.Feature[] = [];
    for (const [k, ups] of groups) {
      const m = median(ups);
      features.push({
        type: "Feature",
        properties: { m, n: ups.length, l: ups.length >= 3 ? fmtUnitShort(m) : "", key: k },
        geometry: { type: "Polygon", coordinates: [hexPolygon(k, size)] },
      });
    }
    void hexCenter;
    return { type: "FeatureCollection", features };
  }, [filtered, zoomBucket]);

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
      const st = selected != null ? all[selected] : null;
      if (st) p.set("t", st.id);
      window.history.replaceState(null, "", `#${p.toString()}`);
    }, 400);
    return () => window.clearTimeout(t);
  }, [filters, defaults, view, scope, selected, comms, all]);

  // ── 互動 ──
  const scrollToCard = useCallback((i: number) => {
    window.setTimeout(() => document.getElementById(`tx-${i}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
  }, []);

  const onSelectTx = useCallback(
    (i: number) => {
      setSelected(i);
      setSheet((s) => (s === "min" ? "half" : s));
      const pos = sorted.findIndex((t) => t.i === i);
      if (pos >= limit) setLimit(pos + 10);
      scrollToCard(i);
    },
    [sorted, limit, scrollToCard],
  );

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
  const levelHint = zoom < ZOOM_COMM ? "六角格：中位單價" : zoom < ZOOM_TX ? "泡泡：社區（件數＋中位單價）" : "單筆成交（萬/坪）";

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
        {scope.kind !== "view" && (
          <button className="icon-btn small" aria-label="清除範圍" onClick={() => { setScope({ kind: "view" }); setSort("date"); }}>
            ✕
          </button>
        )}
        {loading && meta && <span className="muted small">載入 {loaded}/{meta.districts.length} 區</span>}
        {!loading && oldState === "loading" && meta && (
          <span className="muted small">載入更早資料 {oldLoaded}/{meta.districts.length} 區</span>
        )}
      </div>
      <StatsCard s={summary} loading={loading} />
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
      />

      <header className="topbar">
        <button className="filter-btn" onClick={() => setPanel("filter")} disabled={!filters}>
          篩選{filters && defaults && activeCount(filters, defaults) ? <span className="badge">{activeCount(filters, defaults)}</span> : null}
        </button>
        {filters && meta && (
          <div className="topchips" role="list">
            <button className="chip small on" onClick={() => setPanel("filter")}>
              {filters.kinds.length === 2 ? "買賣＋預售" : filters.kinds.includes(1) ? "預售屋" : filters.kinds.includes(0) ? "買賣" : "未選類別"}
            </button>
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
              {filters.exSpecial ? "已排除特殊交易" : "含特殊交易"}
            </button>
          </div>
        )}
        <button className="icon-btn" aria-label="資料說明" onClick={() => setPanel("about")} disabled={!meta}>ⓘ</button>
      </header>

      {!online && <div className="offline">離線中：顯示上次載入的資料</div>}

      <div className="legend-wrap">
        <Legend breaks={breaks} mode={colorMode} onMode={setColorMode} />
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
        <LayerMenu basemap={basemap} village={village} onBasemap={setBasemap} onVillage={setVillage} onClose={() => setPanel("")} />
      )}

      <BottomSheet state={sheet} onState={setSheet} header={header}>
        <div className="list-tools">
          <span className="muted small">
            {scoped.length.toLocaleString("zh-TW")} 筆
            {scope.kind === "view" && zoom < ZOOM_COMM ? "（放大地圖看社區與單筆）" : ""}
          </span>
          <div className="seg">
            <button className={sort === "date" ? "on" : ""} onClick={() => setSort("date")}>最新</button>
            {scope.kind === "circle" && <button className={sort === "dist" ? "on" : ""} onClick={() => setSort("dist")}>最近</button>}
            <button className={sort === "up" ? "on" : ""} onClick={() => setSort("up")}>單價高</button>
          </div>
        </div>
        {loading && sorted.length === 0 && (
          <div className="skeleton-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton card" />
            ))}
          </div>
        )}
        {!loading && sorted.length === 0 && (
          <p className="empty">
            {scope.kind === "view" ? "畫面內沒有符合條件的成交。可縮小地圖或放寬篩選。" : "範圍內沒有符合條件的成交。"}
            <br />
            長按地圖任一點可設為圓心。
          </p>
        )}
        {meta &&
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
            />
          ))}
        {sorted.length > limit && (
          <button className="more" onClick={() => setLimit(limit + PAGE)}>
            再顯示 {Math.min(PAGE, sorted.length - limit)} 筆（共 {sorted.length.toLocaleString("zh-TW")}）
          </button>
        )}
        {meta && (
          <footer className="sheet-foot">
            資料：內政部實價登錄（買賣登記至 {fmtRoc(meta.latest?.saleTo)}、預售至 {fmtRoc(meta.latest?.presaleTo)}）・
            更新 {meta.generated.slice(0, 10)}・
            <button className="link" onClick={() => setPanel("about")}>來源與計算方式</button>
          </footer>
        )}
      </BottomSheet>

      {panel === "filter" && meta && filters && defaults && (
        <FilterDrawer meta={meta} value={filters} defaults={defaults} count={filtered.length} onChange={setFilters} onClose={() => setPanel("")} />
      )}
      {panel === "about" && meta && <About meta={meta} onClose={() => setPanel("")} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
