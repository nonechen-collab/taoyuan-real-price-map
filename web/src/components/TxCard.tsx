import { memo, useEffect, useState } from "react";
import { loadDetail } from "../data";
import {
  fmtAge, fmtDate, fmtDist, fmtFloor, fmtLayout, fmtPct, fmtPing, fmtTotal, fmtUnit, fmtYm,
} from "../format";
import { colorClass } from "../stats";
import type { Community, Meta, Tx } from "../types";

interface Props {
  t: Tx;
  meta: Meta;
  community?: Community;
  dist?: number;
  breaks: number[];
  selected: boolean;
  onSelect: (t: Tx) => void;
  onCommunity: (cid: number) => void;
  dev?: number; // 偏離同社區中位數（≥ ±20% 才有）
  starred?: boolean;
  onStar?: (t: Tx) => void;
}

const HIDDEN_TAGS = new Set(["車位面積未拆", "單價估算"]);

function TxCard({ t, meta, community, dist, breaks, selected, onSelect, onCommunity, dev, starred, onStar }: Props) {
  const [open, setOpen] = useState(false);
  const flags = meta.flags.filter((f) => t.fx & (1 << f.bit));
  const estimated = flags.some((f) => f.name === "單價估算");
  const approx = meta.approxLevels.includes(t.geo);
  const cc = colorClass(t.up, breaks);
  const park = t.pn ? meta.parkTypes[t.pt] ?? "車位" : null;
  const parkUnpriced = flags.some((f) => f.name === "車位未拆價");

  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  return (
    <article className={`tx ${selected ? "selected" : ""}`} id={`tx-${t.i}`}>
      <button className="tx-main" onClick={() => onSelect(t)} aria-expanded={open}>
        <div className="tx-row tx-top">
          <span className="tx-date">{fmtYm(t.ym)}</span>
          {t.kind === 1 && <span className="tag presale">預售</span>}
          {flags
            .filter((f) => !HIDDEN_TAGS.has(f.name))
            .map((f) => (
              <span key={f.name} className={`tag ${f.exclude ? "warn" : ""}`}>
                {f.name}
              </span>
            ))}
          {dev !== undefined && (
            <span className={`tag ${dev > 0 ? "dev-hi" : "dev-lo"}`}>
              比社區中位 {dev > 0 ? "+" : "−"}{Math.round(Math.abs(dev) * 100)}%
            </span>
          )}
          {approx && <span className="tag">概略位置</span>}
          {t.lat == null && t.part !== "h" && <span className="tag warn">未定位</span>}
          {dist != null && <span className="tx-dist">{fmtDist(dist)}</span>}
        </div>
        <div className="tx-addr">{t.addr}</div>
        <div className="tx-row tx-price">
          <span className="tx-total">{fmtTotal(t.tp)}</span>
          <span className={`tx-unit ${cc >= 0 ? `pc${cc}` : ""}`}>
            {fmtUnit(t.up)}
            {estimated && <sup>估</sup>}
          </span>
        </div>
        <div className="tx-row tx-meta">
          <span>{fmtFloor(t.fl, t.tf)}</span>
          <span>{meta.btypes[t.bt]}</span>
          <span>{fmtAge(t.age, t.kind)}</span>
          <span>{fmtLayout(t.rm, t.hl, t.ba)}</span>
        </div>
        <div className="tx-row tx-meta">
          <span>權狀 {fmtPing(t.pg)}</span>
          {t.ip != null && <span>室內 {fmtPing(t.ip)}</span>}
          {t.pr != null && <span>公設 {fmtPct(t.pr)}</span>}
          {park && (
            <span>
              {park}
              {t.pn > 1 ? ` ×${t.pn}` : ""} {fmtTotal(t.pp)}
              {parkUnpriced ? "（估）" : ""}
            </span>
          )}
        </div>
      </button>
      <div className="tx-foot">
        {community ? (
          <button className="tx-comm" onClick={() => onCommunity(community.i)}>
            {community.presale ? "建案" : "社區"}：{community.name}
            {t.un ? ` · ${t.un}` : ""} ›
          </button>
        ) : (
          <span className="tx-comm muted">{t.un ?? ""}</span>
        )}
        {onStar && (
          <button className={`star ${starred ? "on" : ""}`} onClick={() => onStar(t)} aria-label={starred ? "取消收藏" : "收藏這筆"} aria-pressed={!!starred}>
            {starred ? "★" : "☆"}
          </button>
        )}
      </div>
      {open && <TxDetail t={t} meta={meta} />}
    </article>
  );
}

function TxDetail({ t, meta }: { t: Tx; meta: Meta }) {
  const [d, setD] = useState<Record<string, string> | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    loadDetail(meta, t)
      .then((r) => alive && setD(r))
      .catch(() => alive && setD(null));
    return () => {
      alive = false;
    };
  }, [meta, t]);
  return (
    <div className="tx-detail">
      <p className="formula">
        扣車位單價＝（總價 − 車位總價）÷（建物移轉面積 − 車位面積）；權狀坪不含車位；室內坪＝主建物；
        公設比＝（權狀 − 主建物 − 附屬建物 − 陽台）÷ 權狀。
        {t.fx & (1 << (meta.flags.find((f) => f.name === "單價估算")?.bit ?? 31)) ? " 本筆車位未拆價，扣除額為估算（依據見下方）。" : ""}
      </p>
      {d === undefined && <p className="muted">載入原始欄位…</p>}
      {d === null && (
        <p className="muted">
          {t.part === "h" ? "3 年前的成交只提供整理後的欄位（原始欄位檔只含近 3 年）。" : "原始欄位載入失敗（離線時只能看已開過的行政區）"}
        </p>
      )}
      {d && (
        <dl>
          <dt>交易日期</dt>
          <dd>{fmtDate(t.date)}</dd>
          <dt>編號</dt>
          <dd className="mono">{t.id}</dd>
          {Object.entries(d)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <FragmentRow key={k} k={k} v={v} />
            ))}
        </dl>
      )}
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={k.includes("門牌") || k.includes("鍵") ? "mono" : ""}>{v}</dd>
    </>
  );
}

export default memo(TxCard);
