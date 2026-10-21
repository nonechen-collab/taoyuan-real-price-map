/**
 * 收藏＋看屋筆記：只存在這支手機的瀏覽器（localStorage），可匯出／匯入 JSON 備份。
 * 清除瀏覽器資料會一起清掉，所以收藏頁會提醒定期匯出。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const NOTE_FIELDS = ["結構", "防水", "隔音", "格局", "售後服務", "價格"] as const;
export type NoteField = (typeof NOTE_FIELDS)[number] | "其他";

export type FavArea = { type: "circle"; center: [number, number]; radius: number } | { type: "polygon"; points: [number, number][] };

export interface Fav {
  key: string; // c:代號、p:代號、t:編號、a:建立時間
  kind: "c" | "p" | "t" | "a"; // a：收藏的範圍（圓或多邊形）
  id: string;
  name: string;
  district: string;
  shard?: number;
  lat?: number | null;
  lon?: number | null;
  sub?: string; // 成交：日期、總價等摘要
  addedAt: string;
  note: Partial<Record<NoteField, string>>;
  noteAt?: string;
  area?: FavArea; // 範圍收藏
  seenN?: number; // 社區／建案：上次看到的成交筆數（2012 年起）
  seenIds?: string[]; // 範圍：上次看到的近 12 月成交編號
}

const KEY = "lvr-favs-v1";

function read(): Fav[] {
  try {
    const v = localStorage.getItem(KEY);
    const arr = v ? (JSON.parse(v) as Fav[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(favs: Fav[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(favs));
    return true;
  } catch {
    return false; // 無痕模式或空間不足
  }
}

export function useFavorites() {
  const [favs, setFavs] = useState<Fav[]>(read);
  const [saveError, setSaveError] = useState(false);
  const latest = useRef(favs); // 匯入時要當下算出新增／更新筆數，不能放在 setState 的更新函式裡算
  latest.current = favs;
  useEffect(() => {
    setSaveError(!write(favs));
  }, [favs]);
  // 其他分頁改了也同步
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === KEY) setFavs(read());
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const isFav = useCallback((key: string) => favs.some((f) => f.key === key), [favs]);
  const toggle = useCallback((f: Omit<Fav, "addedAt" | "note">) => {
    setFavs((list) =>
      list.some((x) => x.key === f.key)
        ? list.filter((x) => x.key !== f.key)
        : [{ ...f, addedAt: new Date().toISOString(), note: {} }, ...list],
    );
  }, []);
  const setNote = useCallback((key: string, field: NoteField, value: string) => {
    setFavs((list) =>
      list.map((f) => (f.key === key ? { ...f, note: { ...f.note, [field]: value }, noteAt: new Date().toISOString() } : f)),
    );
  }, []);
  const remove = useCallback((key: string) => setFavs((list) => list.filter((f) => f.key !== key)), []);
  /** 更新「已看過」的基準（新成交提醒用） */
  const update = useCallback((key: string, patch: Partial<Pick<Fav, "seenN" | "seenIds">>) => {
    setFavs((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }, []);
  const add = useCallback((f: Omit<Fav, "addedAt" | "note">) => {
    setFavs((list) => (list.some((x) => x.key === f.key) ? list : [{ ...f, addedAt: new Date().toISOString(), note: {} }, ...list]));
  }, []);

  const exportJson = useCallback(() => {
    const blob = new Blob(
      [JSON.stringify({ app: "taoyuan-real-price-map", version: 1, exportedAt: new Date().toISOString(), favs }, null, 1)],
      { type: "application/json" },
    );
    download(blob, `桃園實價收藏_${today()}.json`);
  }, [favs]);

  /** 匯入：同一個收藏以筆記較新者為準；回傳新增與更新筆數 */
  const importJson = useCallback(async (file: File): Promise<{ added: number; updated: number }> => {
    const data = JSON.parse(await file.text()) as { favs?: Fav[] };
    if (!data || !Array.isArray(data.favs)) throw new Error("檔案格式不對（不是本網站匯出的收藏）");
    let added = 0;
    let updated = 0;
    const map = new Map(latest.current.map((f) => [f.key, f]));
    for (const f of data.favs) {
      if (!f || typeof f.key !== "string" || !f.kind || !f.id) continue;
      const old = map.get(f.key);
      if (!old) {
        map.set(f.key, { ...f, note: f.note ?? {} });
        added++;
      } else if ((f.noteAt ?? "") > (old.noteAt ?? "")) {
        map.set(f.key, { ...old, note: f.note ?? {}, noteAt: f.noteAt });
        updated++;
      }
    }
    latest.current = [...map.values()];
    setFavs(latest.current);
    return { added, updated };
  }, []);

  return { favs, isFav, toggle, setNote, remove, update, add, exportJson, importJson, saveError };
}

export type Favorites = ReturnType<typeof useFavorites>;

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 讓手機瀏覽器下載檔案 */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
