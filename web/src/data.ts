import type { Community, DistrictMeta, Meta, PartMeta, Tx } from "./types";

const BASE = `${import.meta.env.BASE_URL}data/`;

async function getJson<T>(path: string, fresh = false): Promise<T> {
  // meta.json 每次都問伺服器有沒有新版；其他檔名含版本碼，內容不會變，可直接用快取
  const res = await fetch(BASE + path, fresh ? { cache: "no-cache" } : undefined);
  if (!res.ok) throw new Error(`${path}：HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadMeta(): Promise<Meta> {
  const m = await getJson<Meta>("meta.json", true);
  if (!m.version || m.version < 2 || !m.districts[0]?.parts) {
    throw new Error("資料格式已更新，請重新整理頁面");
  }
  return m;
}

/** 社區登記表：各區檔各自帶用到的社區，載入時依代號合併成一份全域清單 */
export interface CommRegistry {
  list: Community[];
  byId: Map<string, number>;
}

export const newRegistry = (): CommRegistry => ({ list: [], byId: new Map() });

interface PartFile {
  fields: string[];
  commFields: string[];
  comms: unknown[][];
  rows: unknown[][];
}

/** 載入一個行政區的一段資料（近 12 月或更早）。start 為全域索引起點；社區併入 reg */
export async function loadPart(d: DistrictMeta, part: PartMeta, start: number, reg: CommRegistry): Promise<Tx[]> {
  const t = await getJson<PartFile>(part.file);
  const cf = Object.fromEntries(t.commFields.map((k, i) => [k, i]));
  const local = t.comms.map((r) => {
    const id = r[cf.id] as string;
    let gi = reg.byId.get(id);
    if (gi === undefined) {
      gi = reg.list.length;
      reg.byId.set(id, gi);
      reg.list.push({
        i: gi,
        id,
        name: r[cf.name] as string,
        district: r[cf.district] as string,
        lat: r[cf.lat] as number | null,
        lon: r[cf.lon] as number | null,
        built: r[cf.built] as string | null,
        floors: r[cf.floors] as number | null,
        buildings: r[cf.buildings] as number | null,
        presale: r[cf.presale] === 1,
      });
    }
    return gi;
  });
  const f = Object.fromEntries(t.fields.map((k, i) => [k, i]));
  const n = (v: unknown) => (v === null || v === undefined ? null : (v as number));
  return t.rows.map((r, j) => {
    const date = r[f.d] as number;
    const lc = r[f.cid] as number;
    return {
      i: start + j,
      id: r[f.id] as string,
      kind: r[f.k] as 0 | 1,
      district: d.code,
      part: part.key,
      date,
      ym: Math.floor(date / 100),
      lat: n(r[f.lat]),
      lon: n(r[f.lon]),
      geo: r[f.geo] as number,
      addr: d.name + (r[f.addr] as string), // 管線省略了「桃園市＋行政區」前綴，這裡補回行政區
      cid: lc >= 0 ? local[lc] : -1,
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

/** 成交卡片「原始欄位」：依行政區、資料段按需載入 */
export async function loadDetail(meta: Meta, t: Tx): Promise<Record<string, string> | null> {
  const part = meta.districts.find((x) => x.code === t.district)?.parts.find((p) => p.key === t.part);
  if (!part) return null;
  if (!detailCache.has(part.detail)) {
    detailCache.set(
      part.detail,
      getJson<{ rows: Record<string, string[]> }>(part.detail).then((x) => x.rows),
    );
  }
  const rows = await detailCache.get(part.detail)!;
  const r = rows[t.id];
  if (!r) return null;
  return Object.fromEntries(meta.detailFields.map((k, i) => [k, r[i] ?? ""]));
}
