/** 篩選結果匯出 CSV（UTF-8 加 BOM，Excel 直接開不會亂碼） */
import { download, today } from "./favorites";
import { floorClass } from "./filters";
import type { Community, Meta, Rent, Tx } from "./types";

const FLOOR_NAME = { l: "低", m: "中", h: "高" } as const;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(txs: Tx[], meta: Meta, comms: Community[], label: string) {
  const head = [
    "交易日期", "類別", "行政區", "地址", "社區或建案", "棟及號", "建物型態", "樓層", "總樓層", "樓層分類", "屋齡（年）",
    "房", "廳", "衛", "總價（萬）", "扣車位單價（萬/坪）", "權狀坪（不含車位）", "室內坪（主建物）", "公設比",
    "車位數", "車位類別", "車位價（萬）", "車位價是否估算", "旗標", "位置精度", "編號",
  ];
  const estBit = meta.flags.find((f) => f.name === "車位未拆價")?.bit;
  const rows = txs.map((t) => {
    const flags = meta.flags.filter((f) => t.fx & (1 << f.bit)).map((f) => f.name).join("、");
    const fc = floorClass(t);
    const d = String(t.date);
    return [
      `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6)}`,
      t.kind === 1 ? "預售" : "買賣",
      meta.districts.find((x) => x.code === t.district)?.name ?? "",
      t.addr,
      t.cid >= 0 ? comms[t.cid]?.name ?? "" : "",
      t.un ?? "",
      meta.btypes[t.bt],
      t.fl ?? "",
      t.tf ?? "",
      fc ? FLOOR_NAME[fc] : "",
      t.kind === 1 ? "" : t.age ?? "",
      t.rm ?? "", t.hl ?? "", t.ba ?? "",
      t.tp ?? "",
      t.up ?? "",
      t.pg ?? "",
      t.ip ?? "",
      t.pr === null ? "" : Math.round(t.pr * 100) + "%",
      t.pn || "",
      t.pn && t.pt >= 0 ? meta.parkTypes[t.pt] : "",
      t.pn ? t.pp ?? "" : "",
      estBit !== undefined && t.fx & (1 << estBit) ? "估算" : "",
      flags,
      meta.geoLevels[String(t.geo)] ?? "",
      t.id,
    ];
  });
  const body = [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const src = `\r\n\r\n資料來源：內政部實價登錄開放資料（政府資料開放授權條款－第1版）；匯出條件：${label}`;
  download(new Blob(["﻿" + body + src], { type: "text/csv;charset=utf-8" }), `桃園實價_${today()}.csv`);
}

export function exportRentCsv(rs: Rent[], meta: Meta, comms: Community[], label: string) {
  const rm = meta.rent!;
  const head = [
    "租賃日期", "行政區", "地址", "社區", "出租型態", "建物型態", "樓層", "總樓層", "屋齡（年）", "房", "廳", "衛",
    "坪數（不含車位）", "月租（元）", "每坪月租（元）", "附傢俱", "管理員", "電梯", "車位類別", "車位月租（元）",
    "租賃住宅服務", "旗標", "位置精度", "編號",
  ];
  const yn = (v: number | null) => (v === 1 ? "有" : v === 0 ? "無" : "");
  const rows = rs.map((r) => {
    const d = String(r.date);
    return [
      `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6)}`,
      meta.districts.find((x) => x.code === r.district)?.name ?? "",
      r.addr,
      r.cid >= 0 ? comms[r.cid]?.name ?? "" : "",
      r.rt >= 0 ? rm.types[r.rt] : "",
      meta.btypes[r.bt],
      r.fl ?? "", r.tf ?? "", r.age ?? "", r.rm ?? "", r.hl ?? "", r.ba ?? "",
      r.pg ?? "", r.rent, r.ru ?? "", yn(r.fu), yn(r.mg), yn(r.el),
      r.pt >= 0 ? meta.parkTypes[r.pt] : "", r.pp ?? "",
      r.sv >= 0 ? rm.services[r.sv] : "",
      rm.flags.filter((f) => r.fx & (1 << f.bit)).map((f) => f.name).join("、"),
      meta.geoLevels[String(r.geo)] ?? "",
      r.id,
    ];
  });
  const body = [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const src = `\r\n\r\n資料來源：內政部實價登錄開放資料（政府資料開放授權條款－第1版）；匯出條件：${label}`;
  download(new Blob(["﻿" + body + src], { type: "text/csv;charset=utf-8" }), `桃園租賃_${today()}.csv`);
}
