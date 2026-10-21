import { useState, type ReactNode } from "react";
import { PERIOD_LABEL, type Filters, type FloorClass, type Period } from "../filters";
import type { Meta } from "../types";

interface Props {
  meta: Meta;
  value: Filters;
  defaults: Filters;
  count: number;
  rentMode?: boolean; // 租賃模式：只套用期間、行政區、型態、房數、坪數
  onChange: (f: Filters) => void;
  onClose: () => void;
}

/** 切換選項並保持排序（網址與「已改幾項」才不會因順序不同而誤判） */
function toggle<T extends string | number>(arr: T[], v: T): T[] {
  const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  return next.sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
}

function Chip({ on, children, onClick }: { on: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <fieldset className="fgroup">
      <legend>
        {title}
        {hint && <small> {hint}</small>}
      </legend>
      <div className="chips">{children}</div>
    </fieldset>
  );
}

function Range({ lo, hi, unit, onLo, onHi, step = 1 }: {
  lo: number | null; hi: number | null; unit: string; step?: number;
  onLo: (v: number | null) => void; onHi: (v: number | null) => void;
}) {
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <div className="range">
      <input type="number" inputMode="decimal" step={step} placeholder="不限" value={lo ?? ""} onChange={(e) => onLo(parse(e.target.value))} />
      <span>–</span>
      <input type="number" inputMode="decimal" step={step} placeholder="不限" value={hi ?? ""} onChange={(e) => onHi(parse(e.target.value))} />
      <span className="unit">{unit}</span>
    </div>
  );
}

const FLOORS: [FloorClass, string][] = [["l", "低樓層"], ["m", "中樓層"], ["h", "高樓層"]];
const AGE_PRESETS: [string, number | null, number | null][] = [
  ["不限", null, null], ["5 年內", null, 5], ["5–10 年", 5, 10], ["10–20 年", 10, 20], ["20–30 年", 20, 30], ["30 年以上", 30, null],
];

export default function FilterDrawer({ meta, value, defaults, count, rentMode, onChange, onClose }: Props) {
  const [f, setF] = useState(value);
  const set = (patch: Partial<Filters>) => {
    const next = { ...f, ...patch };
    setF(next);
    onChange(next);
  };
  const districts = [...meta.districts].sort((a, b) => a.code.localeCompare(b.code));

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-label="篩選" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>篩選</h2>
          <button className="link" onClick={() => { setF(defaults); onChange(defaults); }}>全部重設</button>
        </header>
        <div className="drawer-body">
          {rentMode && <p className="note-box">租賃模式只套用：期間、行政區、建物型態、房數、坪數，以及「排除特殊交易」（社宅包租代管、親友、租金異常）。</p>}
          <Group title="類別">
            <Chip on={f.kinds.includes(0)} onClick={() => set({ kinds: toggle(f.kinds, 0) })}>買賣</Chip>
            <Chip on={f.kinds.includes(1)} onClick={() => set({ kinds: toggle(f.kinds, 1) })}>預售屋</Chip>
          </Group>
          <Group title="期間" hint="（以資料最新成交日回推）">
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <Chip key={p} on={f.period === p} onClick={() => set({ period: p })}>{PERIOD_LABEL[p]}</Chip>
            ))}
            {f.period === "custom" && (
              <div className="range">
                <input type="month" value={ymToInput(f.from)} onChange={(e) => set({ from: inputToYm(e.target.value) })} />
                <span>–</span>
                <input type="month" value={ymToInput(f.to)} onChange={(e) => set({ to: inputToYm(e.target.value) })} />
              </div>
            )}
          </Group>
          <Group title="行政區" hint="（不選＝全部）">
            {districts.map((d) => (
              <Chip key={d.code} on={f.districts.includes(d.code)} onClick={() => set({ districts: toggle(f.districts, d.code) })}>
                {d.name.replace("區", "")}
              </Chip>
            ))}
          </Group>
          <Group title="建物型態">
            {meta.btypes.map((b, i) => (
              <Chip key={b} on={f.btypes.includes(i)} onClick={() => set({ btypes: toggle(f.btypes, i) })}>{b}</Chip>
            ))}
          </Group>
          <Group title="屋齡" hint="（預售屋算 0 年）">
            {AGE_PRESETS.map(([label, lo, hi]) => (
              <Chip key={label} on={f.ageMin === lo && f.ageMax === hi} onClick={() => set({ ageMin: lo, ageMax: hi })}>{label}</Chip>
            ))}
          </Group>
          <Group title="房數">
            {[1, 2, 3, 4].map((r) => (
              <Chip key={r} on={f.rooms.includes(r)} onClick={() => set({ rooms: toggle(f.rooms, r) })}>{r === 4 ? "4 房以上" : `${r} 房`}</Chip>
            ))}
          </Group>
          <Group title="總價">
            <Range lo={f.tpMin} hi={f.tpMax} unit="萬" step={50} onLo={(v) => set({ tpMin: v })} onHi={(v) => set({ tpMax: v })} />
          </Group>
          <Group title="扣車位單價">
            <Range lo={f.upMin} hi={f.upMax} unit="萬/坪" step={0.5} onLo={(v) => set({ upMin: v })} onHi={(v) => set({ upMax: v })} />
          </Group>
          <Group title="坪數">
            <Chip on={f.pgMode === "p"} onClick={() => set({ pgMode: "p" })}>權狀（不含車位）</Chip>
            <Chip on={f.pgMode === "i"} onClick={() => set({ pgMode: "i" })}>室內（主建物）</Chip>
            <Range lo={f.pgMin} hi={f.pgMax} unit="坪" onLo={(v) => set({ pgMin: v })} onHi={(v) => set({ pgMax: v })} />
          </Group>
          <Group title="樓層" hint="（依總樓層三等分）">
            {FLOORS.map(([k, label]) => (
              <Chip key={k} on={f.floors.includes(k)} onClick={() => set({ floors: toggle(f.floors, k) })}>{label}</Chip>
            ))}
          </Group>
          <Group title="電梯">
            {([["", "不限"], ["1", "有"], ["0", "無"]] as const).map(([v, label]) => (
              <Chip key={v} on={f.elevator === v} onClick={() => set({ elevator: v })}>{label}</Chip>
            ))}
          </Group>
          <Group title="車位">
            {([["", "不限"], ["1", "有車位"], ["0", "無車位"]] as const).map(([v, label]) => (
              <Chip key={v} on={f.park === v} onClick={() => set({ park: v, parkKind: v === "0" ? "" : f.parkKind })}>{label}</Chip>
            ))}
            {f.park !== "0" &&
              ([["", "不限類型"], ["平面", "坡平／平面"], ["機械", "機械"]] as const).map(([v, label]) => (
                <Chip key={v} on={f.parkKind === v} onClick={() => set({ parkKind: v })}>{label}</Chip>
              ))}
          </Group>
          <Group title="排除">
            <Chip on={f.exSpecial} onClick={() => set({ exSpecial: !f.exSpecial })}>排除特殊交易</Chip>
            <Chip on={f.exCancel} onClick={() => set({ exCancel: !f.exCancel })}>排除解約</Chip>
          </Group>
          <p className="hint">
            特殊交易（預設排除）：
            {meta.flags.filter((x) => x.exclude && x.name !== "解約").map((x) => x.name).join("、")}。
            只標示不排除：{meta.flags.filter((x) => !x.exclude && x.source === "備註").map((x) => x.name).join("、")}。
          </p>
        </div>
        <footer className="drawer-foot">
          <button className="primary" onClick={onClose}>顯示 {count.toLocaleString("zh-TW")} 筆</button>
        </footer>
      </div>
    </div>
  );
}

function ymToInput(ym: number | null) {
  return ym ? `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, "0")}` : "";
}
function inputToYm(s: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}
