import { NOTE_FIELDS, type Fav, type NoteField } from "../favorites";

/** 看屋筆記：預設欄位（結構、防水、隔音、格局、售後服務、價格）＋其他；輸入即存在這支手機 */
export default function NotesEditor({ fav, setNote }: { fav: Fav; setNote: (key: string, f: NoteField, v: string) => void }) {
  const fields: NoteField[] = [...NOTE_FIELDS, "其他"];
  return (
    <div className="notes">
      {fields.map((f) => (
        <label key={f}>
          {f}
          <textarea
            value={fav.note[f] ?? ""}
            onChange={(e) => setNote(fav.key, f, e.target.value)}
            placeholder={f === "價格" ? "例：開價、議價空間、比較案例" : f === "其他" ? "其他觀察" : ""}
            rows={2}
          />
        </label>
      ))}
      {fav.noteAt && <p className="note-box">最後修改：{new Date(fav.noteAt).toLocaleString("zh-TW", { hour12: false })}（只存在這支手機，記得到收藏頁匯出備份）</p>}
    </div>
  );
}
