/** 社區頁、建案頁、走勢、比較共用的計算（統計一律用中位數，排除預設特殊交易） */
import { quantile } from "./stats";
import { parseUnit, naturalCompare } from "./units";
import type { Meta, Tx } from "./types";

export const ANOMALY = 0.2; // 偏離同社區中位數 ±20%

export function statsMask(meta: Meta): number {
  return meta.defaultExclude; // 含解約、預售交屋、親友等
}

/** 進統計的成交：排除預設特殊交易、算不出單價的，以及非住宅（店面、辦公等） */
export const forStats = (txs: Tx[], meta: Meta) => {
  const m = statsMask(meta);
  const res = new Set(meta.defaultBtypes);
  return txs.filter((t) => !(t.fx & m) && t.up !== null && res.has(t.bt));
};

export const quarterOf = (date: number) => {
  const y = Math.floor(date / 10000);
  const mo = Math.floor(date / 100) % 100;
  return `${y}Q${Math.floor((mo - 1) / 3) + 1}`;
};

export interface QStat {
  lo: number;
  mid: number;
  hi: number;
  n: number;
}

/** 依季彙總扣車位單價（P25／中位數／P75） */
export function quarterly(txs: Tx[]): Map<string, QStat> {
  const g = new Map<string, number[]>();
  for (const t of txs) {
    if (t.up === null) continue;
    const q = quarterOf(t.date);
    const a = g.get(q);
    if (a) a.push(t.up);
    else g.set(q, [t.up]);
  }
  const out = new Map<string, QStat>();
  for (const [q, v] of g) {
    out.set(q, { lo: quantile(v, 0.25)!, mid: quantile(v, 0.5)!, hi: quantile(v, 0.75)!, n: v.length });
  }
  return out;
}

/** 起訖之間每一季（含空的季），給 x 軸用 */
export function quarterRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, q] = [Number(from.slice(0, 4)), Number(from.slice(5))];
  const [ty, tq] = [Number(to.slice(0, 4)), Number(to.slice(5))];
  while (y < ty || (y === ty && q <= tq)) {
    out.push(`${y}Q${q}`);
    q++;
    if (q > 4) {
      q = 1;
      y++;
    }
  }
  return out;
}

/** 每月成交戶數（去化），起訖之間補 0 */
export function monthlyCounts(txs: Tx[]): { months: string[]; counts: number[] } {
  if (!txs.length) return { months: [], counts: [] };
  const c = new Map<number, number>();
  for (const t of txs) c.set(t.ym, (c.get(t.ym) ?? 0) + 1);
  const yms = [...c.keys()].sort((a, b) => a - b);
  const months: string[] = [];
  const counts: number[] = [];
  let y = Math.floor(yms[0] / 100);
  let m = yms[0] % 100;
  const end = yms[yms.length - 1];
  while (y * 100 + m <= end) {
    months.push(`${y}/${String(m).padStart(2, "0")}`);
    counts.push(c.get(y * 100 + m) ?? 0);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return { months, counts };
}

export interface FloorPremium {
  slope: number; // 每高一層加價（萬/坪）
  intercept: number;
  n: number;
  points: { floor: number; med: number; n: number }[];
}

/** 樓層價差：各樓層中位單價，對樓層做加權最小平方回歸；排除 1 樓（常是店面或有庭院） */
export function floorPremium(txs: Tx[]): FloorPremium | null {
  const g = new Map<number, number[]>();
  for (const t of txs) {
    if (t.up === null || t.fl === null || t.fl < 2) continue;
    const a = g.get(t.fl);
    if (a) a.push(t.up);
    else g.set(t.fl, [t.up]);
  }
  const points = [...g].map(([floor, v]) => ({ floor, med: quantile(v, 0.5)!, n: v.length })).sort((a, b) => a.floor - b.floor);
  if (points.length < 3) return null;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    sw += p.n;
    sx += p.n * p.floor;
    sy += p.n * p.med;
    sxx += p.n * p.floor * p.floor;
    sxy += p.n * p.floor * p.med;
  }
  const den = sw * sxx - sx * sx;
  if (!den) return null;
  const slope = (sw * sxy - sx * sy) / den;
  return { slope, intercept: (sy - slope * sx) / sw, n: sw, points };
}

export interface GridCell {
  tx: Tx;
  cancelled: boolean;
}

/** 虛擬銷控表：直欄＝棟＋戶、橫列＝樓層；同一戶多筆（解約後再賣）取最新一筆未解約的 */
export function salesGrid(txs: Tx[], cancelBit: number): { cols: string[]; floors: number[]; cells: Map<string, GridCell>; parsed: number } | null {
  const cells = new Map<string, GridCell>();
  const cols = new Set<string>();
  const floors = new Set<number>();
  let parsed = 0;
  for (const t of [...txs].sort((a, b) => a.date - b.date)) {
    const [col, fl] = parseUnit(t.un, t.fl);
    if (!col || fl === null) continue;
    parsed++;
    cols.add(col);
    floors.add(fl);
    const key = `${col}|${fl}`;
    const cancelled = (t.fx & cancelBit) !== 0;
    const prev = cells.get(key);
    if (!prev || prev.cancelled || !cancelled) cells.set(key, { tx: t, cancelled });
  }
  if (parsed < Math.max(4, txs.length * 0.5)) return null; // 棟及號大多解析不了（2021 年前沒有這欄）
  return {
    cols: [...cols].sort(naturalCompare),
    floors: [...floors].sort((a, b) => b - a),
    cells,
    parsed,
  };
}

/** 同社區中位數（傳入的成交：地圖列表為目前載入的資料；排除特殊交易、買賣與預售分開；至少 4 筆才算） */
export function communityMedians(txs: Tx[], meta: Meta): Map<string, number> {
  const g = new Map<string, number[]>();
  for (const t of forStats(txs, meta)) {
    if (t.cid < 0) continue;
    const k = `${t.cid}|${t.kind}`;
    const a = g.get(k);
    if (a) a.push(t.up!);
    else g.set(k, [t.up!]);
  }
  const out = new Map<string, number>();
  for (const [k, v] of g) if (v.length >= 4) out.set(k, quantile(v, 0.5)!);
  return out;
}

/** 偏離比例（≥ ±20% 才回傳） */
export function deviation(t: Tx, medians: Map<string, number>): number | undefined {
  if (t.up === null || t.cid < 0) return undefined;
  const m = medians.get(`${t.cid}|${t.kind}`);
  if (!m) return undefined;
  const d = t.up / m - 1;
  return Math.abs(d) >= ANOMALY ? d : undefined;
}

/** 中位數、P25、P75、件數 */
export function summary(values: number[]) {
  return {
    n: values.length,
    mid: quantile(values, 0.5),
    lo: quantile(values, 0.25),
    hi: quantile(values, 0.75),
  };
}
