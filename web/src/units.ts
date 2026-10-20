/** 預售「棟及號」解析（與 pipeline/clean.py 的 parse_unit 同規則，單元測試在 tests/test_clean.py） */

const FW = "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ";
const HW = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function half(s: string) {
  return [...s].map((ch) => {
    const i = FW.indexOf(ch);
    return i >= 0 ? HW[i] : ch;
  }).join("");
}

/** 'A棟1-6F號' → ['A-1', 6]；'C2棟6F號' → ['C2', 6]；'B棟B2-03F號' → ['B2', 3]；'A棟5號'（透天）→ ['A-5', null] */
export function parseUnit(unit: string | null, floor: number | null): [string | null, number | null] {
  let s = half(unit ?? "").toUpperCase().replace(/號/g, "").replace(/\s/g, "");
  if (!s) return [null, floor];
  const m = /(\d+)\s*(?:F|樓)/.exec(s);
  const fl = m ? Number(m[1]) : null;
  if (m) s = s.slice(0, m.index) + "-" + s.slice(m.index + m[0].length);
  let toks = s.split(/[棟\-_]+/).filter((t) => t && !/^0+$/.test(t));
  if (fl === null && floor !== null && toks.length >= 2 && /^\d+$/.test(toks[toks.length - 1]) && Number(toks[toks.length - 1]) === floor) {
    toks = toks.slice(0, -1); // 「1-05號」的 05 就是樓層
  }
  if (toks.length >= 2 && toks[1].startsWith(toks[0]) && toks[1] !== toks[0]) toks = toks.slice(1); // 「B棟B2」→「B2」
  toks = toks.map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
  return [toks.join("-") || null, fl ?? floor];
}

/** 自然排序：A-2 排在 A-10 前面 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hant", { numeric: true });
}
