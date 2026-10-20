import type { Tx } from "./types";

/** 線性內插分位數（與管線 Python 版相同），values 不需先排序 */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, v.length - 1);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const median = (values: number[]) => quantile(values, 0.5);

export interface Summary {
  n: number;
  nUnit: number;
  upMed: number | null;
  upP25: number | null;
  upP75: number | null;
  tpMed: number | null;
  pgMed: number | null;
}

/** 統計卡：一律用中位數 */
export function summarize(txs: Tx[]): Summary {
  const up: number[] = [];
  const tp: number[] = [];
  const pg: number[] = [];
  for (const t of txs) {
    if (t.up != null) up.push(t.up);
    if (t.tp != null) tp.push(t.tp);
    if (t.pg) pg.push(t.pg);
  }
  return {
    n: txs.length,
    nUnit: up.length,
    upMed: median(up),
    upP25: quantile(up, 0.25),
    upP75: quantile(up, 0.75),
    tpMed: median(tp),
    pgMed: median(pg),
  };
}

/** 色階：依目前範圍分位數切 5 級，或固定級距 */
export const FIXED_BREAKS = [20, 30, 40, 50];

export function quantileBreaks(values: number[]): number[] {
  if (values.length < 5) return FIXED_BREAKS;
  const b = [0.2, 0.4, 0.6, 0.8].map((q) => Math.round((quantile(values, q) ?? 0) * 10) / 10);
  for (let i = 1; i < b.length; i++) if (b[i] <= b[i - 1]) b[i] = Math.round((b[i - 1] + 0.1) * 10) / 10;
  return b;
}

export function colorClass(v: number | null, breaks: number[]): number {
  if (v == null) return -1;
  let c = 0;
  while (c < breaks.length && v >= breaks[c]) c++;
  return c;
}
