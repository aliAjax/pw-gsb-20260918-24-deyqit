import React from "react";
import "./styles.css";

/* ================= 常量与类型 ================= */

const project = {
  id: "hxyfront-62001",
  port: 62001,
  title: "船舶轮机值班记录",
  domain: "船舶轮机",
};

const STORAGE_KEY = "hxyfront-62001-watch-v1";

// 六班制（每个班次 4 小时）
const WATCHES = [
  { label: "00-04班", start: 0 },
  { label: "04-08班", start: 4 },
  { label: "08-12班", start: 8 },
  { label: "12-16班", start: 12 },
  { label: "16-20班", start: 16 },
  { label: "20-24班", start: 20 },
];

const EQUIPMENTS = ["主机", "发电机#1", "发电机#2", "舱底泵"];
const DEVICE_FILTERS = ["全部", ...EQUIPMENTS];
const BILGE_OPTIONS = ["正常", "偏高", "接近警戒线", "报警"];

// 转速归一化基准（用于不同工况下小时油耗的横向对比）
const REFERENCE_RPM: Record<string, number> = {
  主机: 85,
  "发电机#1": 1500,
  "发电机#2": 1500,
};

const DEVIATION_LIMIT = 1.2; // 较上一稳定班次高 20% 触发待复核

type ReviewStatus =
  | "none" // 无需复核（燃油正常/非燃油记录）
  | "pending" // 待复核：已计入剔除，等待复检
  | "confirmed" // 复检确认（已填原因），工况未确认，仍剔除
  | "resolved"; // 工况确认，恢复统计

interface WatchRecord {
  id: string;
  date: string; // YYYY-MM-DD
  watch: string; // 班次标签
  ts: number; // 读数时刻（精确到分钟）
  equipment: string;
  rpm: number | null; // 主机转速 / 发电机转速
  lubPressure: number | null; // 滑油压力 MPa
  coolantTemp: number | null; // 冷却水温 ℃
  fuelReading: number | null; // 累计燃油读数 L
  bilgeStatus: string; // 舱底水状态
  note: string; // 巡检 / 异常描述
  // 保存时由相邻两次燃油读数 + 转速折算
  hoursElapsed: number | null;
  fuelDelta: number | null; // L
  hourlyFuel: number | null; // 实测小时油耗 L/h
  normalizedHourlyFuel: number | null; // 折算到基准转速的小时油耗 L/h
  baselineHourlyFuel: number | null; // 保存时同设备上一稳定班次基准 L/h
  deviation: number | null; // 折算值 / 基准
  review: ReviewStatus;
  reviewReason: string; // 待复核原因（复检结论）
}

interface SealedWatch {
  key: string; // date|watch
  date: string;
  watch: string;
  at: number;
  // 交接摘要的确认油耗快照（剔除待复核及工况未确认项）
  confirmedFuel: number;
  recordCount: number;
  excludedCount: number;
  handoverNote: string;
}

interface PersistShape {
  records: WatchRecord[];
  sealed: SealedWatch[];
}

/* ================= 工具函数 ================= */

const pad2 = (n: number) => String(n).padStart(2, "0");

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function watchKey(date: string, watch: string) {
  return `${date}|${watch}`;
}

function watchStartTs(date: string, watch: string): number {
  const w = WATCHES.find((x) => x.label === watch) ?? WATCHES[0];
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, w.start, 0, 0, 0).getTime();
}

// 班次内分钟 -> 时间戳
function tsOf(date: string, watch: string, minute: number): number {
  const w = WATCHES.find((x) => x.label === watch) ?? WATCHES[0];
  const [y, m, d] = date.split("-").map(Number);
  const total = w.start * 60 + minute;
  return new Date(
    y,
    m - 1,
    d,
    Math.floor(total / 60),
    total % 60,
    0,
    0
  ).getTime();
}

function currentWatch(): { date: string; watch: string } {
  const now = new Date();
  const hour = now.getHours();
  const w = WATCHES[Math.floor(hour / 4)];
  return { date: dateStr(now), watch: w.label };
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 按转速立方规律折算小时油耗（轴功率近似与转速三次方相关），rpm 异常时回退为实测值 */
function normalizeHourlyFuel(
  hourly: number,
  rpm: number | null,
  equipment: string
): number {
  const ref = REFERENCE_RPM[equipment];
  if (!ref || rpm === null || rpm <= 0) return hourly;
  return hourly * Math.pow(ref / rpm, 3);
}

/** 同设备时间上一条燃油读数 */
function previousReading(
  records: WatchRecord[],
  equipment: string,
  ts: number
): WatchRecord | null {
  const older = records
    .filter((r) => r.equipment === equipment && r.fuelReading !== null && r.ts < ts)
    .sort((a, b) => b.ts - a.ts);
  return older[0] ?? null;
}

/** 一条燃油记录是否计入确认统计（看板 / 交接摘要） */
export function isStatCounted(r: WatchRecord): boolean {
  return r.fuelDelta !== null && r.review === "resolved";
}

/** 同设备“上一稳定班次”的折算小时油耗基准：
 *  取早于本次班次、整班无待复核/复检中/工况未确认记录、且已完成交接的班次 */
function stableShiftBaseline(
  records: WatchRecord[],
  sealedKeys: Set<string>,
  equipment: string,
  date: string,
  watch: string
): number | null {
  const thisStart = watchStartTs(date, watch);
  const byWatch = new Map<string, WatchRecord[]>();
  for (const r of records) {
    if (r.equipment !== equipment || r.fuelDelta === null) continue;
    if (r.ts >= thisStart) continue;
    const k = watchKey(r.date, r.watch);
    if (!sealedKeys.has(k)) continue; // 未完成交接的班次不算稳定班次
    const arr = byWatch.get(k) ?? [];
    arr.push(r);
    byWatch.set(k, arr);
  }
  const stable: number[] = [];
  for (const [, arr] of byWatch) {
    // 整班该设备的燃油记录都已恢复统计 → 稳定班次
    if (arr.every((r) => r.review === "resolved")) {
      const vals = arr
        .map((r) => r.normalizedHourlyFuel)
        .filter((v): v is number => v !== null);
      if (vals.length) stable.push(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  if (!stable.length) return null;
  return stable[stable.length - 1];
}

/* ================= 示例数据（首启时播种） ================= */

function seedData(): PersistShape {
  const records: WatchRecord[] = [];
  const sealed: SealedWatch[] = [];
  const cw = currentWatch();

  const push = (
    date: string,
    watch: string,
    minute: number,
    equipment: string,
    rpm: number | null,
    fuel: number | null,
    extra: Partial<WatchRecord> = {}
  ) => {
    const ts = tsOf(date, watch, minute);
    const prev = previousReading(records, equipment, ts);
    let hoursElapsed: number | null = null;
    let fuelDelta: number | null = null;
    let hourlyFuel: number | null = null;
    let normalized: number | null = null;
    if (fuel !== null && prev && prev.fuelReading !== null) {
      hoursElapsed = (ts - prev.ts) / 3_600_000;
      fuelDelta = +(fuel - prev.fuelReading).toFixed(1);
      hourlyFuel = +(fuelDelta / hoursElapsed).toFixed(2);
      normalized = +normalizeHourlyFuel(hourlyFuel, rpm, equipment).toFixed(2);
    }
    records.push({
      id: uid(),
      date,
      watch,
      ts,
      equipment,
      rpm,
      lubPressure: extra.lubPressure ?? null,
      coolantTemp: extra.coolantTemp ?? null,
      fuelReading: fuel,
      bilgeStatus: extra.bilgeStatus ?? (equipment === "舱底泵" ? "正常" : ""),
      note: extra.note ?? "正常巡检",
      hoursElapsed,
      fuelDelta,
      hourlyFuel,
      normalizedHourlyFuel: normalized,
      baselineHourlyFuel: null,
      deviation: null,
      review: fuelDelta === null ? "none" : "resolved",
      reviewReason: "",
    });
  };

  const today = new Date();
  const d1 = dateStr(new Date(today.getTime() - 86_400_000));

  // —— 昨日三个班次（主机，基准稳定班次，折算约 43L/h）——
  push(d1, "08-12班", 30, "主机", 82, 1200, {
    lubPressure: 0.42,
    coolantTemp: 78,
    note: "正常巡航巡检",
  });
  push(d1, "08-12班", 150, "主机", 83, 1286, { lubPressure: 0.42, coolantTemp: 79 });
  push(d1, "08-12班", 210, "主机", 84, 1330, { lubPressure: 0.43, coolantTemp: 80 });

  push(d1, "12-16班", 30, "主机", 83, 1373, { lubPressure: 0.42, coolantTemp: 79 });
  push(d1, "12-16班", 150, "主机", 84, 1460, { lubPressure: 0.43, coolantTemp: 80 });
  push(d1, "12-16班", 210, "主机", 82, 1502, { lubPressure: 0.42, coolantTemp: 78 });

  push(d1, "16-20班", 30, "主机", 84, 1546, { lubPressure: 0.43, coolantTemp: 80 });
  push(d1, "16-20班", 150, "主机", 83, 1631, { lubPressure: 0.42, coolantTemp: 79 });
  push(d1, "16-20班", 210, "主机", 82, 1673, { lubPressure: 0.42, coolantTemp: 78 });

  // —— 昨日发电柴油机两班（提供设备级基准）——
  push(d1, "12-16班", 60, "发电机#1", 1500, 800, {
    lubPressure: 0.38,
    coolantTemp: 72,
    note: "并电运行",
  });
  push(d1, "12-16班", 180, "发电机#1", 1500, 896, { lubPressure: 0.38, coolantTemp: 73 });
  push(d1, "16-20班", 60, "发电机#1", 1500, 992, { lubPressure: 0.38, coolantTemp: 72 });
  push(d1, "16-20班", 180, "发电机#1", 1500, 1088, { lubPressure: 0.38, coolantTemp: 73 });

  push(d1, "16-20班", 90, "发电机#2", 1490, 600, {
    lubPressure: 0.37,
    coolantTemp: 76,
    note: "冷却水温偏高，已安排复查",
  });
  push(d1, "16-20班", 210, "发电机#2", 1495, 694, {
    lubPressure: 0.37,
    coolantTemp: 75,
    note: "复查水温回落",
  });

  // 当前班次起点：发电机#2 接班起始读数（作为异常读数的相邻基准）
  const startWatch = WATCHES.find((w) => w.label === cw.watch) ?? WATCHES[0];
  const prevWatch =
    WATCHES[(WATCHES.findIndex((w) => w.label === cw.watch) + 5) % 6];
  const baseDate =
    startWatch.start === 0
      ? dateStr(new Date(new Date().getTime() - 86_400_000))
      : cw.date;
  // 手工构造一条位于班次起点的记录（tsOf 在跨日 24:00 时会进位）
  {
    const startTs = watchStartTs(cw.date, cw.watch);
    records.push({
      id: uid(),
      date: baseDate,
      watch: prevWatch.label,
      ts: startTs,
      equipment: "发电机#2",
      rpm: 1500,
      lubPressure: 0.38,
      coolantTemp: 74,
      fuelReading: 784,
      bilgeStatus: "正常",
      note: "接班巡检，运行平稳",
      hoursElapsed: null,
      fuelDelta: null,
      hourlyFuel: null,
      normalizedHourlyFuel: null,
      baselineHourlyFuel: null,
      deviation: null,
      review: "none",
      reviewReason: "",
    });
    records.sort((a, b) => a.ts - b.ts);
  }

  // —— 舱底水巡检 —— //
  push(d1, "16-20班", 120, "舱底泵", null, null, {
    bilgeStatus: "接近警戒线",
    note: "液位接近警戒线，已记录交班",
  });

  // 昨日班次全部完成交接，确认油耗 = 全部 resolved 燃油增量
  for (const w of ["08-12班", "12-16班", "16-20班"]) {
    const k = watchKey(d1, w);
    const rs = records.filter((r) => watchKey(r.date, r.watch) === k);
    sealed.push({
      key: k,
      date: d1,
      watch: w,
      at: watchStartTs(d1, w) + 4 * 3_600_000,
      confirmedFuel: +rs
        .filter((r) => isStatCounted(r))
        .reduce((s, r) => s + (r.fuelDelta ?? 0), 0)
        .toFixed(1),
      recordCount: rs.length,
      excludedCount: 0,
      handoverNote: "本班工况稳定，参数正常，已交接。",
    });
  }

  // 今日当前班次一条主机读数（未交接，登录后录第二条即可触发折算）
  push(cw.date, cw.watch, 60, "主机", 82, 1716, {
    lubPressure: 0.42,
    coolantTemp: 78,
    note: "本班巡检",
  });

  // 当前班次发电机#2 一条异常高油耗（较其昨日稳定班次高 20%+，即标待复核、阻断交接）
  const pendingTs = tsOf(cw.date, cw.watch, 120);
  const pendingPrev = previousReading(records, "发电机#2", pendingTs);
  const pendingFuel = 904;
  const pendingHours = (pendingTs - (pendingPrev?.ts ?? pendingTs)) / 3_600_000;
  const pendingDelta = +(pendingFuel - (pendingPrev?.fuelReading ?? pendingFuel)).toFixed(1);
  const pendingHourly = +(pendingDelta / pendingHours).toFixed(2);
  const pendingNorm = +normalizeHourlyFuel(pendingHourly, 1500, "发电机#2").toFixed(2);
  const pendingBaseline = stableShiftBaseline(
    records,
    new Set(sealed.map((s) => s.key)),
    "发电机#2",
    cw.date,
    cw.watch
  );
  const pendingSeed: WatchRecord = {
    id: uid(),
    date: cw.date,
    watch: cw.watch,
    ts: pendingTs,
    equipment: "发电机#2",
    rpm: 1500,
    lubPressure: 0.37,
    coolantTemp: 78,
    fuelReading: pendingFuel,
    bilgeStatus: "正常",
    note: "油耗突增，排气温度略高，待排查",
    hoursElapsed: +pendingHours.toFixed(3),
    fuelDelta: pendingDelta,
    hourlyFuel: pendingHourly,
    normalizedHourlyFuel: pendingNorm,
    baselineHourlyFuel: pendingBaseline,
    deviation: pendingBaseline !== null ? +(pendingNorm / pendingBaseline).toFixed(3) : null,
    review:
      pendingBaseline !== null && pendingNorm > pendingBaseline * DEVIATION_LIMIT
        ? "pending"
        : "resolved",
    reviewReason: "",
  };
  records.push(pendingSeed);

  return { records, sealed };
}

function loadState(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.records) && Array.isArray(parsed.sealed)) {
        return parsed;
      }
    }
  } catch {
    /* 本地数据损坏时重新播种 */
  }
  return seedData();
}

/* ================= 主应用 ================= */

function App() {
  const initial = loadState();
  const [records, setRecords] = React.useState<WatchRecord[]>(initial.records);
  const [sealed, setSealed] = React.useState<SealedWatch[]>(initial.sealed);
  const cur = currentWatch();
  const [selDate, setSelDate] = React.useState(cur.date);
  const [selWatch, setSelWatch] = React.useState(cur.watch);
  const [deviceFilter, setDeviceFilter] = React.useState("全部");
  const [handoverNote, setHandoverNote] = React.useState("");
  const [toast, setToast] = React.useState("");

  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ records, sealed }));
  }, [records, sealed]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2600);
  };

  const selKey = watchKey(selDate, selWatch);
  const sealedMap = React.useMemo(() => {
    const m = new Map<string, SealedWatch>();
    sealed.forEach((s) => m.set(s.key, s));
    return m;
  }, [sealed]);
  const isSealed = sealedMap.has(selKey);

  /* —— 表单状态 —— */
  const [fEquipment, setFEquipment] = React.useState("主机");
  const [fMinute, setFMinute] = React.useState("120");
  const [fRpm, setFRpm] = React.useState("");
  const [fLub, setFLub] = React.useState("");
  const [fCoolant, setFCoolant] = React.useState("");
  const [fFuel, setFFuel] = React.useState("");
  const [fBilge, setFBilge] = React.useState("正常");
  const [fNote, setFNote] = React.useState("");
  const [formError, setFormError] = React.useState("");

  const sealedKeys = React.useMemo(
    () => new Set(sealed.map((s) => s.key)),
    [sealed]
  );

  /* —— 保存记录：相邻两次燃油读数 + 主机转速折算小时油耗 —— */
  const saveRecord = () => {
    setFormError("");
    if (isSealed) {
      setFormError("本班已完成交接并封存，不能再补录记录。");
      return;
    }
    const minute = Number(fMinute);
    if (!Number.isFinite(minute) || minute < 0 || minute > 240) {
      setFormError("请填写班内分钟（0–240）。");
      return;
    }
    const rpm = fRpm.trim() === "" ? null : Number(fRpm);
    const lub = fLub.trim() === "" ? null : Number(fLub);
    const coolant = fCoolant.trim() === "" ? null : Number(fCoolant);
    const fuel = fFuel.trim() === "" ? null : Number(fFuel);
    if ([rpm, lub, coolant, fuel].some((v) => v !== null && !Number.isFinite(v))) {
      setFormError("数值字段请填写有效数字。");
      return;
    }
    if (!fNote.trim()) {
      setFormError("请填写巡检/异常描述。");
      return;
    }

    const ts = tsOf(selDate, selWatch, minute);

    // 相邻读数：同设备时间上一条带累计燃油读数的记录
    let prev: WatchRecord | null = null;
    if (fuel !== null) {
      prev = previousReading(records, fEquipment, ts);
      if (!prev || prev.fuelReading === null) {
        setFormError(
          `缺少 ${fEquipment} 更早的累计燃油读数作为相邻基准，本次读数已作为起始读数保存（不折算油耗）。`
        );
      } else if (fuel < prev.fuelReading) {
        setFormError(
          `本次燃油读数 ${fuel}L 小于上一读数 ${prev.fuelReading}L，请核对后再保存。`
        );
        return;
      }
    }

    const rec: WatchRecord = {
      id: uid(),
      date: selDate,
      watch: selWatch,
      ts,
      equipment: fEquipment,
      rpm,
      lubPressure: lub,
      coolantTemp: coolant,
      fuelReading: fuel,
      bilgeStatus: fBilge,
      note: fNote.trim(),
      hoursElapsed: null,
      fuelDelta: null,
      hourlyFuel: null,
      normalizedHourlyFuel: null,
      baselineHourlyFuel: null,
      deviation: null,
      review: "none",
      reviewReason: "",
    };

    if (fuel !== null && prev && prev.fuelReading !== null) {
      const hours = (ts - prev.ts) / 3_600_000;
      const delta = +(fuel - prev.fuelReading).toFixed(1);
      const hourly = +(delta / hours).toFixed(2);
      const normalized = +normalizeHourlyFuel(hourly, rpm, fEquipment).toFixed(2);
      const baseline = stableShiftBaseline(
        records,
        sealedKeys,
        fEquipment,
        selDate,
        selWatch
      );
      rec.hoursElapsed = +hours.toFixed(3);
      rec.fuelDelta = delta;
      rec.hourlyFuel = hourly;
      rec.normalizedHourlyFuel = normalized;
      rec.baselineHourlyFuel = baseline;
      // 对比同设备上一稳定班次，折算小时油耗高 20% → 待复核
      if (baseline !== null) {
        rec.deviation = +(normalized / baseline).toFixed(3);
        if (normalized > baseline * DEVIATION_LIMIT) {
          rec.review = "pending";
        }
      }
      if (rec.review === "none") rec.review = "resolved";
    }

    setRecords((rs) =>
      [...rs, rec].sort((a, b) => a.ts - b.ts || a.equipment.localeCompare(b.equipment))
    );

    setFRpm("");
    setFLub("");
    setFCoolant("");
    setFFuel("");
    setFNote("");
    flash(
      rec.review === "pending"
        ? `已保存：折算 ${rec.normalizedHourlyFuel}L/h，高于上一稳定班次 20%，已标为待复核并从确认油耗剔除。`
        : "记录已保存。"
    );
  };

  /* —— 复核闭环：填写待复核原因后，复检确认才有效 —— */
  const setReason = (id: string, reason: string) => {
    setRecords((rs) =>
      rs.map((r) => (r.id === id ? { ...r, reviewReason: reason } : r))
    );
  };

  const confirmReview = (id: string) => {
    const target = records.find((r) => r.id === id);
    if (!target) return;
    if (!target.reviewReason.trim()) {
      flash("待复核原因未填写，复检确认无效。");
      return;
    }
    setRecords((rs) =>
      rs.map((r) => (r.id === id ? { ...r, review: "confirmed" } : r))
    );
    flash("复检确认完成；该读数仍剔除，工况确认后才恢复统计。");
  };

  // 工况确认 → 恢复统计
  const confirmCondition = (id: string) => {
    setRecords((rs) =>
      rs.map((r) => (r.id === id ? { ...r, review: "resolved" } : r))
    );
    flash("工况已确认，该燃油读数恢复计入统计。");
  };

  /* —— 交接：本班有待复核（未填原因 / 未复检）则不能完成 —— */
  const shiftRecords = React.useMemo(
    () =>
      records
        .filter((r) => r.date === selDate && r.watch === selWatch)
        .sort((a, b) => a.ts - b.ts),
    [records, selDate, selWatch]
  );

  const blocking = shiftRecords.filter(
    (r) => r.review === "pending" || r.review === "confirmed"
  );
  const reasonMissing = shiftRecords.filter(
    (r) => r.review !== "none" && r.review !== "resolved" && !r.reviewReason.trim()
  );
  const canSeal = blocking.length === 0 && reasonMissing.length === 0;

  const confirmedFuelShift = +shiftRecords
    .filter(isStatCounted)
    .reduce((s, r) => s + (r.fuelDelta ?? 0), 0)
    .toFixed(1);

  const excludedFuelShift = +shiftRecords
    .filter((r) => r.fuelDelta !== null && !isStatCounted(r))
    .reduce((s, r) => s + (r.fuelDelta ?? 0), 0)
    .toFixed(1);

  const completeHandover = () => {
    if (!canSeal) {
      flash(
        reasonMissing.length
          ? "存在待复核记录且原因未填写，本班不能完成交接。"
          : "存在待复核记录未完成工况确认，本班不能完成交接。"
      );
      return;
    }
    if (sealedMap.has(selKey)) return;
    const seal: SealedWatch = {
      key: selKey,
      date: selDate,
      watch: selWatch,
      at: Date.now(),
      confirmedFuel: confirmedFuelShift,
      recordCount: shiftRecords.length,
      excludedCount: shiftRecords.filter((r) => r.fuelDelta !== null && !isStatCounted(r))
        .length,
      handoverNote: handoverNote.trim(),
    };
    setSealed((ss) =>
      [...ss, seal].sort((a, b) => watchStartTs(a.date, a.watch) - watchStartTs(b.date, b.watch))
    );
    setHandoverNote("");
    flash("本班交接完成并封存，确认油耗已写入交接摘要。");
  };

  /* —— 筛选与看板 —— */
  const visibleRecords = React.useMemo(
    () =>
      shiftRecords.filter((r) =>
        deviceFilter === "全部" ? true : r.equipment === deviceFilter
      ),
    [shiftRecords, deviceFilter]
  );

  const countedVisible = visibleRecords.filter(isStatCounted);
  const totalConfirmedFuel = +countedVisible
    .reduce((s, r) => s + (r.fuelDelta ?? 0), 0)
    .toFixed(1);
  const excludedVisibleFuel = +visibleRecords
    .filter((r) => r.fuelDelta !== null && !isStatCounted(r))
    .reduce((s, r) => s + (r.fuelDelta ?? 0), 0)
    .toFixed(1);
  const avgRpm = (() => {
    const rpms = visibleRecords
      .map((r) => r.rpm)
      .filter((v): v is number => v !== null);
    if (!rpms.length) return "—";
    return Math.round(rpms.reduce((a, b) => a + b, 0) / rpms.length);
  })();
  const avgLub = (() => {
    const vals = visibleRecords
      .map((r) => r.lubPressure)
      .filter((v): v is number => v !== null);
    if (!vals.length) return "—";
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  })();
  const avgCoolant = (() => {
    const vals = visibleRecords
      .map((r) => r.coolantTemp)
      .filter((v): v is number => v !== null);
    if (!vals.length) return "—";
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  })();

  const pendingCount = shiftRecords.filter((r) => r.review === "pending").length;
  const sealedShift = sealedMap.get(selKey);

  const exportSummary = () => {
    const lines = [
      `交接班摘要 ${selDate} ${selWatch}`,
      `记录条数：${shiftRecords.length}`,
      `确认油耗（已剔除非确认项）：${confirmedFuelShift} L`,
      `剔除油耗：${excludedFuelShift} L`,
      `交接状态：${isSealed ? "已完成" : "未完成"}`,
      handoverNote ? `备注：${handoverNote}` : "",
    ];
    const blob = new Blob([lines.filter(Boolean).join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `交接摘要-${selKey.replace("|", "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const lastReadingHint = React.useMemo(() => {
    const prev = [...records]
      .filter((r) => r.equipment === fEquipment && r.fuelReading !== null)
      .sort((a, b) => b.ts - a.ts)[0];
    if (!prev) return `${fEquipment} 尚无历史燃油读数`;
    return `${fEquipment} 上一读数 ${prev.fuelReading}L（${prev.date} ${prev.watch}）`;
  }, [records, fEquipment]);

  /* ================= 渲染 ================= */

  return (
    <main className="app">
      {toast && <div className="toast">{toast}</div>}

      <section className="hero compact">
        <p>
          {project.id} · Port {project.port} · 油耗复核闭环
        </p>
        <h1>{project.title}</h1>
        <span>
          保存时以相邻两次累计燃油读数与主机转速折算小时油耗；较同设备上一稳定班次高
          20% 自动标为待复核并从交接摘要确认油耗中剔除，原因填写 + 复检确认 +
          工况确认后恢复统计。数据仅保存在本浏览器。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>平均主机转速 rpm</small>
          <strong>{avgRpm}</strong>
        </article>
        <article>
          <small>平均滑油压力 MPa</small>
          <strong>{avgLub}</strong>
        </article>
        <article>
          <small>平均冷却水温 ℃</small>
          <strong>{avgCoolant}</strong>
        </article>
        <article className={excludedVisibleFuel > 0 ? "metric-warn" : ""}>
          <small>
            确认油耗 L（{deviceFilter}，已剔除 {excludedVisibleFuel}L）
          </small>
          <strong>{totalConfirmedFuel}</strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}筛选</h2>

          <label className="side-label">
            <span>值班日期</span>
            <input
              type="date"
              value={selDate}
              onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setSelDate(e.target.value || cur.date)}
            />
          </label>

          <span className="side-label-title">值班班次</span>
          <div className="chips watch-chips">
            {WATCHES.map((w) => {
              const k = watchKey(selDate, w.label);
              const cnt = records.filter(
                (r) => r.date === selDate && r.watch === w.label
              ).length;
              const pend = records.filter(
                (r) =>
                  r.date === selDate &&
                  r.watch === w.label &&
                  (r.review === "pending" || r.review === "confirmed")
              ).length;
              const sealedCls = sealedMap.has(k) ? "sealed" : "";
              return (
                <button
                  key={w.label}
                  className={[
                    selWatch === w.label ? "active" : "",
                    sealedCls,
                  ].join(" ")}
                  onClick={() => setSelWatch(w.label)}
                  title={sealedMap.has(k) ? "已完成交接（已封存）" : "未交接"}
                >
                  {w.label}
                  <em>
                    {sealedMap.has(k) ? "✓" : cnt}
                    {pend > 0 ? <i className="dot">{pend}</i> : null}
                  </em>
                </button>
              );
            })}
          </div>

          <span className="side-label-title">设备筛选</span>
          <div className="chips">
            {DEVICE_FILTERS.map((item) => (
              <button
                key={item}
                className={deviceFilter === item ? "active" : ""}
                onClick={() => setDeviceFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <p className="side-tip">
            看板、历史记录与交接摘要均随当前班次 / 设备筛选联动，数据自动保存在浏览器本地。
          </p>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>机舱参数录入</p>
              <h2>
                新增记录 · {selDate} {selWatch}
                {isSealed && <span className="tag tag-sealed">已交接封存</span>}
                {pendingCount > 0 && (
                  <span className="tag tag-pending">{pendingCount} 条待复核</span>
                )}
              </h2>
            </div>
            <button className="primary" onClick={saveRecord} disabled={isSealed}>
              保存记录
            </button>
          </div>

          <div className="field-grid">
            <label>
              <span>值班班次（自动）</span>
              <input value={`${selDate} ${selWatch}`} readOnly />
            </label>
            <label>
              <span>设备名称</span>
              <select
                value={fEquipment}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFEquipment(e.target.value)}
                disabled={isSealed}
              >
                {EQUIPMENTS.map((eq) => (
                  <option key={eq} value={eq}>
                    {eq}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>班内分钟（0–240，如120为班中）</span>
              <input
                value={fMinute}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFMinute(e.target.value)}
                placeholder="读数距班次开始的分钟数"
                disabled={isSealed}
              />
            </label>
            <label>
              <span>主机/发电机转速 rpm</span>
              <input
                value={fRpm}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFRpm(e.target.value)}
                placeholder="如 82"
                disabled={isSealed}
              />
            </label>
            <label>
              <span>滑油压力 MPa</span>
              <input
                value={fLub}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFLub(e.target.value)}
                placeholder="如 0.42"
                disabled={isSealed}
              />
            </label>
            <label>
              <span>冷却水温 ℃</span>
              <input
                value={fCoolant}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFCoolant(e.target.value)}
                placeholder="如 78"
                disabled={isSealed}
              />
            </label>
            <label>
              <span>累计燃油读数 L（相邻读数折算小时油耗）</span>
              <input
                value={fFuel}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFFuel(e.target.value)}
                placeholder="如 2280"
                disabled={isSealed}
              />
              <small className="field-hint">{lastReadingHint}</small>
            </label>
            <label>
              <span>舱底水状态</span>
              <select
                value={fBilge}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFBilge(e.target.value)}
                disabled={isSealed}
              >
                {BILGE_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-wide">
              <span>巡检 / 异常描述（必填）</span>
              <input
                value={fNote}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFNote(e.target.value)}
                placeholder="如 正常巡检 / 冷却水温偏高已复查"
                disabled={isSealed}
              />
            </label>
          </div>

          {formError && <p className="form-error">{formError}</p>}

          <div className="fuel-rule">
            折算规则：小时油耗 =（本次累计读数 − 同设备上一读数）÷ 间隔小时；再按转速立方规律折算到基准转速（主机
            85rpm、发电机 1500rpm），与同设备上一已交接且无复核异常的稳定班次均值对比，高
            20% 自动标为待复核。
          </div>
        </section>
      </section>

      <section className="panel handover">
        <div className="heading">
          <div>
            <p>交接班摘要</p>
            <h2>
              {selDate} {selWatch}
              {isSealed ? (
                <span className="tag tag-sealed">交接已完成</span>
              ) : (
                <span className="tag tag-open">未交接</span>
              )}
            </h2>
          </div>
          <div className="heading-actions">
            <button onClick={exportSummary}>导出摘要</button>
            <button
              className="primary"
              onClick={completeHandover}
              disabled={isSealed}
            >
              完成本班交接
            </button>
          </div>
        </div>

        <div className="handover-grid">
          <div>
            <small>确认油耗（已剔除待复核/工况未确认）</small>
            <strong>{confirmedFuelShift} L</strong>
          </div>
          <div>
            <small>剔除油耗（待闭环恢复）</small>
            <strong className={excludedFuelShift > 0 ? "warn-text" : ""}>
              {excludedFuelShift} L
            </strong>
          </div>
          <div>
            <small>本班记录 / 待闭环</small>
            <strong>
              {shiftRecords.length} / {blocking.length}
            </strong>
          </div>
        </div>

        {isSealed && sealedShift && (
          <div className="sealed-note">
            已于 {new Date(sealedShift.at).toLocaleString("zh-CN")} 封存：确认油耗{" "}
            {sealedShift.confirmedFuel}L，剔除 {sealedShift.excludedCount} 项
            {sealedShift.handoverNote ? `；${sealedShift.handoverNote}` : ""}
          </div>
        )}

        {!isSealed && (
          <>
            <label className="handover-input">
              <span>交接备注</span>
              <input
                value={handoverNote}
                onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setHandoverNote(e.target.value)}
                placeholder="如 主机运行平稳，发电机#2水温持续观察"
              />
            </label>
            {!canSeal ? (
              <p className="form-error">
                本班不能完成交接：
                {reasonMissing.length
                  ? `有 ${reasonMissing.length} 条待复核记录未填写原因（复检确认无效）；`
                  : ""}
                {blocking.length
                  ? `有 ${blocking.length} 条燃油读数尚在复核/待工况确认，未恢复统计。`
                  : ""}
                需完成「填写原因 → 复检确认 → 工况确认」闭环后方可交接。
              </p>
            ) : (
              <p className="form-ok">
                本班无待闭环项，确认油耗 {confirmedFuelShift}L 可写入交接摘要。
              </p>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>值班记录与异常时间线</p>
            <h2>
              {selDate} {selWatch} · {deviceFilter}
              <span className="record-count">{visibleRecords.length} 条</span>
            </h2>
          </div>
        </div>
        <div className="records">
          {visibleRecords.length === 0 && (
            <p className="empty">当前班次 / 设备下暂无记录。</p>
          )}
          {visibleRecords.map((r, index) => {
            const d = new Date(r.ts);
            return (
              <article key={r.id} className={reviewCls(r.review)}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <div className="rec-body">
                  <div className="rec-head">
                    <h3>
                      {r.equipment} · {pad2(d.getHours())}:{pad2(d.getMinutes())}
                    </h3>
                    <ReviewBadge review={r.review} deviation={r.deviation} />
                  </div>
                  <p className="rec-line">
                    {[
                      r.rpm !== null ? `转速 ${r.rpm}rpm` : "",
                      r.lubPressure !== null ? `滑油 ${r.lubPressure}MPa` : "",
                      r.coolantTemp !== null ? `水温 ${r.coolantTemp}℃` : "",
                      r.fuelReading !== null ? `累计油 ${r.fuelReading}L` : "",
                      r.bilgeStatus ? `舱底水 ${r.bilgeStatus}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="rec-note">{r.note}</p>

                  {r.fuelDelta !== null && (
                    <p className="rec-fuel">
                      相邻读数间隔 {r.hoursElapsed}h，耗油 {r.fuelDelta}L → 实测{" "}
                      {r.hourlyFuel}L/h，转速折算{" "}
                      <b>{r.normalizedHourlyFuel}L/h</b>
                      {r.baselineHourlyFuel !== null && (
                        <>
                          {" "}
                          （上一稳定班次 {r.baselineHourlyFuel}L/h
                          {r.deviation !== null && (
                            <span
                              className={
                                r.deviation > DEVIATION_LIMIT ? "warn-text" : ""
                              }
                            >
                              ，比值 {r.deviation}
                            </span>
                          )}
                          ）
                        </>
                      )}
                      ；
                      <i
                        className={
                          isStatCounted(r) ? "stat-in" : "stat-out"
                        }
                      >
                        {isStatCounted(r) ? "已计入确认油耗" : "已从确认油耗剔除"}
                      </i>
                    </p>
                  )}

                  {(r.review === "pending" || r.review === "confirmed") && (
                    <div className="review-box">
                      <label className="review-reason">
                        <span>待复核原因 / 复检结论{!isSealed ? "" : "（班次已封存）"}</span>
                        <input
                          value={r.reviewReason}
                          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setReason(r.id, e.target.value)}
                          placeholder="必填，如 高负荷拖带工况、流量计校验偏差"
                          disabled={isSealed || r.review === "confirmed"}
                        />
                      </label>
                      <div className="review-actions">
                        <button
                          disabled={isSealed || r.review === "confirmed"}
                          onClick={() => confirmReview(r.id)}
                          title={
                            !r.reviewReason.trim() ? "原因未填写，确认无效" : ""
                          }
                        >
                          复检确认
                        </button>
                        <button
                          className="primary"
                          disabled={isSealed || r.review !== "confirmed"}
                          onClick={() => confirmCondition(r.id)}
                          title={
                            r.review !== "confirmed"
                              ? "需先完成复检确认"
                              : "确认工况，恢复统计"
                          }
                        >
                          工况确认并恢复统计
                        </button>
                      </div>
                      {r.review === "pending" && (
                        <small className="warn-text">
                          原因未填写时“复检确认”无效，且本班不能完成交接。
                        </small>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <footer className="foot">
        本地保存键 {STORAGE_KEY} · 清空浏览器站点数据可恢复示例数据
      </footer>
    </main>
  );
}

/* ================= 小组件 ================= */

function ReviewBadge({
  review,
  deviation,
}: {
  review: ReviewStatus;
  deviation: number | null;
}) {
  if (review === "pending")
    return (
      <span className="tag tag-pending">
        待复核{deviation !== null ? ` +${Math.round((deviation - 1) * 100)}%` : ""}
      </span>
    );
  if (review === "confirmed")
    return <span className="tag tag-confirmed">已复检·待工况确认</span>;
  if (review === "resolved")
    return <span className="tag tag-resolved">正常·计入统计</span>;
  return null;
}

function reviewCls(review: ReviewStatus): string {
  if (review === "pending") return "rec-pending";
  if (review === "confirmed") return "rec-confirmed";
  return "";
}

export default App;
