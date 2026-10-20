/** 搜尋建案／社區（2012 年起全部）：名稱模糊比對，例如「君邑 中運」「璞園」 */
import { useEffect, useMemo, useRef, useState } from "react";
import { loadSearch } from "../data";
import { fmtYm } from "../format";
import PageShell from "./PageShell";
import type { Meta, SearchEntry } from "../types";

const FW = "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ";
const HW = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 去空白與標點、全形轉半形、臺→台、大寫 */
export function normName(s: string): string {
  return [...s.toUpperCase().replace(/臺/g, "台")]
    .map((ch) => {
      const i = FW.indexOf(ch);
      return i >= 0 ? HW[i] : ch;
    })
    .join("")
    .replace(/[\s．・.。、,，\-－_()（）'"「」『』|｜/]/g, "");
}

/** 分數：完整包含 3、每個關鍵字都包含 2、字依序出現 1；不符 0 */
export function score(name: string, query: string): number {
  const n = normName(name);
  const q = normName(query);
  if (!q) return 0;
  if (n.includes(q)) return 3;
  const words = query.split(/\s+/).map(normName).filter(Boolean);
  if (words.length > 1 && words.every((w) => n.includes(w))) return 2;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length && q.length >= 2 ? 1 : 0;
}

interface Props {
  meta: Meta;
  onBack: () => void;
  onOpen: (e: SearchEntry) => void;
}

export default function SearchPage({ meta, onBack, onOpen }: Props) {
  const [all, setAll] = useState<SearchEntry[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "p" | "c">("all");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSearch(meta).then(setAll).catch(() => setErr(true));
    input.current?.focus();
  }, [meta]);

  const results = useMemo(() => {
    if (!all || !q.trim()) return [];
    const out: { e: SearchEntry; s: number }[] = [];
    for (const e of all) {
      if (kind === "p" && !e.presale) continue;
      if (kind === "c" && e.presale) continue;
      const s = Math.max(score(e.name, q), score(e.district + e.name, q) - 1);
      if (s > 0) out.push({ e, s });
    }
    out.sort((a, b) => b.s - a.s || Number(b.e.presale) - Number(a.e.presale) || b.e.n - a.e.n);
    return out.slice(0, 60);
  }, [all, q, kind]);

  return (
    <PageShell title="搜尋建案／社區" sub="2012 年起全部預售建案與推定社區" onBack={onBack}>
      <section>
        <input
          ref={input}
          className="search-input"
          type="search"
          inputMode="search"
          placeholder="建案名稱或路名，例如：璞園、昭揚大方、中央西路"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="chips" style={{ marginTop: 8 }}>
          {([["all", "全部"], ["p", "預售建案"], ["c", "社區"]] as const).map(([k, l]) => (
            <button key={k} className={`chip small ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
        <p className="note-box">社區沒有官方名稱，以代表門牌命名（例：中央西路二段250號等 3 棟）；預售建案用實價登錄的建案名稱。</p>
      </section>
      {err && <section className="note-box">搜尋資料載入失敗，請確認網路後再試。</section>}
      {!all && !err && <section className="skeleton" style={{ height: 120 }} />}
      {all && q.trim() && !results.length && <section className="note-box">找不到符合「{q}」的建案或社區。可以只打部分名稱，或用空白分隔關鍵字。</section>}
      {results.map(({ e }) => (
        <button key={e.id} className="result" onClick={() => onOpen(e)}>
          <span className="tag">{e.presale ? "預售建案" : "社區"}</span> <b>{e.name}</b>
          <small>
            {e.district} · {e.n.toLocaleString("zh-TW")} 筆成交 · 最近 {fmtYm(e.last)}
          </small>
        </button>
      ))}
    </PageShell>
  );
}
