/**
 * 比較表：(1) 目前範圍內 預售 vs 新成屋（屋齡 ≤ 5 年）vs 中古屋 的單價差；
 * (2) 多建案並排：中位單價、車位價、公設比、成交量、解約率、樓層價差。
 */
import { useEffect, useMemo, useState } from "react";
import { loadEntity, type CommRegistry } from "../data";
import { floorPremium, forStats, summary } from "../analysis";
import { fmtPct, fmtTotal, fmtUnitShort, fmtYm } from "../format";
import { quantile } from "../stats";
import PageShell from "./PageShell";
import type { Entity, Meta, Tx } from "../types";

export interface ComparePick {
  id: string;
  name: string;
  shard: number;
}
export const MAX_COMPARE = 6;

interface Props {
  meta: Meta;
  reg: CommRegistry;
  base: Tx[]; // 目前範圍內、套用篩選（但不限類別與屋齡）的成交
  scopeLabel: string;
  picks: ComparePick[];
  setPicks: (p: ComparePick[]) => void;
  onBack: () => void;
  onOpenEntity: (id: string) => void;
}

export default function ComparePage({ meta, reg, base, scopeLabel, picks, setPicks, onBack, onOpenEntity }: Props) {
  // undefined＝載入中；null＝找不到（資料更新後代號變了）或載入失敗
  const [ents, setEnts] = useState<Record<string, Entity | null>>({});
  useEffect(() => {
    for (const p of picks) {
      if (!(p.id in ents)) {
        loadEntity(meta, p.id, p.shard, reg)
          .then((e) => setEnts((m) => ({ ...m, [p.id]: e })))
          .catch(() => setEnts((m) => ({ ...m, [p.id]: null })));
      }
    }
  }, [picks, meta, reg, ents]);

  const groups = useMemo(() => {
    const ok = base.filter((t) => t.up !== null);
    const pre = ok.filter((t) => t.kind === 1);
    const fresh = ok.filter((t) => t.kind === 0 && t.age !== null && t.age <= 5);
    const old = ok.filter((t) => t.kind === 0 && t.age !== null && t.age > 5);
    const s = (x: Tx[]) => summary(x.map((t) => t.up!));
    return [
      { name: "預售屋", ...s(pre) },
      { name: "新成屋（屋齡 ≤ 5 年）", ...s(fresh) },
      { name: "中古屋（屋齡 > 5 年）", ...s(old) },
    ];
  }, [base]);
  const oldMid = groups[2].mid;

  const cancelBit = 1 << (meta.flags.find((f) => f.name === "解約")?.bit ?? 31);
  const estBit = 1 << (meta.flags.find((f) => f.name === "車位未拆價")?.bit ?? 31);
  const split = Number(meta.split.replaceAll("-", ""));
  const cols = picks.map((p) => {
    const e = ents[p.id];
    if (!e) return { p, e: null as Entity | null };
    const presale = e.txs.filter((t) => t.kind === 1);
    const sold = presale.filter((t) => !(t.fx & cancelBit));
    const clean = forStats(sold, meta);
    const all = summary(clean.map((t) => t.up!));
    const recent = summary(clean.filter((t) => t.date >= split).map((t) => t.up!));
    const parks = presale.filter((t) => t.pn === 1 && t.pp && !(t.fx & estBit)).map((t) => t.pp!);
    const fp = floorPremium(clean);
    const yms = presale.map((t) => t.ym);
    return {
      p, e,
      rows: [
        e.info.district,
        yms.length ? `${fmtYm(Math.min(...yms))}–${fmtYm(Math.max(...yms))}` : "—",
        `${sold.length} 戶`,
        fmtUnitShort(all.mid),
        recent.n ? fmtUnitShort(recent.mid) : "—",
        all.lo === null ? "—" : `${fmtUnitShort(all.lo)}–${fmtUnitShort(all.hi)}`,
        parks.length ? fmtTotal(quantile(parks, 0.5)) : "—",
        fmtPct(e.info.pr),
        presale.length ? `${Math.round(((presale.length - sold.length) / presale.length) * 100)}%` : "—",
        fp ? `${fp.slope >= 0 ? "+" : "−"}${Math.abs(fp.slope).toFixed(2)}` : "—",
      ],
    };
  });
  const rowNames = ["行政區", "成交期間", "成交量（不含解約）", "中位單價（萬/坪）", "近 12 月中位", "P25–P75", "車位價中位", "公設比（交屋後）", "解約率", "每層加價（萬/坪）"];

  return (
    <PageShell title="比較表" sub={scopeLabel} onBack={onBack}>
      <section>
        <h3>預售 vs 新成屋 vs 中古屋</h3>
        <p className="note-box">範圍：{scopeLabel}（套用目前篩選，但不限類別與屋齡）。統計用扣車位單價中位數。</p>
        <div className="table-scroll">
          <table className="ptable">
            <thead>
              <tr><th>類別</th><th>件數</th><th>中位單價</th><th>P25–P75</th><th>比中古屋</th></tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.name}>
                  <td>{g.name}</td>
                  <td>{g.n.toLocaleString("zh-TW")}</td>
                  <td>{fmtUnitShort(g.mid)}</td>
                  <td>{g.lo === null ? "—" : `${fmtUnitShort(g.lo)}–${fmtUnitShort(g.hi)}`}</td>
                  <td>{g.mid !== null && oldMid ? `${g.mid >= oldMid ? "+" : "−"}${Math.round(Math.abs(g.mid / oldMid - 1) * 100)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {groups.some((g) => g.n > 0 && g.n < 10) && <p className="note-box">件數少於 10 的類別，中位數容易受個案影響，請放大範圍再看。</p>}
      </section>

      <section>
        <h3>多建案並排（{picks.length}／{MAX_COMPARE}）</h3>
        {!picks.length ? (
          <p className="note-box">到預售建案頁按「⚖️ 加入比較」，最多 {MAX_COMPARE} 個。</p>
        ) : (
          <div className="table-scroll">
            <table className="ptable">
              <thead>
                <tr>
                  <th>項目</th>
                  {cols.map(({ p }) => (
                    <th key={p.id}>
                      <button className="link" onClick={() => onOpenEntity(p.id)}>{p.name}</button>{" "}
                      <button className="link" aria-label={`移除 ${p.name}`} onClick={() => setPicks(picks.filter((x) => x.id !== p.id))}>✕</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowNames.map((name, i) => (
                  <tr key={name}>
                    <td>{name}</td>
                    {cols.map((c) => (
                      <td key={c.p.id}>{"rows" in c && c.rows ? c.rows[i] : c.p.id in ents ? (i === 0 ? "找不到，請移除後重新加入" : "") : "載入中…"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note-box">公設比取交屋後的實際買賣紀錄（以土地地號連結）；還沒交屋的建案顯示「—」。每層加價為 2 樓以上各樓層中位單價的加權迴歸。</p>
      </section>
    </PageShell>
  );
}
