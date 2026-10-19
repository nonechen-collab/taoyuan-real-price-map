export interface FlagDef {
  bit: number;
  name: string;
  exclude: boolean;
  source: string;
  note?: string;
}

export interface DistrictMeta {
  code: string;
  name: string;
  n: number;
  file: string;
  detail: string;
  bytes: number;
  lat: number | null;
  lon: number | null;
}

export interface Meta {
  generated: string;
  range: { from: string; to: string };
  latest: { name: string; text: string; saleTo: number; presaleTo: number } | null;
  periods: string[];
  counts: { total: number; a: number; b: number; located: number };
  fields: string[];
  detailFields: string[];
  flags: FlagDef[];
  defaultExclude: number;
  btypes: string[];
  defaultBtypes: number[];
  parkTypes: string[];
  geoLevels: Record<string, string>;
  approxLevels: number[];
  districts: DistrictMeta[];
  sources: string[];
}

/** 一筆成交（前端解碼後） */
export interface Tx {
  i: number; // 全域索引
  id: string;
  kind: 0 | 1; // 0 買賣、1 預售
  district: string; // 行政區代碼
  date: number; // yyyymmdd
  ym: number; // yyyymm
  lat: number | null;
  lon: number | null;
  geo: number; // 定位精度
  addr: string;
  cid: number; // 社區索引，-1 為無
  bt: number;
  fl: number | null;
  tf: number | null;
  age: number | null;
  rm: number | null;
  hl: number | null;
  ba: number | null;
  tp: number | null; // 總價（萬）
  up: number | null; // 扣車位單價（萬/坪）
  pg: number | null; // 權狀坪（不含車位）
  ip: number | null; // 室內坪（主建物）
  pr: number | null; // 公設比
  pn: number; // 車位數
  pt: number; // 車位類別索引，-1 無
  pp: number | null; // 車位總價（萬，可能為估算）
  pa: number | null; // 車位面積（坪）
  el: number | null; // 電梯 1/0
  fx: number; // 旗標位元
  un: string | null; // 預售棟及號
}

export interface Community {
  i: number;
  id: string;
  name: string;
  district: string;
  lat: number | null;
  lon: number | null;
  built: string | null;
  floors: number | null;
  buildings: number | null;
  presale: boolean;
}

export type LngLat = [number, number];

/** 目前列表／統計的範圍 */
export type Scope =
  | { kind: "view" }
  | { kind: "circle"; center: LngLat; radius: number; source: "gps" | "press" }
  | { kind: "polygon"; points: LngLat[] }
  | { kind: "community"; cid: number }
  | { kind: "building"; key: string; label: string };
