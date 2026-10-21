import type { Community, DistrictMeta, Entity, Meta, PartMeta, SearchEntry, StatRow, Tx } from "./types";

const BASE = `${import.meta.env.BASE_URL}data/`;

export async function getJson<T>(path: string, fresh = false): Promise<T> {
  // meta.json 每次都問伺服器有沒有新版；其他檔名含版本碼，內容不會變，可直接用快取
  const res = await fetch(BASE + path, fresh ? { cache: "no-cache" } : undefined);
  if (!res.ok) throw new Error(`${path}：HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadMeta(): Promise<Meta> {
  const m = await getJson<Meta>("meta.json", true);
  // 缺欄位＝讀到手機快取的舊版 meta（網路慢時）：丟出「格式已更新」，App 會自動重新整理一次
  if (!m.version || m.version < 2 || !m.districts[0]?.parts || !m.history || !m.search || !m.stats) {
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

type Row = unknown[];
type Idx = Record<string, number>;
const indexOf = (fields: string[]): Idx => Object.fromEntries(fields.map((k, i) => [k, i]));
const num = (v: unknown) => (v === null || v === undefined ? null : (v as number));

function decodeComm(r: Row, cf: Idx, i: number): Community {
  return {
    i,
    id: r[cf.id] as string,
    name: r[cf.name] as string,
    district: r[cf.district] as string,
    lat: num(r[cf.lat]),
    lon: num(r[cf.lon]),
    built: (r[cf.built] as string | null) ?? null,
    floors: num(r[cf.floors]),
    buildings: num(r[cf.buildings]),
    presale: r[cf.presale] === 1,
    shard: (r[cf.shard] as number) ?? 0,
    link: (r[cf.link] as string | null) ?? null,
    pr: num(r[cf.pr]),
    level: num(r[cf.level]),
  };
}

function decodeTx(r: Row, f: Idx, i: number, d: { code: string; name: string }, part: Tx["part"], cid: number): Tx {
  const date = r[f.d] as number;
  return {
    i,
    id: r[f.id] as string,
    kind: r[f.k] as 0 | 1,
    district: d.code,
    part,
    date,
    ym: Math.floor(date / 100),
    lat: num(r[f.lat]),
    lon: num(r[f.lon]),
    geo: r[f.geo] as number,
    addr: d.name + (r[f.addr] as string), // 管線省略了「桃園市＋行政區」前綴，這裡補回行政區
    cid,
    bt: r[f.bt] as number,
    fl: num(r[f.fl]),
    tf: num(r[f.tf]),
    age: num(r[f.age]),
    rm: num(r[f.rm]),
    hl: num(r[f.hl]),
    ba: num(r[f.ba]),
    tp: num(r[f.tp]),
    up: num(r[f.up]),
    pg: num(r[f.pg]),
    ip: num(r[f.ip]),
    pr: num(r[f.pr]),
    pn: (r[f.pn] as number) ?? 0,
    pt: (r[f.pt] as number) ?? -1,
    pp: num(r[f.pp]),
    pa: num(r[f.pa]),
    el: num(r[f.el]),
    fx: (r[f.fx] as number) ?? 0,
    un: (r[f.un] as string | null) ?? null,
  };
}

interface PartFile {
  fields: string[];
  commFields: string[];
  comms: Row[];
  rows: Row[];
}

/** 社區合併進全域登記表，回傳全域索引 */
function register(reg: CommRegistry, r: Row, cf: Idx): number {
  const id = r[cf.id] as string;
  let gi = reg.byId.get(id);
  if (gi === undefined) {
    gi = reg.list.length;
    reg.byId.set(id, gi);
    reg.list.push(decodeComm(r, cf, gi));
  }
  return gi;
}

/** 載入一個行政區的一段資料（近 12 月或更早）。start 為全域索引起點；社區併入 reg */
export async function loadPart(d: DistrictMeta, part: PartMeta, start: number, reg: CommRegistry): Promise<Tx[]> {
  const t = await getJson<PartFile>(part.file);
  const cf = indexOf(t.commFields);
  const local = t.comms.map((r) => register(reg, r, cf));
  const f = indexOf(t.fields);
  return t.rows.map((r, j) => {
    const lc = r[f.cid] as number;
    return decodeTx(r, f, start + j, d, part.key, lc >= 0 ? local[lc] : -1);
  });
}

// ── 社區／建案歷史（2012 年起），點開社區頁、建案頁才下載 ──

interface ShardFile {
  fields: string[];
  commFields: string[];
  ents: Record<string, { c: Row; rows: Row[] }>;
}

const shardCache = new Map<number, Promise<ShardFile>>();

function loadShard(meta: Meta, i: number): Promise<ShardFile> {
  if (!shardCache.has(i)) {
    const p = getJson<ShardFile>(meta.history.files[i]);
    p.catch(() => shardCache.delete(i)); // 失敗下次再試
    shardCache.set(i, p);
  }
  return shardCache.get(i)!;
}

/** 載入一個社區或建案的全部成交；cid 用全域登記表的索引（沒有就 -1） */
export async function loadEntity(meta: Meta, id: string, shard: number, reg: CommRegistry): Promise<Entity | null> {
  const s = await loadShard(meta, shard);
  const e = s.ents[id];
  if (!e) return null;
  const cf = indexOf(s.commFields);
  const gi = register(reg, e.c, cf);
  const info = reg.list[gi];
  const dm = meta.districts.find((x) => x.name === info.district);
  const d = { code: dm?.code ?? "", name: info.district };
  const f = indexOf(s.fields);
  const split = Number(meta.split.replaceAll("-", ""));
  const from = Number(meta.range.from.replaceAll("-", ""));
  const txs = e.rows.map((r, j) => {
    const date = r[f.d] as number;
    const part: Tx["part"] = date >= split ? "r" : date >= from ? "o" : "h";
    return decodeTx(r, f, -1 - j, d, part, gi); // 負索引：不和地圖上的成交混用
  });
  return { info, txs };
}

let searchCache: Promise<SearchEntry[]> | null = null;

/** 搜尋索引：所有社區與預售建案（2012 年起），開搜尋頁才下載 */
export function loadSearch(meta: Meta): Promise<SearchEntry[]> {
  if (!searchCache) {
    searchCache = getJson<{ fields: string[]; rows: Row[] }>(meta.search).then((t) => {
      const f = indexOf(t.fields);
      return t.rows.map((r) => ({
        id: r[f.id] as string,
        name: r[f.name] as string,
        district: r[f.district] as string,
        lat: num(r[f.lat]),
        lon: num(r[f.lon]),
        presale: r[f.presale] === 1,
        n: r[f.n] as number,
        last: r[f.last] as number,
        shard: r[f.shard] as number,
      }));
    });
    searchCache.catch(() => (searchCache = null));
  }
  return searchCache;
}

let statsCache: Promise<StatRow[]> | null = null;

/** 季統計（2012 年起，各區＋全市 × 類別），行情走勢用 */
export function loadStats(meta: Meta): Promise<StatRow[]> {
  if (!statsCache) {
    statsCache = getJson<{ fields: string[]; rows: Row[] }>(meta.stats).then((t) => {
      const f = indexOf(t.fields);
      return t.rows.map((r) => ({
        district: r[f.district] as string,
        group: r[f.group] as string,
        quarter: r[f.quarter] as string,
        n: r[f.n] as number,
        p25: r[f.p25] as number,
        p50: r[f.p50] as number,
        p75: r[f.p75] as number,
      }));
    });
    statsCache.catch(() => (statsCache = null));
  }
  return statsCache;
}

const detailCache = new Map<string, Promise<Record<string, string[]>>>();

/** 成交卡片「原始欄位」：依行政區、資料段按需載入（歷史段 h 沒有明細檔） */
export async function loadDetail(meta: Meta, t: Tx): Promise<Record<string, string> | null> {
  if (t.part === "h") return null;
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
