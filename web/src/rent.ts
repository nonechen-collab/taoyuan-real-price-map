/**
 * 租賃（近 3 年）：載入、篩選、統計、毛租金報酬率。
 * 毛租金報酬率＝整層住家每坪月租中位數 × 12 ÷ 同範圍買賣扣車位單價中位數（套房、社宅包租代管不算）。
 */
import { getJson, type CommRegistry } from "./data";
import { periodRange, type Filters } from "./filters";
import { quantile } from "./stats";
import type { Meta, Rent, RentMeta } from "./types";

type Row = unknown[];

export type RentKind = "all" | "whole" | "suite"; // 全部／整層住家／套房雅房

export const RENT_FIXED_BREAKS = [450, 600, 750, 900];

/** 載入一區的租賃檔；cm（社區代號）對應到已載入的社區登記表，沒有就 -1 */
export async function loadRentDistrict(
  d: RentMeta["districts"][number],
  start: number,
  reg: CommRegistry,
  codeOf: (name: string) => string,
): Promise<Rent[]> {
  const t = await getJson<{ fields: string[]; rows: Row[] }>(d.file);
  const f = Object.fromEntries(t.fields.map((k, i) => [k, i]));
  const num = (v: unknown) => (v === null || v === undefined ? null : (v as number));
  const code = codeOf(d.name);
  return t.rows.map((r, j) => {
    const date = r[f.d] as number;
    const cm = r[f.cm] as string | null;
    return {
      i: start + j,
      id: r[f.id] as string,
      district: code,
      date,
      ym: Math.floor(date / 100),
      lat: num(r[f.lat]),
      lon: num(r[f.lon]),
      geo: r[f.geo] as number,
      addr: r[f.addr] as string,
      cid: cm ? (reg.byId.get(cm) ?? -1) : -1,
      bt: r[f.bt] as number,
      fl: num(r[f.fl]),
      tf: num(r[f.tf]),
      age: num(r[f.age]),
      rm: num(r[f.rm]),
      hl: num(r[f.hl]),
      ba: num(r[f.ba]),
      pg: num(r[f.pg]),
      rent: r[f.rent] as number,
      ru: num(r[f.ru]),
      rt: r[f.rt] as number,
      sv: r[f.sv] as number,
      fu: num(r[f.fu]),
      mg: num(r[f.mg]),
      el: num(r[f.el]),
      pt: r[f.pt] as number,
      pp: num(r[f.pp]),
      fx: r[f.fx] as number,
    };
  });
}

export interface RentCtx {
  start: number;
  end: number;
  exMask: number;
  whole: Set<number>;
}

export function rentLatest(rm: RentMeta | undefined): number {
  return rm?.range ? Number(rm.range.to.replaceAll("-", "")) : 0;
}

export function makeRentCtx(f: Filters, rm: RentMeta): RentCtx {
  const [start, end] = periodRange(f, rentLatest(rm));
  return { start, end, exMask: f.exSpecial ? rm.defaultExclude : 0, whole: new Set(rm.whole) };
}

const inRange = (v: number | null, lo: number | null, hi: number | null) =>
  (lo == null && hi == null) || (v != null && (lo == null || v >= lo) && (hi == null || v <= hi));

/** 租賃模式只套用：期間、行政區、型態、房數、坪數、排除特殊租約 */
export function passRent(r: Rent, f: Filters, c: RentCtx, kind: RentKind): boolean {
  if (r.date < c.start || r.date > c.end) return false;
  if (f.districts.length && !f.districts.includes(r.district)) return false;
  if (!f.btypes.includes(r.bt)) return false;
  if (r.fx & c.exMask) return false;
  if (kind === "whole" && !c.whole.has(r.rt)) return false;
  if (kind === "suite" && (r.rt < 0 || c.whole.has(r.rt))) return false;
  if (f.rooms.length) {
    const n = r.rm ?? 0;
    if (!f.rooms.some((x) => (x >= 4 ? n >= 4 : n === x))) return false;
  }
  if (!inRange(r.pg, f.pgMin, f.pgMax)) return false;
  return true;
}

export interface RentSummary {
  n: number;
  ruMed: number | null;
  ruP25: number | null;
  ruP75: number | null;
  rentMed: number | null;
  pgMed: number | null;
  nWhole: number; // 算報酬率用的整層住家筆數
  ruWhole: number | null;
}

export function summarizeRent(rs: Rent[], meta: Meta): RentSummary {
  const whole = new Set(meta.rent?.whole ?? []);
  const res = new Set(meta.defaultBtypes);
  const ru: number[] = [];
  const rent: number[] = [];
  const pg: number[] = [];
  const ruW: number[] = [];
  for (const r of rs) {
    if (r.ru != null) ru.push(r.ru);
    rent.push(r.rent);
    if (r.pg) pg.push(r.pg);
    if (r.ru != null && whole.has(r.rt) && res.has(r.bt)) ruW.push(r.ru);
  }
  return {
    n: rs.length,
    ruMed: quantile(ru, 0.5),
    ruP25: quantile(ru, 0.25),
    ruP75: quantile(ru, 0.75),
    rentMed: quantile(rent, 0.5),
    pgMed: quantile(pg, 0.5),
    nWhole: ruW.length,
    ruWhole: quantile(ruW, 0.5),
  };
}

/** 毛租金報酬率（小數）；樣本不足回傳 null */
export function grossYield(ruWhole: number | null, nWhole: number, upMed: number | null, nSale: number): number | null {
  if (ruWhole == null || upMed == null || nWhole < 5 || nSale < 5 || upMed <= 0) return null;
  return (ruWhole * 12) / (upMed * 10000);
}

export function rentBreaks(values: number[]): number[] {
  if (values.length < 5) return RENT_FIXED_BREAKS;
  const b = [0.2, 0.4, 0.6, 0.8].map((q) => Math.round(quantile(values, q) ?? 0));
  for (let i = 1; i < b.length; i++) if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1;
  return b;
}

const int = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
export const fmtRu = (v: number | null | undefined) => (v == null ? "—" : int.format(Math.round(v)));
export const fmtRent = (v: number | null | undefined) =>
  v == null ? "—" : v >= 10000 ? `${(Math.round(v / 1000) / 10).toLocaleString("zh-TW")} 萬` : `${int.format(v)} 元`;
export const fmtYield = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
