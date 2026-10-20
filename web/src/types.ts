export interface FlagDef {
  bit: number;
  name: string;
  exclude: boolean;
  source: string;
  note?: string;
}

export interface PartMeta {
  key: "r" | "o"; // r 近 12 月、o 更早（近 3 年內）
  label: string;
  n: number;
  file: string;
  detail: string;
  bytes: number;
}

export interface DistrictMeta {
  code: string;
  name: string;
  n: number;
  parts: PartMeta[];
  lat: number | null;
  lon: number | null;
}

export interface Meta {
  version: number;
  generated: string;
  range: { from: string; to: string };
  split: string; // 近 12 月的起日（yyyy-mm-dd），更早的資料另檔按需載入
  latest: { name: string; text: string; saleTo: number; presaleTo: number } | null;
  periods: string[];
  counts: { total: number; a: number; b: number; located: number; recent: number };
  fields: string[];
  commFields: string[];
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
  rangeAll: { from: string; to: string }; // 全部資料（2012 年起）的成交日期範圍
  history: { n: number; files: string[] }; // 社區／建案歷史檔（依代號雜湊分份）
  search: string; // 搜尋索引檔
  searchFields: string[];
  stats: string; // 季統計檔
}

/** 一筆成交（前端解碼後） */
export interface Tx {
  i: number; // 全域索引
  id: string;
  kind: 0 | 1; // 0 買賣、1 預售
  district: string; // 行政區代碼
  part: "r" | "o" | "h"; // 資料段：r 近 12 月、o 更早（近 3 年內）、h 歷史（只在社區／建案頁，沒有原始欄位檔）
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
  shard: number; // 在第幾份歷史檔
  link: string | null; // 預售建案：交屋後的社區代號（土地地號連結）
  pr: number | null; // 預售建案：交屋社區的公設比中位數
  level: number | null; // 預售建案：位置精度
}

export interface SearchEntry {
  id: string;
  name: string;
  district: string;
  lat: number | null;
  lon: number | null;
  presale: boolean;
  n: number;
  last: number; // 最近一筆成交 yyyymm
  shard: number;
}

/** 社區或建案的全部成交（2012 年起） */
export interface Entity {
  info: Community;
  txs: Tx[];
}

/** 季統計一列：行政區（或「桃園市」）× 類別 × 季 */
export interface StatRow {
  district: string;
  group: string;
  quarter: string; // 2024Q3
  n: number;
  p25: number;
  p50: number;
  p75: number;
}

/** 全螢幕分頁 */
export type Page =
  | { kind: "c"; id: string } // 社區頁
  | { kind: "p"; id: string } // 預售建案頁
  | { kind: "trend" }
  | { kind: "cmp" }
  | { kind: "fav" }
  | { kind: "search" };

export type LngLat = [number, number];

/** 目前列表／統計的範圍 */
export type Scope =
  | { kind: "view" }
  | { kind: "circle"; center: LngLat; radius: number; source: "gps" | "press" }
  | { kind: "polygon"; points: LngLat[] }
  | { kind: "community"; cid: number }
  | { kind: "building"; key: string; label: string };
