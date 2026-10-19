import type { Meta, Tx } from "./types";

export type Period = "3m" | "6m" | "12m" | "3y" | "custom";
export type FloorClass = "l" | "m" | "h";

export interface Filters {
  kinds: number[]; // 0 買賣、1 預售
  period: Period;
  from: number | null; // 自訂起（yyyymm）
  to: number | null; // 自訂迄（yyyymm）
  districts: string[]; // 行政區代碼；空陣列＝全部
  btypes: number[];
  ageMin: number | null;
  ageMax: number | null;
  rooms: number[]; // 1、2、3、4（4 代表 4 房以上）
  tpMin: number | null;
  tpMax: number | null;
  upMin: number | null;
  upMax: number | null;
  pgMin: number | null;
  pgMax: number | null;
  pgMode: "p" | "i"; // 權狀／室內
  floors: FloorClass[];
  elevator: "" | "1" | "0";
  park: "" | "1" | "0";
  parkKind: "" | "平面" | "機械";
  exSpecial: boolean;
  exCancel: boolean;
}

export const PERIOD_LABEL: Record<Period, string> = {
  "3m": "近 3 月",
  "6m": "近 6 月",
  "12m": "近 12 月",
  "3y": "近 3 年",
  custom: "自訂",
};

export function defaultFilters(meta: Meta): Filters {
  return {
    kinds: [0, 1],
    period: "12m",
    from: null,
    to: null,
    districts: [],
    btypes: [...meta.defaultBtypes],
    ageMin: null,
    ageMax: null,
    rooms: [],
    tpMin: null,
    tpMax: null,
    upMin: null,
    upMax: null,
    pgMin: null,
    pgMax: null,
    pgMode: "p",
    floors: [],
    elevator: "",
    park: "",
    parkKind: "",
    exSpecial: true,
    exCancel: true,
  };
}

/** 期間起點（yyyymmdd）；以資料最新日期回推，避免資料發布延遲讓「近 3 月」變空 */
export function periodRange(f: Filters, latest: number): [number, number] {
  if (f.period === "custom") {
    return [f.from ? f.from * 100 + 1 : 0, f.to ? f.to * 100 + 31 : 99999999];
  }
  const months = { "3m": 3, "6m": 6, "12m": 12, "3y": 36 }[f.period];
  const y = Math.floor(latest / 10000);
  const m = Math.floor(latest / 100) % 100;
  const d = latest % 100;
  let ty = y;
  let tm = m - months;
  while (tm <= 0) {
    tm += 12;
    ty -= 1;
  }
  return [ty * 10000 + tm * 100 + d, 99999999];
}

export function floorClass(t: Tx): FloorClass | null {
  if (!t.fl || !t.tf || t.fl < 1) return null;
  const r = t.fl / t.tf;
  return r <= 1 / 3 ? "l" : r <= 2 / 3 ? "m" : "h";
}

export interface FilterCtx {
  start: number;
  end: number;
  exMask: number;
  cancelBit: number;
  mechanical: Set<number>; // 機械車位的類別索引
}

export function makeCtx(f: Filters, meta: Meta, latest: number): FilterCtx {
  const [start, end] = periodRange(f, latest);
  const cancel = meta.flags.find((x) => x.name === "解約");
  const cancelBit = cancel ? 1 << cancel.bit : 0;
  const exMask = f.exSpecial ? meta.defaultExclude & ~cancelBit : 0;
  const mechanical = new Set(
    meta.parkTypes.map((p, i) => (p.includes("機械") || p.includes("塔式") ? i : -1)).filter((i) => i >= 0),
  );
  return { start, end, exMask, cancelBit: f.exCancel ? cancelBit : 0, mechanical };
}

const inRange = (v: number | null, lo: number | null, hi: number | null) =>
  (lo == null && hi == null) || (v != null && (lo == null || v >= lo) && (hi == null || v <= hi));

export function pass(t: Tx, f: Filters, c: FilterCtx): boolean {
  if (!f.kinds.includes(t.kind)) return false;
  if (t.date < c.start || t.date > c.end) return false;
  if (f.districts.length && !f.districts.includes(t.district)) return false;
  if (!f.btypes.includes(t.bt)) return false;
  if (t.fx & c.exMask || t.fx & c.cancelBit) return false;
  if (f.ageMin != null || f.ageMax != null) {
    const age = t.kind === 1 ? 0 : t.age;
    if (!inRange(age, f.ageMin, f.ageMax)) return false;
  }
  if (f.rooms.length) {
    const r = t.rm ?? 0;
    if (!f.rooms.some((x) => (x >= 4 ? r >= 4 : r === x))) return false;
  }
  if (!inRange(t.tp, f.tpMin, f.tpMax)) return false;
  if (!inRange(t.up, f.upMin, f.upMax)) return false;
  if (!inRange(f.pgMode === "p" ? t.pg : t.ip, f.pgMin, f.pgMax)) return false;
  if (f.floors.length) {
    const fc = floorClass(t);
    if (!fc || !f.floors.includes(fc)) return false;
  }
  if (f.elevator && t.el !== Number(f.elevator)) return false;
  if (f.park === "1" && !t.pn) return false;
  if (f.park === "0" && t.pn) return false;
  if (f.parkKind) {
    if (!t.pn || t.pt < 0) return false;
    if ((f.parkKind === "機械") !== c.mechanical.has(t.pt)) return false;
  }
  return true;
}

/** 與預設不同的篩選數（給頂部按鈕顯示） */
export function activeCount(f: Filters, d: Filters): number {
  const keys = Object.keys(d) as (keyof Filters)[];
  return keys.filter((k) => k !== "from" && k !== "to" && JSON.stringify(f[k]) !== JSON.stringify(d[k])).length;
}

// ── 網址同步：只寫與預設不同的欄位 ──

const LIST_NUM: (keyof Filters)[] = ["kinds", "btypes", "rooms"];
const LIST_STR: (keyof Filters)[] = ["districts", "floors"];
const NUMS: (keyof Filters)[] = ["from", "to", "ageMin", "ageMax", "tpMin", "tpMax", "upMin", "upMax", "pgMin", "pgMax"];
const STRS: (keyof Filters)[] = ["period", "pgMode", "elevator", "park", "parkKind"];
const BOOLS: (keyof Filters)[] = ["exSpecial", "exCancel"];

export function filtersToParams(f: Filters, d: Filters, p: URLSearchParams) {
  for (const k of [...LIST_NUM, ...LIST_STR]) {
    const v = f[k] as (number | string)[];
    if (JSON.stringify(v) !== JSON.stringify(d[k])) p.set(k, v.join(",") || "-");
  }
  for (const k of [...NUMS, ...STRS]) if (f[k] !== d[k] && f[k] != null) p.set(k, String(f[k]));
  for (const k of BOOLS) if (f[k] !== d[k]) p.set(k, f[k] ? "1" : "0");
}

export function filtersFromParams(p: URLSearchParams, d: Filters): Filters {
  const f: Filters = structuredClone(d);
  const rec = f as unknown as Record<string, unknown>;
  for (const k of LIST_NUM) {
    const v = p.get(k);
    if (v != null) rec[k] = v === "-" ? [] : v.split(",").map(Number).filter((x) => !Number.isNaN(x));
  }
  for (const k of LIST_STR) {
    const v = p.get(k);
    if (v != null) rec[k] = v === "-" ? [] : v.split(",");
  }
  for (const k of NUMS) {
    const v = p.get(k);
    if (v != null && v !== "" && !Number.isNaN(Number(v))) rec[k] = Number(v);
  }
  for (const k of STRS) {
    const v = p.get(k);
    if (v != null) rec[k] = v;
  }
  for (const k of BOOLS) {
    const v = p.get(k);
    if (v != null) rec[k] = v === "1";
  }
  return f;
}
