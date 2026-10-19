import { fmtPing, fmtTotal, fmtUnitShort } from "../format";
import type { Summary } from "../stats";

export default function StatsCard({ s, loading }: { s: Summary; loading: boolean }) {
  if (loading && s.n === 0) {
    return (
      <div className="stats skeleton-row">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat skeleton" />
        ))}
      </div>
    );
  }
  return (
    <div className="stats">
      <div className="stat">
        <b>{s.n.toLocaleString("zh-TW")}</b>
        <small>件數</small>
      </div>
      <div className="stat main">
        <b>
          {fmtUnitShort(s.upMed)}
          <em> 萬/坪</em>
        </b>
        <small>
          單價中位數
          {s.upP25 != null && ` · ${fmtUnitShort(s.upP25)}–${fmtUnitShort(s.upP75)}`}
        </small>
      </div>
      <div className="stat">
        <b>{fmtTotal(s.tpMed)}</b>
        <small>總價中位</small>
      </div>
      <div className="stat">
        <b>{fmtPing(s.pgMed)}</b>
        <small>坪數中位</small>
      </div>
    </div>
  );
}
