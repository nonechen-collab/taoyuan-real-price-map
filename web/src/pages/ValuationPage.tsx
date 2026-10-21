/**
 * 估價助手：輸入位置、型態、坪數、屋齡、樓層、車位 → 自動挑近 24 個月、半徑 500 m、同型態、屋齡 ±5 年、坪數 ±20% 的
 * 買賣成交當比較案例（可逐筆剔除），算中位數與 P25–P75 合理區間。條件與剔除的案例寫在網址，分享出去打開會用最新資料重算。
 */
import { useEffect, useMemo, useState } from "react";
import { floorClass } from "../filters";
import { fmtDate, fmtDist, fmtPing, fmtTotal, fmtUnitShort } from "../format";
import { distance } from "../geo";
import { quantile } from "../stats";
import PageShell from "./PageShell";
import type { Community, LngLat, Meta, Tx } from "../types";

interface Props {
  meta: Meta;
  all: Tx[];
  comms: Community[];
  center: LngLat; // 預設位置：圓心或地圖中心
  oldReady: boolean; // 近 3 年資料是否已載入（24 個月需要更早那段）
  onNeedOld: () => void;
  onBack: () => void;
  onToast: (s: string) => void;
}

interface Query {
  lat: number;
  lon: number;
  bt: number;
  pg: number | null;
  age: number | null;
  fl: number | null;
  tf: number | null;
  pk: boolean;
}

const MONTHS = 24;
const RADII = [500, 1000];
const MIN_COMPS = 5;
const FLOOR_NAME = { l: "低樓層", m: "中樓層", h: "高樓層" } as const;

function readQuery(meta: Meta, center: LngLat): Query {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const v = (h.get("vq") ?? "").split(",");
  const n = (i: number) => (v[i] !== undefined && v[i] !== "" && Number.isFinite(Number(v[i])) ? Number(v[i]) : null);
  return {
    lat: n(0) ?? center[1],
    lon: n(1) ?? center[0],
    bt: n(2) ?? meta.defaultBtypes[0],
    pg: n(3),
    age: n(4),
    fl: n(5),
    tf: n(6),
    pk: v[7] === "1",
  };
}

const qStr = (q: Query) =>
  [q.lat.toFixed(5), q.lon.toFixed(5), q.bt, q.pg ?? "", q.age ?? "", q.fl ?? "", q.tf ?? "", q.pk ? 1 : 0].join(",");

function monthsBefore(yyyymmdd: number, months: number): number {
  let y = Math.floor(yyyymmdd / 10000);
  let m = Math.floor(yyyymmdd / 100) % 100 - months;
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return y * 10000 + m * 100 + (yyyymmdd % 100);
}

export default function ValuationPage({ meta, all, comms, center, oldReady, onNeedOld, onBack, onToast }: Props) {
  const [q, setQ] = useState<Query>(() => readQuery(meta, center));
  const [excluded, setExcluded] = useState<Set<string>>(() => {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return new Set((h.get("vx") ?? "").split(".").filter(Boolean));
  });

  useEffect(() => {
    if (!oldReady) onNeedOld();
  }, [oldReady, onNeedOld]);

  // 條件寫進網址（分享用）
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    h.set("vq", qStr(q));
    if (excluded.size) h.set("vx", [...excluded].join("."));
    else h.delete("vx");
    window.history.replaceState(window.history.state, "", `#${h.toString()}`);
  }, [q, excluded]);

  const latest = Number(meta.range.to.replaceAll("-", ""));
  const estBit = 1 << (meta.flags.find((f) => f.name === "車位未拆價")?.bit ?? 31);
  const res = useMemo(() => {
    const from = monthsBefore(latest, MONTHS);
    const here: LngLat = [q.lon, q.lat];
    const base = all
      .filter((t) => t.kind === 0 && t.up != null && t.lat != null && t.lon != null && t.date >= from && !(t.fx & meta.defaultExclude))
      .map((t) => ({ t, d: distance(here, [t.lon!, t.lat!]) }))
      .filter((x) => x.d <= RADII[RADII.length - 1]);
    const match = (x: { t: Tx; d: number }, r: number) =>
      x.d <= r &&
      x.t.bt === q.bt &&
      (q.age == null || (x.t.age != null && Math.abs(x.t.age - q.age) <= 5)) &&
      (q.pg == null || (x.t.pg != null && Math.abs(x.t.pg - q.pg) <= q.pg * 0.2));
    let radius = RADII[0];
    let comps = base.filter((x) => match(x, radius));
    if (comps.length < MIN_COMPS) {
      radius = RADII[1];
      comps = base.filter((x) => match(x, radius));
    }
    comps.sort((a, b) => a.d - b.d);
    const used = comps.filter((x) => !excluded.has(x.t.id));
    const ups = used.map((x) => x.t.up!);
    const mid = quantile(ups, 0.5);
    const lo = quantile(ups, 0.25);
    const hi = quantile(ups, 0.75);
    // 同樓層分類（依總樓層三等分）
    const subj = q.fl && q.tf ? floorClass({ fl: q.fl, tf: q.tf } as Tx) : null;
    const sameFloor = subj ? used.filter((x) => floorClass(x.t) === subj).map((x) => x.t.up!) : [];
    // 車位價：比較案例中單一車位、有拆價的中位數；不夠就用 1 km 內同期全部買賣
    const parkOf = (xs: { t: Tx }[]) => xs.filter((x) => x.t.pn === 1 && x.t.pp && !(x.t.fx & estBit)).map((x) => x.t.pp!);
    let parks = parkOf(used);
    if (parks.length < 3) parks = parkOf(base);
    const park = q.pk ? quantile(parks, 0.5) : null;
    return { comps, used, radius, mid, lo, hi, subj, sameFloor: sameFloor.length >= 3 ? quantile(sameFloor, 0.5) : null, nSame: sameFloor.length, park, nPark: parks.length };
  }, [all, q, excluded, latest, meta, estBit]);

  const total = (u: number | null) => (u == null || !q.pg ? null : u * q.pg + (res.park ?? 0));
  const set = (patch: Partial<Query>) => setQ((x) => ({ ...x, ...patch }));
  const numIn = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const useMine = () => {
    if (!navigator.geolocation) return onToast("這個瀏覽器不支援定位");
    onToast("定位中…");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        set({ lat: p.coords.latitude, lon: p.coords.longitude });
        onToast("已改用目前位置");
      },
      () => onToast("定位失敗，請確認已允許位置權限"),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: "比價頁｜桃園實價登錄地圖", url });
      else {
        await navigator.clipboard.writeText(url);
        onToast("已複製比價頁網址");
      }
    } catch {
      /* 使用者取消分享 */
    }
  };
  const toggle = (id: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const resBtypes = meta.defaultBtypes;

  return (
    <PageShell title="估價助手" sub={`近 ${MONTHS} 個月買賣成交當比較案例`} onBack={onBack}>
      <section>
        <h3>估價條件</h3>
        <div className="val-form">
          <div className="val-row">
            <span>位置</span>
            <span className="muted small">{q.lat.toFixed(5)}, {q.lon.toFixed(5)}</span>
          </div>
          <div className="chips">
            <button className="chip small" onClick={() => set({ lat: center[1], lon: center[0] })}>用地圖中心／圓心</button>
            <button className="chip small" onClick={useMine}>📍 用我的位置</button>
          </div>
          <label className="val-row">
            <span>建物型態</span>
            <select value={q.bt} onChange={(e) => set({ bt: Number(e.target.value) })}>
              {resBtypes.map((b) => <option key={b} value={b}>{meta.btypes[b]}</option>)}
            </select>
          </label>
          <label className="val-row">
            <span>權狀坪數（不含車位）</span>
            <input inputMode="decimal" placeholder="例：32" defaultValue={q.pg ?? ""} onChange={(e) => set({ pg: numIn(e.target.value) })} />
          </label>
          <label className="val-row">
            <span>屋齡（年）</span>
            <input inputMode="decimal" placeholder="例：8" defaultValue={q.age ?? ""} onChange={(e) => set({ age: numIn(e.target.value) })} />
          </label>
          <label className="val-row">
            <span>樓層／總樓層</span>
            <span className="val-pair">
              <input inputMode="numeric" placeholder="7" defaultValue={q.fl ?? ""} onChange={(e) => set({ fl: numIn(e.target.value) })} />
              ／
              <input inputMode="numeric" placeholder="15" defaultValue={q.tf ?? ""} onChange={(e) => set({ tf: numIn(e.target.value) })} />
            </span>
          </label>
          <label className="val-row switch">
            <input type="checkbox" checked={q.pk} onChange={(e) => set({ pk: e.target.checked })} />
            含一個車位
          </label>
        </div>
        {!oldReady && <p className="note-box">正在載入較早的成交（近 24 個月需要），比較案例可能還不完整…</p>}
      </section>

      <section>
        <h3>合理區間</h3>
        {res.used.length === 0 ? (
          <p className="note-box">附近 {RADII[1] / 1000} km 內近 {MONTHS} 個月沒有符合條件的買賣。可放寬坪數或屋齡（留空表示不限）。</p>
        ) : (
          <>
            <div className="tiles">
              <div className="tile">
                <b>{fmtUnitShort(res.mid)}<small> 萬/坪</small></b>
                <small>比較案例中位單價（{res.used.length} 件）</small>
              </div>
              <div className="tile">
                <b>{res.lo == null ? "—" : `${fmtUnitShort(res.lo)}–${fmtUnitShort(res.hi)}`}</b>
                <small>P25–P75（萬/坪）</small>
              </div>
              <div className="tile">
                <b>{q.pg ? fmtTotal(total(res.mid)) : "—"}</b>
                <small>{q.pg ? `估計總價（${fmtPing(q.pg)}${q.pk ? "＋車位" : ""}）` : "輸入坪數可算總價"}</small>
              </div>
              <div className="tile">
                <b>{q.pg && res.lo != null ? `${fmtTotal(total(res.lo))}–${fmtTotal(total(res.hi))}` : "—"}</b>
                <small>總價合理區間（P25–P75）</small>
              </div>
            </div>
            <p className="note-box">
              範圍 {res.radius >= 1000 ? `${res.radius / 1000} km` : `${res.radius} m`}
              {res.radius > RADII[0] ? `（500 m 內不到 ${MIN_COMPS} 件，自動放大）` : ""}；同型態
              {q.age != null ? `、屋齡 ${Math.max(0, q.age - 5)}–${q.age + 5} 年` : ""}
              {q.pg != null ? `、權狀 ${fmtPing(q.pg * 0.8)}–${fmtPing(q.pg * 1.2)}` : ""}；排除特殊交易、預售交屋。
              {q.pk && (res.park != null ? ` 車位價用 ${res.nPark} 筆單一車位成交的中位數 ${fmtTotal(res.park)}。` : " 附近沒有拆價的車位成交，總價未含車位。")}
              {res.subj && (res.sameFloor != null
                ? ` 同為${FLOOR_NAME[res.subj]}的 ${res.nSame} 件中位單價 ${fmtUnitShort(res.sameFloor)} 萬/坪。`
                : ` ${FLOOR_NAME[res.subj]}的比較案例不到 3 件，未另外計算。`)}
            </p>
            <div className="actions-row">
              <button className="action-btn" onClick={share}>🔗 分享比價頁</button>
            </div>
          </>
        )}
      </section>

      {res.comps.length > 0 && (
        <section>
          <h3>比較案例（{res.comps.length} 件，取消勾選即剔除）</h3>
          <div className="comp-list">
            {res.comps.map(({ t, d }) => {
              const on = !excluded.has(t.id);
              const c = t.cid >= 0 ? comms[t.cid] : undefined;
              return (
                <label key={t.id} className={`comp ${on ? "" : "off"}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(t.id)} />
                  <span className="comp-main">
                    <b>{fmtUnitShort(t.up)} 萬/坪</b> · {fmtTotal(t.tp)} · {fmtPing(t.pg)}
                    <small>
                      {fmtDate(t.date)} · {fmtDist(d)} · {t.fl ?? "—"}／{t.tf ?? "—"} 樓 · 屋齡 {t.age == null ? "—" : Math.round(t.age)} 年
                      {t.pn ? ` · 車位 ${fmtTotal(t.pp)}` : ""}
                    </small>
                    <small className="muted">{c ? c.name : t.addr}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      )}
    </PageShell>
  );
}
