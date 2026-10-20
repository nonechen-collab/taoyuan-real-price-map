/**
 * 社區頁／預售建案頁：2012 年起的全部成交、單價散布圖（點色＝樓層）、車位價、公設比；
 * 預售另有虛擬銷控表、樓層價差、每月成交戶數（去化）、解約件數。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { BarChart, ChartFrame, ScatterChart, type ScatterPoint } from "../charts/Charts";
import { loadEntity, type CommRegistry } from "../data";
import { ANOMALY, floorPremium, forStats, monthlyCounts, salesGrid, summary } from "../analysis";
import type { Favorites } from "../favorites";
import { floorClass } from "../filters";
import { fmtDate, fmtPct, fmtPing, fmtTotal, fmtUnit, fmtUnitShort, fmtYm } from "../format";
import { CHROME, FLOOR, SERIES, type Mode } from "../palette";
import { quantile, quantileBreaks, colorClass } from "../stats";
import TxCard from "../components/TxCard";
import NotesEditor from "./NotesEditor";
import PageShell from "./PageShell";
import type { Entity, Meta, Tx } from "../types";

interface Props {
  meta: Meta;
  reg: CommRegistry;
  id: string;
  shard: number | undefined;
  mode: Mode;
  breaks: number[];
  favs: Favorites;
  onBack: () => void;
  onOpenEntity: (id: string) => void;
  onShowOnMap: (e: Entity) => void;
  onAddTrend: (e: Entity) => void;
  onAddCompare: (e: Entity) => void;
  inTrend: boolean;
  inCompare: boolean;
}

const PAGE = 40;

export default function EntityPage(p: Props) {
  const { meta, mode } = p;
  const [ent, setEnt] = useState<Entity | null | undefined>(undefined);
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedFrom, setPickedFrom] = useState<"scatter" | "grid" | null>(null);
  const pick = (from: "scatter" | "grid") => (id: string) => {
    setPicked(id);
    setPickedFrom(from);
  };

  useEffect(() => {
    let alive = true;
    setEnt(undefined);
    setLimit(PAGE);
    if (p.shard === undefined) return; // 還在查是哪一份歷史檔
    if (p.shard < 0) {
      setEnt(null); // 搜尋索引也找不到
      return;
    }
    loadEntity(meta, p.id, p.shard, p.reg)
      .then((e) => alive && setEnt(e))
      .catch(() => alive && setEnt(null));
    return () => {
      alive = false;
    };
  }, [meta, p.id, p.shard, p.reg]);

  const cancelBit = useMemo(() => {
    const f = meta.flags.find((x) => x.name === "解約");
    return f ? 1 << f.bit : 0;
  }, [meta]);
  const estBit = useMemo(() => {
    const f = meta.flags.find((x) => x.name === "車位未拆價");
    return f ? 1 << f.bit : 0;
  }, [meta]);

  const calc = useMemo(() => {
    if (!ent) return null;
    const clean = forStats(ent.txs, meta);
    const split = Number(meta.split.replaceAll("-", ""));
    const from3 = Number(meta.range.from.replaceAll("-", ""));
    const recent = clean.filter((t) => t.date >= split);
    const last3 = clean.filter((t) => t.date >= from3);
    const ups = (txs: Tx[]) => txs.map((t) => t.up!) as number[];
    const ref = last3.length >= 4 ? quantile(ups(last3), 0.5) : clean.length >= 4 ? quantile(ups(clean), 0.5) : null;
    // 最近一年沒有成交時，改看資料中最後 12 個月
    let headTxs = recent;
    let headLabel = "近 12 月";
    if (!recent.length && clean.length) {
      const lastYm = Math.max(...clean.map((t) => t.ym));
      const cut = (Math.floor(lastYm / 100) - 1) * 100 + (lastYm % 100);
      headTxs = clean.filter((t) => t.ym > cut);
      headLabel = `${fmtYm(lastYm)} 前 12 月`;
    }
    const head = summary(ups(headTxs));
    // 車位：有實際拆價的（不含估算）
    const park = new Map<number, { p: number[]; a: number[] }>();
    for (const t of ent.txs) {
      if (t.pn !== 1 || t.pt < 0 || t.fx & estBit || t.pp === null || t.pp <= 0) continue;
      const g = park.get(t.pt) ?? { p: [], a: [] };
      g.p.push(t.pp);
      if (t.pa) g.a.push(t.pa);
      park.set(t.pt, g);
    }
    const prs = ent.txs.filter((t) => t.pr !== null && t.kind === 0).map((t) => t.pr!);
    const pr = ent.info.presale ? ent.info.pr : prs.length ? quantile(prs, 0.5) : null;
    const presale = ent.txs.filter((t) => t.kind === 1);
    const cancels = presale.filter((t) => t.fx & cancelBit).length;
    const sold = presale.filter((t) => !(t.fx & cancelBit));
    return {
      clean, ref, head, headLabel, park, pr, cancels, presale,
      grid: ent.info.presale ? salesGrid(presale, cancelBit) : null,
      premium: ent.info.presale ? floorPremium(forStats(sold, meta)) : null,
      monthly: ent.info.presale ? monthlyCounts(sold) : null,
      gridBreaks: quantileBreaks(ups(forStats(presale, meta))),
      first: ent.txs.length ? Math.min(...ent.txs.map((t) => t.date)) : 0,
      last: ent.txs.length ? Math.max(...ent.txs.map((t) => t.date)) : 0,
    };
  }, [ent, meta, cancelBit, estBit]);

  if (ent === undefined) {
    return (
      <PageShell title="載入中…" onBack={p.onBack}>
        <section className="skeleton" style={{ height: 160 }} />
        <section className="skeleton" style={{ height: 240 }} />
      </PageShell>
    );
  }
  if (!ent || !calc) {
    return (
      <PageShell title="找不到這個社區或建案" onBack={p.onBack}>
        <section>可能是資料已更新、代號改變。請回地圖重新點選，或用選單的「搜尋」找建案名稱。</section>
      </PageShell>
    );
  }

  const { info } = ent;
  const isP = info.presale;
  const favKey = `${isP ? "p" : "c"}:${info.id}`;
  const floorColors = FLOOR[mode];
  const floorName = { l: "低樓層", m: "中樓層", h: "高樓層" } as const;
  const points: ScatterPoint[] = calc.clean.map((t) => {
    const fc = floorClass(t);
    return {
      id: t.id,
      x: new Date(Math.floor(t.date / 10000), (Math.floor(t.date / 100) % 100) - 1, t.date % 100).getTime(),
      y: t.up!,
      color: fc ? floorColors[{ l: 0, m: 1, h: 2 }[fc]] : CHROME[mode].muted,
      lines: [fmtUnit(t.up), `${fmtDate(t.date)} · ${t.fl ?? "—"}／${t.tf ?? "—"} 樓`, `${fmtTotal(t.tp)} · ${fmtPing(t.pg)}`],
    };
  });
  const devOf = (t: Tx) => {
    if (calc.ref === null || t.up === null || t.fx & meta.defaultExclude) return undefined;
    const d = t.up / calc.ref - 1;
    return Math.abs(d) >= ANOMALY ? d : undefined;
  };
  const sorted = [...ent.txs].sort((a, b) => b.date - a.date);
  const linked = info.link ? p.reg.list[p.reg.byId.get(info.link) ?? -1] : undefined;
  // 點散布圖的點或銷控表的格子：在圖下方直接顯示那一筆，不用往下捲去找
  const pickedTx = picked ? ent.txs.find((t) => t.id === picked) : undefined;
  const pickedCard = (from: "scatter" | "grid") =>
    pickedTx && pickedFrom === from ? (
      <div className="picked">
        <TxCard
          t={pickedTx}
          meta={meta}
          breaks={p.breaks}
          selected={false}
          onSelect={() => {}}
          onCommunity={() => {}}
          dev={devOf(pickedTx)}
          starred={p.favs.isFav(`t:${pickedTx.id}`)}
          onStar={(x) => p.favs.toggle(txFav(x, info.name))}
        />
      </div>
    ) : null;

  return (
    <PageShell
      title={info.name}
      sub={`${isP ? "預售建案" : "社區"} · ${info.district}${calc.first ? ` · ${fmtYm(Math.floor(calc.first / 100))}–${fmtYm(Math.floor(calc.last / 100))}` : ""}`}
      onBack={p.onBack}
    >
      <section>
        <div className="facts">
          {info.built && <span>{info.built.slice(0, 4)} 年完工</span>}
          {info.floors && <span>{info.floors} 樓</span>}
          {info.buildings && info.buildings > 1 && <span>{info.buildings} 棟</span>}
          <span>{ent.txs.length.toLocaleString("zh-TW")} 筆成交（2012 年起）</span>
          {isP && info.level !== null && (
            <span>
              位置：
              {meta.approxLevels.includes(info.level)
                ? "概略位置（可能差數百公尺）"
                : info.link && info.level === 2
                  ? "交屋社區門牌"
                  : (meta.geoLevels[String(info.level)] ?? "—")}
            </span>
          )}
        </div>
        <div className="actions-row">
          <button
            className={`action-btn ${p.favs.isFav(favKey) ? "on" : ""}`}
            onClick={() => p.favs.toggle({ key: favKey, kind: isP ? "p" : "c", id: info.id, name: info.name, district: info.district, shard: info.shard, lat: info.lat, lon: info.lon })}
          >
            {p.favs.isFav(favKey) ? "★ 已收藏" : "☆ 收藏"}
          </button>
          {info.lat !== null && <button className="action-btn" onClick={() => p.onShowOnMap(ent)}>📍 在地圖上看</button>}
          <button className={`action-btn ${p.inTrend ? "on" : ""}`} onClick={() => p.onAddTrend(ent)}>📈 {p.inTrend ? "已加入走勢" : "加入走勢"}</button>
          {isP && <button className={`action-btn ${p.inCompare ? "on" : ""}`} onClick={() => p.onAddCompare(ent)}>⚖️ {p.inCompare ? "已加入比較" : "加入比較"}</button>}
        </div>
        <div className="tiles">
          <div className="tile">
            <b>{fmtUnitShort(calc.head.mid)}<small> 萬/坪</small></b>
            <small>{calc.headLabel}中位單價（{calc.head.n} 件）</small>
          </div>
          <div className="tile">
            <b>{calc.head.lo === null ? "—" : `${fmtUnitShort(calc.head.lo)}–${fmtUnitShort(calc.head.hi)}`}</b>
            <small>P25–P75（萬/坪）</small>
          </div>
          <div className="tile">
            <b>{fmtPct(calc.pr)}</b>
            <small>{isP ? "公設比（交屋後實際）" : "公設比中位"}</small>
          </div>
          {isP ? (
            <div className="tile">
              <b>{calc.cancels} 件</b>
              <small>解約（{calc.presale.length ? Math.round((calc.cancels / calc.presale.length) * 100) : 0}%）</small>
            </div>
          ) : (
            <div className="tile">
              <b>{calc.clean.length.toLocaleString("zh-TW")} 件</b>
              <small>進統計的成交（排除特殊交易）</small>
            </div>
          )}
        </div>
        {linked && (
          <button className="link-row" onClick={() => p.onOpenEntity(linked.id)}>
            交屋後社區：{linked.name} ›
          </button>
        )}
        {isP && !linked && <p className="note-box">還沒找到交屋後的買賣紀錄（以土地地號比對），所以沒有實際公設比；交屋後下次資料更新會自動補上。</p>}
      </section>

      <section>
        <ChartFrame
          title={isP ? "單價走勢" : "單價時間散布"}
          sub={`扣車位單價（萬/坪）；點色＝樓層；灰帶＝近 3 年中位數 ±${ANOMALY * 100}%，帶外為異常值`}
          legend={[
            { label: floorName.l, color: floorColors[0] },
            { label: floorName.m, color: floorColors[1] },
            { label: floorName.h, color: floorColors[2] },
          ]}
          table={{
            head: ["日期", "樓層", "單價", "總價"],
            rows: [...calc.clean].sort((a, b) => b.date - a.date).map((t) => [fmtDate(t.date), `${t.fl ?? "—"}／${t.tf ?? "—"}`, fmtUnitShort(t.up), fmtTotal(t.tp)]),
          }}
        >
          <ScatterChart
            points={points}
            reference={calc.ref !== null ? { mid: calc.ref, band: ANOMALY, label: `近 3 年中位 ${fmtUnitShort(calc.ref)}` } : undefined}
            onPick={pick("scatter")}
          />
        </ChartFrame>
        {pickedCard("scatter")}
      </section>

      {isP && calc.grid && (
        <section>
          <SalesGrid grid={calc.grid} breaks={calc.gridBreaks} picked={picked} onPick={pick("grid")} />
          {pickedCard("grid")}
        </section>
      )}
      {isP && !calc.grid && calc.presale.length > 0 && (
        <section className="note-box">這個建案的成交沒有「棟及號」（2021 年 7 月前的預售資料沒有這欄），無法排出銷控表。</section>
      )}

      {isP && calc.premium && (
        <section>
          <ChartFrame
            title={`樓層價差：每高一層 ${calc.premium.slope >= 0 ? "+" : "−"}${Math.abs(calc.premium.slope).toFixed(2)} 萬/坪`}
            sub={`2 樓以上、${calc.premium.n} 件成交的各樓層中位單價，加權迴歸`}
            table={{ head: ["樓層", "中位單價", "件數"], rows: calc.premium.points.map((x) => [x.floor, fmtUnitShort(x.med), x.n]) }}
          >
            <ScatterChart
              xKind="floor"
              height={200}
              points={calc.premium.points.map((x) => ({
                id: `f${x.floor}`, x: x.floor, y: x.med, color: SERIES[mode][0],
                lines: [`${fmtUnitShort(x.med)} 萬/坪`, `${x.floor} 樓 · ${x.n} 件`],
              }))}
              fit={{ slope: calc.premium.slope, intercept: calc.premium.intercept, color: SERIES[mode][1] }}
            />
          </ChartFrame>
        </section>
      )}

      {isP && calc.monthly && calc.monthly.months.length > 0 && (
        <section>
          <ChartFrame
            title="每月成交戶數（去化）"
            sub={`共 ${calc.monthly.counts.reduce((a, b) => a + b, 0)} 戶（不含解約）；預售依簽約月份`}
            table={{ head: ["月份", "戶數"], rows: calc.monthly.months.map((m, i) => [m, calc.monthly!.counts[i]]) }}
          >
            <BarChart xs={calc.monthly.months} values={calc.monthly.counts} color={SERIES[mode][0]} />
          </ChartFrame>
        </section>
      )}

      {calc.park.size > 0 && (
        <section>
          <h3>車位價（有拆價的成交）</h3>
          <table className="ptable">
            <thead>
              <tr><th>類別</th><th>件數</th><th>中位價</th><th>中位面積</th></tr>
            </thead>
            <tbody>
              {[...calc.park].sort((a, b) => b[1].p.length - a[1].p.length).map(([pt, g]) => (
                <tr key={pt}>
                  <td>{meta.parkTypes[pt]}</td>
                  <td>{g.p.length}</td>
                  <td>{fmtTotal(quantile(g.p, 0.5))}</td>
                  <td>{g.a.length ? fmtPing(quantile(g.a, 0.5)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {p.favs.isFav(favKey) && (
        <section>
          <h3>看屋筆記</h3>
          <NotesEditor fav={p.favs.favs.find((f) => f.key === favKey)!} setNote={p.favs.setNote} />
        </section>
      )}

      <section>
        <h3>全部成交（{sorted.length.toLocaleString("zh-TW")} 筆，新到舊）</h3>
        {sorted.slice(0, limit).map((t) => (
          <TxCard
            key={t.id}
            t={t}
            meta={meta}
            breaks={p.breaks}
            selected={picked === t.id}
            onSelect={() => setPicked(t.id)}
            onCommunity={() => {}}
            dev={devOf(t)}
            starred={p.favs.isFav(`t:${t.id}`)}
            onStar={(x) => p.favs.toggle(txFav(x, info.name))}
          />
        ))}
        {sorted.length > limit && (
          <button className="more" onClick={() => setLimit(limit + PAGE)}>再顯示 {Math.min(PAGE, sorted.length - limit)} 筆</button>
        )}
      </section>
    </PageShell>
  );
}

function SalesGrid({ grid, breaks, picked, onPick }: {
  grid: NonNullable<ReturnType<typeof salesGrid>>;
  breaks: number[];
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const cols = grid.cols;
  return (
    <ChartFrame
      title="虛擬銷控表"
      sub={`直欄＝棟／戶、橫列＝樓層；格內為扣車位單價（萬/坪），色＝建案內便宜→較貴；灰＝解約；空白＝尚無成交（${grid.parsed} 筆）`}
      legend={[
        { label: "較便宜", color: "var(--pc0)", shape: "rect" },
        { label: "居中", color: "var(--pc2)", shape: "rect" },
        { label: "較貴", color: "var(--pc4)", shape: "rect" },
        { label: "解約", color: "var(--cancel)", shape: "rect" },
      ]}
      table={{
        head: ["樓層", ...cols],
        rows: grid.floors.map((f) => [f, ...cols.map((c) => {
          const cell = grid.cells.get(`${c}|${f}`);
          return cell ? (cell.cancelled ? "解約" : fmtUnitShort(cell.tx.up)) : "";
        })]),
      }}
    >
      <div className="grid-wrap">
        <div className="sales-grid" style={{ gridTemplateColumns: `36px repeat(${cols.length}, minmax(40px, 1fr))` }}>
          <span />
          {cols.map((c) => <span key={c} className="gh">{c}</span>)}
          {grid.floors.map((f) => (
            <Fragment key={f}>
              <span className="fl">{f}F</span>
              {cols.map((c) => {
                const cell = grid.cells.get(`${c}|${f}`);
                if (!cell) return <span key={c} className="cell empty" />;
                const cc = colorClass(cell.tx.up, breaks);
                return (
                  <button
                    key={c}
                    className={`cell ${cell.cancelled ? "cancel" : cc >= 0 ? `pc${cc}` : ""} ${picked === cell.tx.id ? "sel" : ""}`}
                    onClick={() => onPick(cell.tx.id)}
                    aria-label={`${c} ${f} 樓 ${cell.cancelled ? "解約" : fmtUnit(cell.tx.up)}`}
                  >
                    {cell.cancelled ? "解約" : fmtUnitShort(cell.tx.up)}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}

export function txFav(t: Tx, place?: string) {
  return {
    key: `t:${t.id}`,
    kind: "t" as const,
    id: t.id,
    name: t.addr,
    district: t.district,
    lat: t.lat,
    lon: t.lon,
    sub: `${fmtYm(t.ym)} · ${fmtTotal(t.tp)} · ${fmtUnit(t.up)}${place ? ` · ${place}` : ""}`,
  };
}
