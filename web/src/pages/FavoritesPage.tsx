/** 收藏＋看屋筆記：存在這支手機；可匯出／匯入 JSON（換手機或備份用） */
import { useRef, useState } from "react";
import type { Fav, Favorites } from "../favorites";
import NotesEditor from "./NotesEditor";
import PageShell from "./PageShell";
import type { Meta } from "../types";

const KIND_NAME = { c: "社區", p: "預售建案", t: "成交" } as const;

interface Props {
  meta: Meta;
  favs: Favorites;
  onBack: () => void;
  onOpenEntity: (id: string, shard?: number) => void;
  onShowTx: (f: Fav) => void;
}

export default function FavoritesPage({ meta, favs, onBack, onOpenEntity, onShowTx }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const districtName = (d: string) => meta.districts.find((x) => x.code === d)?.name ?? d;

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = await favs.importJson(f);
      setMsg(`匯入完成：新增 ${r.added} 筆、更新筆記 ${r.updated} 筆`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "匯入失敗");
    }
    if (file.current) file.current.value = "";
  };

  return (
    <PageShell title="收藏與看屋筆記" sub={`${favs.favs.length} 筆 · 只存在這支手機`} onBack={onBack}>
      <section>
        <div className="actions-row">
          <button className="action-btn" onClick={favs.exportJson} disabled={!favs.favs.length}>⬇ 匯出備份（JSON）</button>
          <button className="action-btn" onClick={() => file.current?.click()}>⬆ 匯入備份</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => onImport(e.target.files?.[0])} />
        </div>
        {msg && <p className="note-box">{msg}</p>}
        {favs.saveError && <p className="note-box">⚠ 這個瀏覽器不允許儲存（可能是無痕模式），收藏關掉網頁就會消失。</p>}
        <p className="note-box">收藏與筆記只存在這支手機的瀏覽器；清除瀏覽器資料或換手機前，請先「匯出備份」。</p>
      </section>
      {!favs.favs.length && (
        <section className="note-box">還沒有收藏。在社區頁、建案頁按「☆ 收藏」，或在成交卡片右下角按 ☆。</section>
      )}
      {favs.favs.map((f) => (
        <div key={f.key} className="fav-item">
          <div className="row">
            <span className="tag">{KIND_NAME[f.kind]}</span>
            <b>{f.name}</b>
          </div>
          <div className="note-box">
            {f.kind === "t" ? districtName(f.district) : f.district}
            {f.sub ? ` · ${f.sub}` : ""}
            {Object.values(f.note).some(Boolean) ? " · 有筆記" : ""}
          </div>
          <div className="actions-row" style={{ marginBottom: 0 }}>
            {f.kind === "t" ? (
              <button className="action-btn" onClick={() => onShowTx(f)} disabled={f.lat == null}>📍 地圖上看</button>
            ) : (
              <button className="action-btn" onClick={() => onOpenEntity(f.id, f.shard)}>開啟{KIND_NAME[f.kind]}頁</button>
            )}
            <button className={`action-btn ${open === f.key ? "on" : ""}`} onClick={() => setOpen(open === f.key ? null : f.key)}>📝 筆記</button>
            <button className="action-btn" onClick={() => favs.remove(f.key)}>移除</button>
          </div>
          {open === f.key && <NotesEditor fav={f} setNote={favs.setNote} />}
        </div>
      ))}
    </PageShell>
  );
}
