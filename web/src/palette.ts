/**
 * 配色：依資料視覺化參考調色盤（dataviz skill references/palette.md），並用 validate_palette.js 驗證過。
 *
 * - 價格 5 級（發散）：藍＝比範圍內便宜、灰＝居中、紅＝較貴。兩端取調色盤藍／紅，中點取發散中性灰，
 *   中間一級為兩者在 OKLab 的中點（計算，不憑眼睛挑）。每側亮度單調、相鄰色差 ≥ 16（色盲模擬下 ≥ 12.5）。
 *   中間幾級與底色對比 < 3:1，因此地圖色塊、泡泡、銷控表格子都一定附數字標籤。
 * - 樓層 3 級（順序）：單一藍色由淺到深（深色模式反過來），驗證全部通過。
 * - 系列色（走勢圖最多 4 條）：分類色 1–4 號，固定順序，不循環。
 */

export type Mode = "light" | "dark";

export const PRICE: Record<Mode, string[]> = {
  light: ["#2a78d6", "#90b5e4", "#f0efec", "#f1a299", "#e34948"],
  dark: ["#3987e5", "#3e6089", "#383835", "#8c524e", "#e66767"],
};

/** 樓層 低／中／高 */
export const FLOOR: Record<Mode, string[]> = {
  light: ["#86b6ef", "#2a78d6", "#104281"],
  dark: ["#184f95", "#3987e5", "#9ec5f4"],
};

export const SERIES: Record<Mode, string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500"],
};

/** 解約（銷控表）：中性灰，並一定寫「解約」 */
export const CANCEL = "#898781";

export const CHROME: Record<Mode, { grid: string; axis: string; muted: string; ink: string; ink2: string; surface: string }> = {
  light: { grid: "#e1e0d9", axis: "#c3c2b7", muted: "#898781", ink: "#0b0b0b", ink2: "#52514e", surface: "#ffffff" },
  dark: { grid: "#2c2c2a", axis: "#383835", muted: "#898781", ink: "#f0efec", ink2: "#c3c2b7", surface: "#111827" },
};

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** 色塊上的文字：依底色亮度選黑或白，確保對比 */
export function inkOn(hex: string): string {
  const L = luminance(hex);
  const black = (L + 0.05) / 0.05;
  const white = 1.05 / (L + 0.05);
  return black >= white ? "#0b0b0b" : "#ffffff";
}
