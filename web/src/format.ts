/** 數字格式（SPEC）：總價「1,288 萬」、單價「32.5 萬/坪」、面積「35.2 坪」、日期「2026/05」 */

const int = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat("zh-TW", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmtTotal = (v: number | null | undefined) => (v == null ? "—" : `${int.format(Math.round(v))} 萬`);
export const fmtUnit = (v: number | null | undefined) => (v == null ? "—" : `${one.format(v)} 萬/坪`);
export const fmtUnitShort = (v: number | null | undefined) => (v == null ? "—" : one.format(v));
export const fmtPing = (v: number | null | undefined) => (v == null ? "—" : `${one.format(v)} 坪`);
export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
export const fmtYm = (ym: number) => `${Math.floor(ym / 100)}/${String(ym % 100).padStart(2, "0")}`;
export const fmtDate = (d: number) =>
  `${Math.floor(d / 10000)}/${String(Math.floor(d / 100) % 100).padStart(2, "0")}/${String(d % 100).padStart(2, "0")}`;
export const fmtAge = (v: number | null | undefined, kind: 0 | 1) =>
  kind === 1 ? "預售" : v == null ? "—" : v < 1 ? "未滿 1 年" : `${one.format(v)} 年`;
export const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${one.format(m / 1000)} km`);

export function fmtFloor(fl: number | null, tf: number | null) {
  const f = fl == null ? "—" : fl < 0 ? `B${-fl}` : `${fl}`;
  return tf ? `${f}／${tf} 樓` : `${f} 樓`;
}

export function fmtLayout(rm: number | null, hl: number | null, ba: number | null) {
  if (!rm && !hl && !ba) return "—";
  return `${rm ?? 0}房${hl ?? 0}廳${ba ?? 0}衛`;
}

/** 民國 yyymmdd → 「115/09/30」 */
export const fmtRoc = (v: number | null | undefined) => {
  if (!v) return "";
  const s = String(v).padStart(7, "0");
  return `${Number(s.slice(0, 3))}/${s.slice(3, 5)}/${s.slice(5, 7)}`;
};
