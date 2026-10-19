import type { Community, DistrictMeta, Meta, Tx } from "./types";

const BASE = `${import.meta.env.BASE_URL}data/`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}：HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function loadMeta(): Promise<Meta> {
  return getJson<Meta>("meta.json");
}

interface Table<R> {
  fields: string[];
  rows: R;
}

export async function loadCommunities(): Promise<Community[]> {
  const t = await getJson<Table<unknown[][]>>("communities.json");
  const f = Object.fromEntries(t.fields.map((k, i) => [k, i]));
  return t.rows.map((r, i) => ({
    i,
    id: r[f.id] as string,
    name: r[f.name] as string,
    district: r[f.district] as string,
    lat: r[f.lat] as number | null,
    lon: r[f.lon] as number | null,
    built: r[f.built] as string | null,
    floors: r[f.floors] as number | null,
    buildings: r[f.buildings] as number | null,
    presale: r[f.presale] === 1,
  }));
}

/** 載入一個行政區的成交，start 為全域索引起點 */
export async function loadDistrict(d: DistrictMeta, start: number): Promise<Tx[]> {
  const t = await getJson<Table<unknown[][]>>(d.file);
  const f = Object.fromEntries(t.fields.map((k, i) => [k, i]));
  const n = (v: unknown) => (v === null || v === undefined ? null : (v as number));
  return t.rows.map((r, j) => {
    const date = r[f.d] as number;
    return {
      i: start + j,
      id: r[f.id] as string,
      kind: r[f.k] as 0 | 1,
      district: d.code,
      date,
      ym: Math.floor(date / 100),
      lat: n(r[f.lat]),
      lon: n(r[f.lon]),
      geo: r[f.geo] as number,
      addr: d.name + (r[f.addr] as string), // 管線省略了「桃園市＋行政區」前綴，這裡補回行政區
      cid: r[f.cid] as number,
      bt: r[f.bt] as number,
      fl: n(r[f.fl]),
      tf: n(r[f.tf]),
      age: n(r[f.age]),
      rm: n(r[f.rm]),
      hl: n(r[f.hl]),
      ba: n(r[f.ba]),
      tp: n(r[f.tp]),
      up: n(r[f.up]),
      pg: n(r[f.pg]),
      ip: n(r[f.ip]),
      pr: n(r[f.pr]),
      pn: (r[f.pn] as number) ?? 0,
      pt: (r[f.pt] as number) ?? -1,
      pp: n(r[f.pp]),
      pa: n(r[f.pa]),
      el: n(r[f.el]),
      fx: (r[f.fx] as number) ?? 0,
      un: (r[f.un] as string | null) ?? null,
    };
  });
}

const detailCache = new Map<string, Promise<Record<string, string[]>>>();

/** 成交卡片「原始欄位」：依行政區按需載入 */
export async function loadDetail(meta: Meta, district: string, id: string): Promise<Record<string, string> | null> {
  const d = meta.districts.find((x) => x.code === district);
  if (!d) return null;
  if (!detailCache.has(d.code)) {
    detailCache.set(
      d.code,
      getJson<Table<Record<string, string[]>>>(d.detail).then((t) => t.rows),
    );
  }
  const rows = await detailCache.get(d.code)!;
  const r = rows[id];
  if (!r) return null;
  return Object.fromEntries(meta.detailFields.map((k, i) => [k, r[i] ?? ""]));
}
