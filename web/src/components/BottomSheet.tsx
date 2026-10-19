import { useEffect, useRef, useState, type ReactNode } from "react";

export type SheetState = "min" | "half" | "full";

interface Props {
  state: SheetState;
  onState: (s: SheetState) => void;
  header: ReactNode;
  children: ReactNode;
}

const MIN_PX = 132;

function heights() {
  const h = window.innerHeight;
  return { min: MIN_PX, half: Math.round(h * 0.46), full: h - 56 };
}

/** 可拖曳底部面板：收合／半開／全開，放開時吸附到最近的位置 */
export default function BottomSheet({ state, onState, header, children }: Props) {
  const [hs, setHs] = useState(heights);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const r = () => setHs(heights());
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);

  const height = drag ?? hs[state];

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    start.current = { y: e.clientY, h: hs[state], t: performance.now() };
    setDrag(hs[state]);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const h = Math.min(hs.full, Math.max(hs.min - 40, start.current.h + (start.current.y - e.clientY)));
    setDrag(h);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dy = start.current.y - e.clientY;
    const dt = performance.now() - start.current.t;
    const h = drag ?? hs[state];
    let next: SheetState;
    if (Math.abs(dy) < 6 && dt < 300) {
      // 點一下：循環展開
      next = state === "min" ? "half" : state === "half" ? "full" : "half";
    } else if (Math.abs(dy) / dt > 0.6) {
      // 快速滑動：往滑的方向跳一格
      const order: SheetState[] = ["min", "half", "full"];
      const i = order.indexOf(state) + (dy > 0 ? 1 : -1);
      next = order[Math.max(0, Math.min(2, i))];
    } else {
      next = (Object.entries(hs) as [SheetState, number][]).reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0];
    }
    start.current = null;
    setDrag(null);
    onState(next);
  };

  return (
    <section
      className={`sheet ${drag != null ? "dragging" : ""}`}
      style={{ height }}
      aria-label="成交列表與統計"
    >
      <div className="sheet-grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <span className="grip-bar" />
        {header}
      </div>
      <div className="sheet-body" ref={body}>
        {children}
      </div>
    </section>
  );
}
