import type { ReactNode } from "react";

/** 全螢幕分頁外框：返回鍵（Android 返回鍵也會關閉，見 App 的路由）、標題、內容 */
export default function PageShell({ title, sub, onBack, children }: {
  title: string;
  sub?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="page" role="dialog" aria-label={title}>
      <header className="page-head">
        <button className="back" onClick={onBack} aria-label="返回地圖">‹</button>
        <div className="page-title">
          <h2>{title}</h2>
          {sub && <small>{sub}</small>}
        </div>
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}
