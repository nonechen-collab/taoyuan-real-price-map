import { memo } from "react";
import { fmtDist, fmtFloor, fmtLayout, fmtPing, fmtYm } from "../format";
import { fmtRent, fmtRu, fmtYield, type RentSummary } from "../rent";
import { colorClass } from "../stats";
import type { Community, Meta, Rent } from "../types";

interface Props {
  r: Rent;
  meta: Meta;
  community?: Community;
  dist?: number;
  breaks: number[];
  selected: boolean;
  onSelect: (r: Rent) => void;
  onCommunity: (cid: number) => void;
}

/** 一筆租約：月租、每坪月租、出租型態與附設 */
function RentCard({ r, meta, community, dist, breaks, selected, onSelect, onCommunity }: Props) {
  const rm = meta.rent!;
  const flags = rm.flags.filter((f) => r.fx & (1 << f.bit) && f.name !== "非整層");
  const cc = colorClass(r.ru, breaks);
  const extras = [r.fu === 1 ? "附傢俱" : null, r.mg === 1 ? "有管理員" : null, r.el === 1 ? "有電梯" : null].filter(Boolean);
  return (
    <article className={`tx ${selected ? "selected" : ""}`} id={`tx-${r.i}`}>
      <button className="tx-main" onClick={() => onSelect(r)}>
        <div className="tx-row tx-top">
          <span className="tx-date">{fmtYm(r.ym)}</span>
          <span className="tag rent">{r.rt >= 0 ? rm.types[r.rt] : "租賃"}</span>
          {flags.map((f) => (
            <span key={f.name} className={`tag ${f.exclude ? "warn" : ""}`}>{f.name}</span>
          ))}
          {meta.approxLevels.includes(r.geo) && <span className="tag">概略位置</span>}
          {r.lat == null && <span className="tag warn">未定位</span>}
          {dist != null && <span className="tx-dist">{fmtDist(dist)}</span>}
        </div>
        <div className="tx-addr">{r.addr}</div>
        <div className="tx-row tx-price">
          <span className="tx-total">{fmtRent(r.rent)}/月</span>
          <span className={`tx-unit ${cc >= 0 ? `pc${cc}` : ""}`}>{fmtRu(r.ru)} 元/坪</span>
        </div>
        <div className="tx-row tx-meta">
          <span>{fmtFloor(r.fl, r.tf)}</span>
          <span>{meta.btypes[r.bt]}</span>
          {r.age != null && <span>屋齡 {Math.round(r.age)} 年</span>}
          <span>{fmtLayout(r.rm, r.hl, r.ba)}</span>
        </div>
        <div className="tx-row tx-meta">
          <span>{fmtPing(r.pg)}</span>
          {extras.map((x) => <span key={x}>{x}</span>)}
          {r.pt >= 0 && <span>{meta.parkTypes[r.pt]}{r.pp ? ` ${fmtRent(r.pp)}/月` : ""}</span>}
          {r.sv >= 0 && <span>{rm.services[r.sv]}</span>}
        </div>
      </button>
      {community && (
        <div className="tx-foot">
          <button className="tx-comm" onClick={() => onCommunity(community.i)}>社區：{community.name} ›</button>
        </div>
      )}
    </article>
  );
}

export default memo(RentCard);

/** 租賃統計卡：件數、每坪月租中位、月租中位、毛租金報酬率 */
export function RentStats({ s, yld, nSale, loading }: { s: RentSummary; yld: number | null; nSale: number; loading: boolean }) {
  if (loading && s.n === 0) {
    return (
      <div className="stats skeleton-row">
        {[0, 1, 2, 3].map((i) => <div key={i} className="stat skeleton" />)}
      </div>
    );
  }
  return (
    <div className="stats">
      <div className="stat">
        <b>{s.n.toLocaleString("zh-TW")}</b>
        <small>租約數</small>
      </div>
      <div className="stat main">
        <b>
          {fmtRu(s.ruMed)}
          <em> 元/坪</em>
        </b>
        <small>
          每坪月租中位{s.ruP25 != null && ` · ${fmtRu(s.ruP25)}–${fmtRu(s.ruP75)}`}
        </small>
      </div>
      <div className="stat">
        <b>{fmtRent(s.rentMed)}</b>
        <small>月租中位</small>
      </div>
      <div className="stat" title={`整層住家 ${s.nWhole} 筆、買賣 ${nSale} 筆`}>
        <b>{fmtYield(yld)}</b>
        <small>{yld == null ? "報酬率（樣本不足）" : `毛租金報酬率（${s.nWhole}／${nSale}）`}</small>
      </div>
    </div>
  );
}
