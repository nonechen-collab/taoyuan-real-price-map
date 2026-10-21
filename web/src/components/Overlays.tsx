import { fmtRoc, fmtUnitShort } from "../format";
import { FLOOD_COLORS, type Basemap } from "../map/MapView";
import type { Meta } from "../types";

export function Legend({ breaks, mode, onMode, unit = "萬/坪", fmt = fmtUnitShort }: {
  breaks: number[]; mode: "q" | "f"; onMode: (m: "q" | "f") => void; unit?: string; fmt?: (v: number) => string;
}) {
  // 色塊用 CSS 變數（深淺模式各一套），見 src/palette.ts
  const labels = [
    `< ${fmt(breaks[0])}`,
    ...breaks.slice(0, -1).map((b, i) => `${fmt(b)}–${fmt(breaks[i + 1])}`),
    `≥ ${fmt(breaks[breaks.length - 1])}`,
  ];
  return (
    <button className="legend" onClick={() => onMode(mode === "q" ? "f" : "q")} title="切換色階方式">
      <span className="legend-title">{unit} · {mode === "q" ? "範圍分位數" : "固定級距"}</span>
      <span className="legend-row">
        {labels.map((l, i) => (
          <span key={i} className="legend-item">
            <i className={`pc${i}`} />
            {l}
          </span>
        ))}
      </span>
    </button>
  );
}

export interface LayerState {
  liq: string | null; // 土壤液化潛勢圖層代碼
  flood: string | null; // 淹水潛勢情境
  st: boolean; // 車站
  sc: boolean; // 學校
  pk: boolean; // 公園
}
export const NO_LAYERS: LayerState = { liq: null, flood: null, st: false, sc: false, pk: false };

export function LayerMenu({ basemap, village, onBasemap, onVillage, meta, layers, onLayers, onClose }: {
  basemap: Basemap; village: boolean; onBasemap: (b: Basemap) => void; onVillage: (v: boolean) => void;
  meta: Meta | null; layers: LayerState; onLayers: (l: LayerState) => void; onClose: () => void;
}) {
  const opts: [Basemap, string][] = [["emap", "電子地圖"], ["gray", "灰階地圖"], ["photo", "正射影像"]];
  const lm = meta?.layers;
  const flood = lm?.flood.find((f) => f.key === layers.flood);
  return (
    <div className="popover layer-menu" role="dialog" aria-label="圖層">
      <div className="popover-head">
        <b>底圖</b>
        <button className="icon-btn small" onClick={onClose} aria-label="關閉">✕</button>
      </div>
      <div className="chips">
        {opts.map(([k, label]) => (
          <button key={k} className={`chip ${basemap === k ? "on" : ""}`} onClick={() => onBasemap(k)}>{label}</button>
        ))}
      </div>
      <label className="switch">
        <input type="checkbox" checked={village} onChange={(e) => onVillage(e.target.checked)} />
        顯示村里界
      </label>
      {lm && (
        <>
          <b className="layer-h">生活機能</b>
          <div className="chips">
            {lm.poi && (
              <>
                <button className={`chip small ${layers.st ? "on" : ""}`} onClick={() => onLayers({ ...layers, st: !layers.st })}>🚉 車站</button>
                <button className={`chip small ${layers.sc ? "on" : ""}`} onClick={() => onLayers({ ...layers, sc: !layers.sc })}>🏫 學校</button>
                <button className={`chip small ${layers.pk ? "on" : ""}`} onClick={() => onLayers({ ...layers, pk: !layers.pk })}>🌳 公園</button>
              </>
            )}
          </div>
          {layers.st && <p className="layer-note">機場捷運紫、台鐵黑、高鐵橘、捷運綠線綠（黃框＝興建中）</p>}
          <b className="layer-h">土壤液化潛勢</b>
          <div className="chips">
            <button className={`chip small ${!layers.liq ? "on" : ""}`} onClick={() => onLayers({ ...layers, liq: null })}>關</button>
            {lm.liquefaction.map((l) => (
              <button key={l.key} className={`chip small ${layers.liq === l.key ? "on" : ""}`} onClick={() => onLayers({ ...layers, liq: l.key })}>{l.label}</button>
            ))}
          </div>
          {layers.liq && <p className="layer-note">綠＝低、黃＝中、紅＝高潛勢；空白處是沒有列入潛勢區，不代表沒有風險。來源：國土測繪中心、地質調查及礦業管理中心</p>}
          <b className="layer-h">淹水潛勢</b>
          <div className="chips">
            <button className={`chip small ${!layers.flood ? "on" : ""}`} onClick={() => onLayers({ ...layers, flood: null })}>關</button>
            {lm.flood.map((f) => (
              <button key={f.key} className={`chip small ${layers.flood === f.key ? "on" : ""}`} onClick={() => onLayers({ ...layers, flood: f.key })}>{f.label}</button>
            ))}
          </div>
          {flood && (
            <>
              <div className="flood-legend">
                {flood.classes.map((c, i) => (
                  <span key={c}><i style={{ background: FLOOD_COLORS[i] }} />{c}</span>
                ))}
              </div>
              <p className="layer-note">降雨 {flood.label} 時可能的淹水深度（未滿 0.3 m 不畫）。模擬圖資，僅供參考。來源：桃園市政府水務局第三代淹水潛勢圖</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function About({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const gen = new Date(meta.generated);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer about" role="dialog" aria-label="資料說明" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>資料說明</h2>
          <button className="icon-btn small" onClick={onClose} aria-label="關閉">✕</button>
        </header>
        <div className="drawer-body">
          <h3>資料期別</h3>
          <p>
            最新一期：{meta.latest ? `買賣登記至民國 ${fmtRoc(meta.latest.saleTo)}、預售交易至 ${fmtRoc(meta.latest.presaleTo)}` : "—"}
            <br />
            資料更新：{gen.toLocaleString("zh-TW", { hour12: false })}
            <br />
            範圍：{meta.range.from} 起的成交，共 {meta.counts.total.toLocaleString("zh-TW")} 筆（買賣 {meta.counts.a.toLocaleString("zh-TW")}、預售{" "}
            {meta.counts.b.toLocaleString("zh-TW")}），已定位 {Math.round((meta.counts.located / meta.counts.total) * 100)}%
          </p>
          <h3>計算方式</h3>
          <ul>
            <li>扣車位單價＝（總價 − 車位總價）÷（建物移轉面積 − 車位面積）；車位有拆價時與官方單價相同</li>
            <li>車位未拆價：用同社區（不足則同區、全市）、同車位類別、前後 1 年車位中位價估算扣除，標「估」</li>
            <li>室內坪＝主建物；公設比＝（權狀 − 主建物 − 附屬建物 − 陽台）÷ 權狀（權狀皆不含車位）</li>
            <li>統計一律用中位數；預設排除特殊交易、解約、整棟、多棟，以及買賣表中的預售交屋紀錄（簽約價，避免與預售表重複）</li>
            <li>社區為推定：同一棟門牌，或 80 m 內建築完成年月與總樓層數相同者合併；預售以建案名稱為單位</li>
            <li>位置：桃園市門牌坐標比對；預售建案多為路口推算或路段中心，標「概略位置」者誤差可能數百公尺</li>
            <li>租賃（近 3 年）：每坪月租＝（月租 − 車位租金）÷ 坪數；預設排除社會住宅包租代管（租金約市價 8 折）、親友、租金異常</li>
            <li>毛租金報酬率＝同範圍整層住家每坪月租中位數 × 12 ÷ 同範圍買賣（不含預售）扣車位單價中位數；任一邊不到 5 件不算</li>
          </ul>
          <h3>資料來源與授權</h3>
          <ul>
            {meta.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="muted">本網站為個人自用的非官方整理，數字以內政部實價登錄網站為準。</p>
        </div>
      </div>
    </div>
  );
}
