/**
 * 輕量 SVG 圖表（不用外部套件）。規格依資料視覺化參考：細線 2px、點 ≥ 8px 加 2px 底色外圈、
 * 柱寬 ≤ 24px 且頂端 4px 圓角、格線為一像素實線、≥ 2 個系列一定有圖例、手指點附近即顯示數值，
 * 每張圖都可切換成表格（數值不只藏在提示框裡）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// ── 共用 ──

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(240, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** 好讀的刻度：1、2、5 × 10^n */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const fmtTick = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("zh-TW") : String(Math.round(v * 10) / 10));

export interface LegendItem {
  label: string;
  color: string;
  shape?: "dot" | "line" | "rect";
}

/** 圖框：標題、圖例、圖／表切換 */
export function ChartFrame({ title, sub, legend, table, children }: {
  title: string;
  sub?: string;
  legend?: LegendItem[];
  table?: { head: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <div>
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </div>
        {table && (
          <button className="chip small" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
            {asTable ? "看圖" : "表格"}
          </button>
        )}
      </figcaption>
      {legend && legend.length > 0 && !asTable && (
        <div className="chart-legend">
          {legend.map((l) => (
            <span key={l.label} className="chart-legend-item">
              <i className={`key ${l.shape ?? "dot"}`} style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {asTable && table ? (
        <div className="chart-table">
          <table>
            <thead>
              <tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </figure>
  );
}

interface Tip {
  x: number;
  y: number;
  lines: { text: string; color?: string; strong?: boolean }[];
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 12, 4), width - 170);
  return (
    <div className="chart-tip" style={{ left, top: Math.max(tip.y - 10, 0) }} role="status">
      {tip.lines.map((l, i) => (
        <div key={i} className={l.strong ? "strong" : ""}>
          {l.color && <i className="key line" style={{ background: l.color }} />}
          {l.text}
        </div>
      ))}
    </div>
  );
}

const PAD = { l: 40, r: 16, t: 20, b: 26 };

/** 期別刻度（季「2024Q1」或月「2024/01」）：跨多年時只在年初標年份，每隔幾年標一次；不到兩年就每隔幾期標一次 */
function periodTicks(xs: string[], w: number): { i: number; label: string }[] {
  const starts = xs.map((q, i) => ({ q, i })).filter(({ q }) => q.endsWith("Q1") || q.endsWith("/01"));
  if (starts.length >= 2) {
    const stepY = Math.max(1, Math.ceil(starts.length / Math.max(2, Math.floor((w - 60) / 44))));
    return starts.filter(({ q }) => Number(q.slice(0, 4)) % stepY === 0).map(({ q, i }) => ({ i, label: q.slice(0, 4) }));
  }
  const every = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor((w - 60) / 56))));
  return xs.map((q, i) => ({ i, label: q })).filter(({ i }) => i % every === 0);
}

// ── 散布圖：成交日期 × 單價（點色＝樓層），可加中位數參考線與 ±20% 帶 ──

export interface ScatterPoint {
  x: number; // 時間（毫秒）或數值
  y: number;
  color: string;
  lines: string[]; // 提示框內容（第一行為數值）
  id: string;
}

/** 時間軸刻度：跨 2 年以上標年份，較短標「年/月」 */
function timeTicks(x0: number, x1: number, w: number): { v: number; label: string }[] {
  const room = Math.max(2, Math.floor((w - 60) / 56));
  const a = new Date(x0);
  const b = new Date(x1);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
  const out: { v: number; label: string }[] = [];
  if (months < 24) {
    const step = [1, 2, 3, 6, 12].find((s) => months / s <= room) ?? 12;
    for (let m = a.getFullYear() * 12 + a.getMonth(); ; m++) {
      const v = new Date(Math.floor(m / 12), m % 12, 1).getTime();
      if (v > x1) break;
      if (v >= x0 && (m % 12) % step === 0) out.push({ v, label: `${Math.floor(m / 12)}/${String((m % 12) + 1).padStart(2, "0")}` });
    }
  } else {
    const ya = a.getFullYear();
    const yb = b.getFullYear();
    const stepY = Math.max(1, Math.ceil((yb - ya + 1) / room));
    for (let y = ya; y <= yb + 1; y += stepY) {
      const v = new Date(y, 0, 1).getTime();
      if (v >= x0 && v <= x1) out.push({ v, label: String(y) });
    }
  }
  return out.length ? out : [{ v: (x0 + x1) / 2, label: `${a.getFullYear()}/${String(a.getMonth() + 1).padStart(2, "0")}` }];
}

/** 整數刻度（樓層）：間隔 1、2、5、10… */
function intTicks(x0: number, x1: number, count: number): number[] {
  const raw = (x1 - x0) / Math.max(1, count);
  const step = [1, 2, 5, 10, 20, 50].find((s) => s >= raw) ?? Math.ceil(raw);
  const out: number[] = [];
  for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) out.push(v);
  return out;
}

export function ScatterChart({ points, height = 220, xKind = "time", reference, onPick, yTitle, fit }: {
  points: ScatterPoint[];
  height?: number;
  xKind?: "time" | "floor" | "number";
  reference?: { mid: number; band: number; label: string }; // 中位數與 ±band（比例）
  onPick?: (id: string) => void;
  yTitle?: string;
  fit?: { slope: number; intercept: number; color: string }; // 迴歸線（樓層價差）
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const geo = useMemo(() => {
    if (!points.length) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (reference) {
      y0 = Math.min(y0, reference.mid * (1 - reference.band));
      y1 = Math.max(y1, reference.mid * (1 + reference.band));
    }
    const yt = niceTicks(y0, y1, 4);
    const ymin = Math.min(yt[0] ?? y0, y0);
    const ymax = Math.max(yt[yt.length - 1] ?? y1, y1);
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    if (x0 === x1) {
      x0 -= xKind === "time" ? 86400000 * 30 : 1;
      x1 += xKind === "time" ? 86400000 * 30 : 1;
    }
    // 兩端留一點空間，點不貼邊
    const padX = xKind === "floor" ? 0.5 : (x1 - x0) * 0.03;
    x0 -= padX;
    x1 += padX;
    const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (w - PAD.l - PAD.r);
    const sy = (y: number) => height - PAD.b - ((y - ymin) / (ymax - ymin || 1)) * (height - PAD.t - PAD.b);
    const room = Math.max(3, Math.floor((w - 60) / 48));
    let xt: { v: number; label: string }[];
    if (xKind === "time") xt = timeTicks(x0, x1, w);
    else if (xKind === "floor") xt = intTicks(x0, x1, Math.max(3, Math.floor((w - 60) / 36))).map((v) => ({ v, label: `${v}F` }));
    else xt = niceTicks(x0, x1, room).map((v) => ({ v, label: String(v) }));
    return { sx, sy, yt, xt, ymin, ymax, x0, x1 };
  }, [points, w, height, xKind, reference]);

  if (!geo) return <div ref={ref} className="chart-empty">沒有資料</div>;
  const { sx, sy, yt, xt, x0, x1 } = geo;

  const nearest = (px: number, py: number) => {
    let best: ScatterPoint | null = null;
    let bd = 24 * 24; // 手指點到 24px 內就算
    for (const p of points) {
      const d = (sx(p.x) - px) ** 2 + (sy(p.y) - py) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.target as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left + PAD.l;
    const py = e.clientY - r.top + PAD.t;
    const p = nearest(px, py);
    setTip(p ? { x: sx(p.x), y: sy(p.y), lines: p.lines.map((t, i) => ({ text: t, strong: i === 0 })) } : null);
  };
  const onUp = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.target as SVGRectElement).getBoundingClientRect();
    const p = nearest(e.clientX - r.left + PAD.l, e.clientY - r.top + PAD.t);
    if (p && onPick) onPick(p.id);
  };

  return (
    <div ref={ref} className="chart-box">
      <svg width={w} height={height} role="img" aria-label={yTitle ?? "散布圖"}>
        {yt.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={sy(v)} y2={sy(v)} className="grid" />
            <text x={PAD.l - 6} y={sy(v) + 4} className="tick" textAnchor="end">{fmtTick(v)}</text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={t.v} x={sx(t.v)} y={height - 8} className="tick" textAnchor="middle">{t.label}</text>
        ))}
        <line x1={PAD.l} x2={w - PAD.r} y1={height - PAD.b} y2={height - PAD.b} className="axis" />
        {reference && (
          <g>
            <rect
              x={PAD.l}
              width={w - PAD.l - PAD.r}
              y={sy(reference.mid * (1 + reference.band))}
              height={Math.max(0, sy(reference.mid * (1 - reference.band)) - sy(reference.mid * (1 + reference.band)))}
              className="ref-band"
            />
            <line x1={PAD.l} x2={w - PAD.r} y1={sy(reference.mid)} y2={sy(reference.mid)} className="ref-line" />
          </g>
        )}
        {fit && (
          <line
            x1={sx(x0)} y1={sy(fit.intercept + fit.slope * x0)} x2={sx(x1)} y2={sy(fit.intercept + fit.slope * x1)}
            stroke={fit.color} className="fit"
          />
        )}
        {points.map((p) => (
          <circle key={p.id} cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={p.color} className="dot" />
        ))}
        {/* 參考線文字畫在點的上面（有底色描邊），不被點蓋住 */}
        {reference && (
          <text x={PAD.l + 4} y={sy(reference.mid) - 5} className="ref-label">{reference.label}</text>
        )}
        {tip && <circle cx={tip.x} cy={tip.y} r={7} className="dot-hover" />}
        <rect
          x={PAD.l}
          y={PAD.t}
          width={w - PAD.l - PAD.r}
          height={height - PAD.t - PAD.b}
          className="hit"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setTip(null)}
        />
      </svg>
      {yTitle && <span className="y-title">{yTitle}</span>}
      <Tooltip tip={tip} width={w} />
    </div>
  );
}

// ── 帶狀走勢圖：中位數線＋P25–P75 帶，最多 4 個系列；十字線對齊最近的期 ──

export interface BandSeries {
  name: string;
  color: string;
  values: Map<string, { lo: number; mid: number; hi: number; n: number }>; // 期 → 數值
}

/** 各系列線尾的名稱位置：依高度排序，間距不足 12px 就往下推 */
function endLabels(series: BandSeries[], xs: string[], sx: (i: number) => number, sy: (v: number) => number) {
  const out: { name: string; color: string; x: number; y: number; ty: number }[] = [];
  for (const s of series) {
    const last = [...xs.keys()].reverse().find((i) => s.values.get(xs[i]));
    if (last === undefined) continue;
    const y = sy(s.values.get(xs[last])!.mid);
    out.push({ name: s.name, color: s.color, x: sx(last), y, ty: y });
  }
  out.sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++) out[i].ty = Math.max(out[i].ty, out[i - 1].ty + 12);
  return out;
}

export function BandChart({ series, xs, height = 240, yTitle, fmt }: {
  series: BandSeries[];
  xs: string[]; // 期（依時間排序）
  height?: number;
  yTitle?: string;
  fmt: (v: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => {
    const all: number[] = [];
    series.forEach((s) => s.values.forEach((v) => all.push(v.lo, v.hi)));
    if (!all.length || !xs.length) return null;
    const yt = niceTicks(Math.min(...all), Math.max(...all), 4);
    const ymin = Math.min(yt[0], ...all);
    const ymax = Math.max(yt[yt.length - 1], ...all);
    const labelRoom = series.length > 1 ? 54 : PAD.r;
    const sx = (i: number) => PAD.l + (xs.length === 1 ? 0.5 : i / (xs.length - 1)) * (w - PAD.l - labelRoom);
    const sy = (y: number) => height - PAD.b - ((y - ymin) / (ymax - ymin || 1)) * (height - PAD.t - PAD.b);
    return { yt, sx, sy, labelRoom };
  }, [series, xs, w, height]);
  if (!geo) return <div ref={ref} className="chart-empty">沒有資料</div>;
  const { yt, sx, sy, labelRoom } = geo;
  const ticks = periodTicks(xs, w - labelRoom + PAD.r);

  const path = (s: BandSeries, key: "lo" | "mid" | "hi") => {
    let d = "";
    let pen = false;
    xs.forEach((q, i) => {
      const v = s.values.get(q);
      if (!v) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v[key]).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (s: BandSeries) => {
    // 連續段各畫一塊帶狀
    const segs: number[][] = [];
    let cur: number[] = [];
    xs.forEach((q, i) => {
      if (s.values.get(q)) cur.push(i);
      else if (cur.length) {
        segs.push(cur);
        cur = [];
      }
    });
    if (cur.length) segs.push(cur);
    return segs
      .map((seg) => {
        const top = seg.map((i) => `${sx(i).toFixed(1)},${sy(s.values.get(xs[i])!.hi).toFixed(1)}`);
        const bot = [...seg].reverse().map((i) => `${sx(i).toFixed(1)},${sy(s.values.get(xs[i])!.lo).toFixed(1)}`);
        return `M${top.join("L")}L${bot.join("L")}Z`;
      })
      .join("");
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.target as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left + PAD.l;
    let best = 0;
    let bd = Infinity;
    xs.forEach((_, i) => {
      const d = Math.abs(sx(i) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };
  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: sx(hover),
          y: PAD.t,
          lines: [
            { text: xs[hover], strong: true },
            ...series.map((s) => {
              const v = s.values.get(xs[hover]);
              return { text: v ? `${fmt(v.mid)}（${fmt(v.lo)}–${fmt(v.hi)}）· ${v.n} 件 · ${s.name}` : `— · ${s.name}`, color: s.color };
            }),
          ],
        };

  return (
    <div ref={ref} className="chart-box">
      <svg width={w} height={height} role="img" aria-label={yTitle ?? "走勢圖"}>
        {yt.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - labelRoom} y1={sy(v)} y2={sy(v)} className="grid" />
            <text x={PAD.l - 6} y={sy(v) + 4} className="tick" textAnchor="end">{fmtTick(v)}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t.i} x={sx(t.i)} y={height - 8} className="tick" textAnchor="middle">{t.label}</text>
        ))}
        <line x1={PAD.l} x2={w - labelRoom} y1={height - PAD.b} y2={height - PAD.b} className="axis" />
        {series.map((s) => (
          <path key={`a-${s.name}`} d={area(s)} fill={s.color} className="band" />
        ))}
        {series.map((s) => (
          <path key={`l-${s.name}`} d={path(s, "mid")} stroke={s.color} className="line" />
        ))}
        {/* 前後兩期都沒資料的孤立點：線畫不出來，改畫小圓點 */}
        {series.map((s) =>
          xs.map((q, i) => {
            const v = s.values.get(q);
            if (!v || s.values.get(xs[i - 1]) || s.values.get(xs[i + 1])) return null;
            return <circle key={`p-${s.name}-${q}`} cx={sx(i)} cy={sy(v.mid)} r={3} fill={s.color} />;
          }),
        )}
        {series.length > 1 &&
          endLabels(series, xs, sx, sy).map((e) => (
            // 線尾直接標名稱（≤ 4 條；太近時上下錯開）
            <g key={`e-${e.name}`}>
              <circle cx={e.x} cy={e.y} r={4} fill={e.color} className="dot" />
              <text x={e.x + 7} y={e.ty + 4} className="end-label">{e.name.slice(0, 5)}</text>
            </g>
          ))}
        {hover !== null && <line x1={sx(hover)} x2={sx(hover)} y1={PAD.t} y2={height - PAD.b} className="crosshair" />}
        <rect
          x={PAD.l}
          y={PAD.t}
          width={w - PAD.l - labelRoom}
          height={height - PAD.t - PAD.b}
          className="hit"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {yTitle && <span className="y-title">{yTitle}</span>}
      <Tooltip tip={tip} width={w} />
    </div>
  );
}

// ── 柱狀圖：單一系列（成交量、每月成交戶數） ──

export function BarChart({ xs, values, color, height = 150, yTitle, labelEvery }: {
  xs: string[];
  values: number[];
  color: string;
  height?: number;
  yTitle?: string;
  labelEvery?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!xs.length) return <div ref={ref} className="chart-empty">沒有資料</div>;
  const max = Math.max(1, ...values);
  const yt = niceTicks(0, max, 3);
  const ymax = Math.max(max, yt[yt.length - 1] ?? max);
  const inner = w - PAD.l - PAD.r;
  const slot = inner / xs.length;
  const bw = Math.min(24, Math.max(1, slot - 2)); // 柱寬 ≤ 24px，相鄰柱留 2px 底色間隙
  const sy = (y: number) => height - PAD.b - (y / ymax) * (height - PAD.t - PAD.b);
  const ticks = labelEvery ? xs.map((x, i) => ({ i, label: x })).filter(({ i }) => i % labelEvery === 0) : periodTicks(xs, w);
  const peak = values.indexOf(max);
  const bar = (i: number) => {
    const x = PAD.l + i * slot + (slot - bw) / 2;
    const y = sy(values[i]);
    const h = height - PAD.b - y;
    if (h <= 0) return "";
    const r = Math.min(4, bw / 2, h);
    // 頂端圓角、底部方角
    return `M${x},${height - PAD.b}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${height - PAD.b}Z`;
  };
  return (
    <div ref={ref} className="chart-box">
      <svg width={w} height={height} role="img" aria-label={yTitle ?? "柱狀圖"}>
        {yt.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={sy(v)} y2={sy(v)} className="grid" />
            <text x={PAD.l - 6} y={sy(v) + 4} className="tick" textAnchor="end">{fmtTick(v)}</text>
          </g>
        ))}
        {values.map((_, i) => (
          <path key={i} d={bar(i)} fill={color} className={hover === i ? "bar on" : "bar"} />
        ))}
        {values[peak] > 0 && (
          <text x={PAD.l + peak * slot + slot / 2} y={sy(values[peak]) - 4} className="end-label" textAnchor="middle">
            {values[peak]}
          </text>
        )}
        {ticks.map((t) => (
          <text key={t.i} x={PAD.l + t.i * slot + slot / 2} y={height - 8} className="tick" textAnchor="middle">{t.label}</text>
        ))}
        <line x1={PAD.l} x2={w - PAD.r} y1={height - PAD.b} y2={height - PAD.b} className="axis" />
        <rect
          x={PAD.l}
          y={PAD.t}
          width={inner}
          height={height - PAD.t - PAD.b}
          className="hit"
          onPointerMove={(e) => {
            const r = (e.target as SVGRectElement).getBoundingClientRect();
            setHover(Math.min(xs.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / slot))));
          }}
          onPointerDown={(e) => {
            const r = (e.target as SVGRectElement).getBoundingClientRect();
            setHover(Math.min(xs.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / slot))));
          }}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {yTitle && <span className="y-title">{yTitle}</span>}
      <Tooltip
        tip={hover === null ? null : { x: PAD.l + hover * slot + slot / 2, y: sy(values[hover]), lines: [{ text: `${values[hover]}`, strong: true }, { text: xs[hover] }] }}
        width={w}
      />
    </div>
  );
}
