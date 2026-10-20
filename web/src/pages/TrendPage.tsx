/**
 * 行情走勢：季中位數＋P25–P75 帶狀，下方另一張圖畫成交量（不共用 y 軸），最多疊加 4 個區域／社區／建案。
 * 系列顏色在加入時就固定（色彩跟著系列走，刪掉別的系列也不會換色）。
 */
import { useEffect, useMemo, useState } from "react";
import { BandChart, BarChart, ChartFrame, type BandSeries } from "../charts/Charts";
import { loadEntity, loadStats, type CommRegistry } from "../data";
import { forStats, quarterRange, quarterly, type QStat } from "../analysis";
import { fmtUnitShort } from "../format";
import { SERIES, type Mode } from "../palette";
import PageShell from "./PageShell";
import type { Meta, StatRow, Tx } from "../types";

export type TrendPick =
  | { type: "d"; name: string; slot: number } // 行政區或「桃園市」
  | { type: "e"; id: string; name: string; shard: number; presale: boolean; slot: number };

export const GROUPS = ["大樓華廈", "公寓", "透天", "套房", "預售"] as const;
const GROUP_BTYPES: Record<string, string[]> = { 大樓華廈: ["住宅大樓", "華廈"], 公寓: ["公寓"], 透天: ["透天"], 套房: ["套房"] };
export const MAX_PICKS = 4;
/** 實價登錄 2012/8/1 上路；更早的交易日期多為補登或打錯，筆數太少不畫 */
const TREND_START = "2012Q3";
/** 行政區每季至少幾件才畫（件數太少時中位數會亂跳，例如早期某季只有幾筆預售） */
const MIN_N = 10;

export function freeSlot(picks: TrendPick[]): number {
  for (let i = 0; i < MAX_PICKS; i++) if (!picks.some((p) => p.slot === i)) return i;
  return -1;
}

interface Props {
  meta: Meta;
  reg: CommRegistry;
  mode: Mode;
  picks: TrendPick[];
  setPicks: (p: TrendPick[]) => void;
  onBack: () => void;
  onOpenEntity: (id: string) => void;
}

export default function TrendPage({ meta, reg, mode, picks, setPicks, onBack, onOpenEntity }: Props) {
  const [group, setGroup] = useState<string>("大樓華廈");
  const [range, setRange] = useState<"all" | "5y" | "3y">("all");
  const [stats, setStats] = useState<StatRow[] | null>(null);
  const [ents, setEnts] = useState<Record<string, Tx[]>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadStats(meta).then(setStats).catch(() => setErr("季統計載入失敗"));
  }, [meta]);
  useEffect(() => {
    for (const p of picks) {
      if (p.type === "e" && !ents[p.id]) {
        loadEntity(meta, p.id, p.shard, reg)
          .then((e) => e && setEnts((m) => ({ ...m, [p.id]: e.txs })))
          .catch(() => setErr(`${p.name} 載入失敗`));
      }
    }
  }, [picks, meta, reg, ents]);

  // 各系列全部的季（成交量、表格用）；畫單價線時行政區再濾掉件數太少的季
  const series = useMemo(() => {
    const out: (BandSeries & { minN: number })[] = [];
    for (const p of [...picks].sort((a, b) => a.slot - b.slot)) {
      let values = new Map<string, QStat>();
      if (p.type === "d") {
        for (const r of stats ?? []) {
          if (r.district === p.name && r.group === group) values.set(r.quarter, { lo: r.p25, mid: r.p50, hi: r.p75, n: r.n });
        }
      } else {
        const txs = ents[p.id];
        if (txs) {
          const g = forStats(txs, meta).filter((t) =>
            group === "預售" ? t.kind === 1 : t.kind === 0 && (GROUP_BTYPES[group] ?? []).includes(meta.btypes[t.bt]),
          );
          values = quarterly(p.presale ? forStats(txs, meta).filter((t) => t.kind === 1) : g);
        }
      }
      out.push({ name: p.name, color: SERIES[mode][p.slot], values, minN: p.type === "d" ? MIN_N : 1 });
    }
    return out;
  }, [picks, stats, ents, group, meta, mode]);
  const priceSeries = useMemo<BandSeries[]>(
    () => series.map((s) => ({ name: s.name, color: s.color, values: new Map([...s.values].filter(([, v]) => v.n >= s.minN)) })),
    [series],
  );

  const xs = useMemo(() => {
    const qs = series.flatMap((s) => [...s.values.keys()]).filter((q) => q >= TREND_START).sort();
    if (!qs.length) return [];
    let from = qs[0];
    const to = qs[qs.length - 1];
    const y = Number(to.slice(0, 4));
    if (range === "5y") from = `${y - 5}Q${to.slice(5)}` > from ? `${y - 5}Q${to.slice(5)}` : from;
    if (range === "3y") from = `${y - 3}Q${to.slice(5)}` > from ? `${y - 3}Q${to.slice(5)}` : from;
    return quarterRange(from, to);
  }, [series, range]);

  const toggleDistrict = (name: string) => {
    if (picks.some((p) => p.type === "d" && p.name === name)) setPicks(picks.filter((p) => !(p.type === "d" && p.name === name)));
    else {
      const slot = freeSlot(picks);
      if (slot >= 0) setPicks([...picks, { type: "d", name, slot }]);
    }
  };
  const full = picks.length >= MAX_PICKS;
  const districts = ["桃園市", ...[...meta.districts].sort((a, b) => a.code.localeCompare(b.code)).map((d) => d.name)];
  const tableRows = [...xs].reverse().map((q) => [q, ...series.map((s) => {
    const v = s.values.get(q);
    return v ? `${fmtUnitShort(v.mid)}（${v.n}）` : "—";
  })]);

  return (
    <PageShell title="行情走勢" sub="季中位數＋P25–P75；排除特殊交易" onBack={onBack}>
      <section>
        <h3>比較對象（最多 {MAX_PICKS} 個）</h3>
        <div className="chips">
          {picks.filter((p) => p.type === "e").map((p) => (
            <span key={p.type === "e" ? p.id : ""} className="chip on" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i className="key line" style={{ background: SERIES[mode][p.slot] }} />
              <button className="link" onClick={() => p.type === "e" && onOpenEntity(p.id)}>{p.name}</button>
              <button className="link" aria-label={`移除 ${p.name}`} onClick={() => setPicks(picks.filter((x) => x !== p))}>✕</button>
            </span>
          ))}
          {districts.map((d) => {
            const on = picks.some((p) => p.type === "d" && p.name === d);
            const p = picks.find((x) => x.type === "d" && x.name === d);
            return (
              <button key={d} className={`chip small ${on ? "on" : ""}`} disabled={!on && full} onClick={() => toggleDistrict(d)}>
                {p && <i className="key line" style={{ background: SERIES[mode][p.slot] }} />}
                {d.replace(/區$/, "")}
              </button>
            );
          })}
        </div>
        <p className="note-box">社區、建案請到該社區頁或建案頁按「📈 加入走勢」。</p>
        <h3 style={{ marginTop: 10 }}>類別</h3>
        <div className="chips">
          {GROUPS.map((g) => (
            <button key={g} className={`chip small ${group === g ? "on" : ""}`} onClick={() => setGroup(g)}>{g}</button>
          ))}
        </div>
        <h3 style={{ marginTop: 10 }}>期間</h3>
        <div className="chips">
          {([["all", "全部（2012 起）"], ["5y", "近 5 年"], ["3y", "近 3 年"]] as const).map(([k, l]) => (
            <button key={k} className={`chip small ${range === k ? "on" : ""}`} onClick={() => setRange(k)}>{l}</button>
          ))}
        </div>
      </section>

      <section>
        {err && <p className="note-box">{err}</p>}
        {!picks.length ? (
          <p className="note-box">先選一個比較對象。</p>
        ) : !stats && picks.some((p) => p.type === "d") ? (
          <div className="skeleton" style={{ height: 240 }} />
        ) : (
          <>
            <ChartFrame
              title={`扣車位單價（萬/坪）· ${group}`}
              sub={`線＝季中位數，淡色帶＝P25–P75${picks.some((p) => p.type === "d") ? `；行政區該季不到 ${MIN_N} 件不畫` : ""}`}
              legend={series.length > 1 ? series.map((s) => ({ label: s.name, color: s.color, shape: "line" })) : undefined}
              table={{ head: ["季", ...series.map((s) => `${s.name} 中位（件）`)], rows: tableRows }}
            >
              <BandChart series={priceSeries} xs={xs} fmt={(v) => fmtUnitShort(v)} />
            </ChartFrame>
            <ChartFrame
              title="成交量（件／季）"
              sub="與上圖分開畫，避免兩種刻度擠在同一張圖"
              legend={series.length > 1 ? series.map((s) => ({ label: s.name, color: s.color, shape: "line" })) : undefined}
            >
              {series.length === 1 ? (
                <BarChart xs={xs} values={xs.map((q) => series[0].values.get(q)?.n ?? 0)} color={series[0].color} height={140} />
              ) : (
                <BandChart
                  height={150}
                  xs={xs}
                  fmt={(v) => `${Math.round(v)}`}
                  series={series.map((s) => ({
                    ...s,
                    values: new Map([...s.values].map(([q, v]) => [q, { lo: v.n, mid: v.n, hi: v.n, n: v.n }])),
                  }))}
                />
              )}
            </ChartFrame>
          </>
        )}
      </section>
    </PageShell>
  );
}
