import { useEffect, useState } from "react";
import "./styles.css";

const project = {
  sourceNo: 1,
  id: "hxyfront-62001",
  port: 62001,
  title: "船舶轮机值班记录",
  prompt:
    "我想做一个面向船舶轮机值班的前端记录系统，轮机员可以记录主机转速、滑油压力、冷却水温、燃油消耗、舱底水状态和异常巡检项。页面需要有值班班次切换、机舱参数看板、异常记录时间线、交接班摘要和按设备筛选的历史记录。数据先保存在浏览器本地，后续方便扩展成船队统一管理。",
};

const SHIFTS = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"];
const EQUIPMENTS = ["主机", "发电机", "泵组", "舱底水"];
/** 各设备额定转速，用于把间隔小时折算成额定工况运转小时 */
const RATED_RPM: Record<string, number> = { 主机: 120, 发电机: 1500 };
const REVIEW_THRESHOLD = 1.2;
const STORAGE_KEY = "hxyfront-62001.watch.v1";
const HOUR_MS = 3_600_000;

type ReviewStatus = "normal" | "pending" | "confirmed";

const STATUS_META: Record<ReviewStatus, { text: string; cls: string }> = {
  normal: { text: "正常", cls: "ok" },
  pending: { text: "待复核", cls: "warn" },
  confirmed: { text: "已确认", cls: "done" },
};

interface WatchRecord {
  id: string;
  shift: string;
  equipment: string;
  fuelReading: number | null;
  rpm: number | null;
  lubePressure: string;
  coolantTemp: string;
  anomaly: string;
  note: string;
  createdAt: number;
  /** 相邻两次燃油读数差（L） */
  fuelUsed: number | null;
  intervalHours: number | null;
  /** 折算小时油耗（L/h，额定工况） */
  hourlyFuel: number | null;
  /** 同设备上一稳定班次的小时油耗基准 */
  baselineHourly: number | null;
  reviewStatus: ReviewStatus;
  reviewReason: string;
  reviewedAt: number | null;
}

interface RecordDraft {
  shift: string;
  equipment: string;
  fuelReading: number | null;
  rpm: number | null;
  lubePressure: string;
  coolantTemp: string;
  anomaly: string;
  note: string;
  createdAt: number;
}

function makeId(createdAt: number): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${createdAt}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 保存记录：用同设备相邻两次燃油读数与主机转速折算小时油耗，
 * 并对比同设备上一稳定班次，偏高 20% 以上标记为待复核。
 */
function appendRecord(existing: WatchRecord[], draft: RecordDraft): WatchRecord {
  const history = existing
    .filter((r) => r.equipment === draft.equipment && r.createdAt < draft.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt);
  const prev = history.length > 0 ? history[history.length - 1] : null;

  let fuelUsed: number | null = null;
  let intervalHours: number | null = null;
  let hourlyFuel: number | null = null;
  if (draft.fuelReading != null && prev?.fuelReading != null) {
    const used = draft.fuelReading - prev.fuelReading;
    const hours = (draft.createdAt - prev.createdAt) / HOUR_MS;
    const rated = RATED_RPM[draft.equipment] ?? 0;
    const loadFactor = rated > 0 && draft.rpm != null && draft.rpm > 0 ? draft.rpm / rated : 1;
    const equivHours = hours * loadFactor;
    if (used > 0 && equivHours > 0) {
      fuelUsed = used;
      intervalHours = hours;
      hourlyFuel = used / equivHours;
    }
  }

  const stable = [...history]
    .reverse()
    .find((r) => r.reviewStatus !== "pending" && r.hourlyFuel != null);
  const baselineHourly = stable?.hourlyFuel ?? null;
  const reviewStatus: ReviewStatus =
    hourlyFuel != null && baselineHourly != null && hourlyFuel > baselineHourly * REVIEW_THRESHOLD
      ? "pending"
      : "normal";

  return {
    id: makeId(draft.createdAt),
    ...draft,
    fuelUsed,
    intervalHours,
    hourlyFuel,
    baselineHourly,
    reviewStatus,
    reviewReason: "",
    reviewedAt: null,
  };
}

function buildSeeds(): WatchRecord[] {
  const now = Date.now();
  const drafts: RecordDraft[] = [
    { shift: "00-04班", equipment: "主机", fuelReading: 12840, rpm: 80, lubePressure: "0.42", coolantTemp: "76", anomaly: "正常巡检", note: "备车完成，工况平稳", createdAt: now - 20 * HOUR_MS },
    { shift: "04-08班", equipment: "主机", fuelReading: 13128, rpm: 82, lubePressure: "0.41", coolantTemp: "77", anomaly: "正常巡检", note: "", createdAt: now - 16 * HOUR_MS },
    { shift: "08-12班", equipment: "主机", fuelReading: 13420, rpm: 84, lubePressure: "0.42", coolantTemp: "78", anomaly: "正常巡检", note: "", createdAt: now - 12 * HOUR_MS },
    { shift: "08-12班", equipment: "发电机", fuelReading: 5210, rpm: 1480, lubePressure: "0.38", coolantTemp: "82", anomaly: "正常巡检", note: "并电运行", createdAt: now - 12 * HOUR_MS + 10 * 60_000 },
    { shift: "12-16班", equipment: "主机", fuelReading: 13800, rpm: 86, lubePressure: "0.40", coolantTemp: "81", anomaly: "主机负荷波动", note: "避让渔船多次加车", createdAt: now - 8 * HOUR_MS },
    { shift: "12-16班", equipment: "发电机", fuelReading: 5386, rpm: 1500, lubePressure: "0.37", coolantTemp: "85", anomaly: "冷却水温偏高", note: "已安排复查", createdAt: now - 8 * HOUR_MS + 10 * 60_000 },
    { shift: "16-20班", equipment: "主机", fuelReading: 14100, rpm: 84, lubePressure: "0.42", coolantTemp: "78", anomaly: "正常巡检", note: "", createdAt: now - 4 * HOUR_MS },
    { shift: "16-20班", equipment: "泵组", fuelReading: null, rpm: null, lubePressure: "", coolantTemp: "", anomaly: "正常巡检", note: "备用泵自启动试验正常", createdAt: now - 4 * HOUR_MS + 20 * 60_000 },
    { shift: "16-20班", equipment: "舱底水", fuelReading: null, rpm: null, lubePressure: "", coolantTemp: "", anomaly: "液位接近警戒线", note: "已记录交班", createdAt: now - 4 * HOUR_MS + 30 * 60_000 },
  ];
  return drafts.reduce<WatchRecord[]>((acc, draft) => [...acc, appendRecord(acc, draft)], []);
}

interface Persisted {
  records: WatchRecord[];
  handovers: Record<string, number>;
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      if (Array.isArray(parsed.records)) {
        return { records: parsed.records, handovers: parsed.handovers ?? {} };
      }
    }
  } catch {
    /* 本地数据不可用时回退到示例数据 */
  }
  return { records: buildSeeds(), handovers: {} };
}

const pad = (n: number) => String(n).padStart(2, "0");

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function App() {
  const [persisted] = useState(loadPersisted);
  const [records, setRecords] = useState<WatchRecord[]>(persisted.records);
  const [handovers, setHandovers] = useState<Record<string, number>>(persisted.handovers);
  const [shift, setShift] = useState<string>("12-16班");
  const [equipFilter, setEquipFilter] = useState<string>("全部");
  const [notice, setNotice] = useState<string>("");
  const [form, setForm] = useState({
    shift: "12-16班",
    equipment: "主机",
    fuelReading: "",
    rpm: "",
    lubePressure: "",
    coolantTemp: "",
    anomaly: "",
    note: "",
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ records, handovers }));
    } catch {
      /* 本地存储不可用时忽略 */
    }
  }, [records, handovers]);

  const inShift = records.filter((r) => r.shift === shift);
  const scoped = inShift
    .filter((r) => equipFilter === "全部" || r.equipment === equipFilter)
    .sort((a, b) => b.createdAt - a.createdAt);

  /* 看板：跟随班次与设备筛选，待复核记录不计入油耗统计 */
  const latestRpm = scoped.find((r) => r.rpm != null)?.rpm ?? null;
  const latestLube = scoped.find((r) => r.lubePressure.trim() !== "")?.lubePressure ?? "";
  const latestTemp = scoped.find((r) => r.coolantTemp.trim() !== "")?.coolantTemp ?? "";
  const scopedConfirmed = scoped.filter((r) => r.reviewStatus !== "pending" && r.hourlyFuel != null);
  const avgHourly =
    scopedConfirmed.length > 0
      ? scopedConfirmed.reduce((sum, r) => sum + (r.hourlyFuel ?? 0), 0) / scopedConfirmed.length
      : null;
  const pendingScoped = scoped.filter((r) => r.reviewStatus === "pending");
  const missingReasonScoped = pendingScoped.filter((r) => r.reviewReason.trim() === "");

  const metricCards = [
    { label: "主机转速", value: latestRpm != null ? `${latestRpm} rpm` : "—", sub: "筛选范围最新读数" },
    { label: "滑油压力", value: latestLube ? `${latestLube} MPa` : "—", sub: "筛选范围最新读数" },
    { label: "冷却水温", value: latestTemp ? `${latestTemp} ℃` : "—", sub: "筛选范围最新读数" },
    {
      label: "确认小时油耗",
      value: avgHourly != null ? `${avgHourly.toFixed(1)} L/h` : "—",
      sub: "待复核记录已剔除",
    },
    {
      label: "待复核",
      value: `${pendingScoped.length} 条`,
      sub:
        pendingScoped.length === 0
          ? "当前范围无待复核"
          : missingReasonScoped.length > 0
            ? `原因未填写 ${missingReasonScoped.length} 条`
            : "待复检确认",
    },
  ];

  /* 交接班摘要：按班次统计，确认油耗剔除待复核记录 */
  const confirmedFuel = inShift
    .filter((r) => r.reviewStatus !== "pending")
    .reduce((sum, r) => sum + (r.fuelUsed ?? 0), 0);
  const excludedFuel = inShift
    .filter((r) => r.reviewStatus === "pending")
    .reduce((sum, r) => sum + (r.fuelUsed ?? 0), 0);
  const shiftConfirmed = inShift.filter((r) => r.reviewStatus !== "pending" && r.hourlyFuel != null);
  const avgShiftHourly =
    shiftConfirmed.length > 0
      ? shiftConfirmed.reduce((sum, r) => sum + (r.hourlyFuel ?? 0), 0) / shiftConfirmed.length
      : null;
  const pendingShift = inShift.filter((r) => r.reviewStatus === "pending");
  const missingReasonShift = pendingShift.filter((r) => r.reviewReason.trim() === "");
  const handedAt = handovers[shift];
  const canHandover = !handedAt && inShift.length > 0 && pendingShift.length === 0;
  const handoverHint = handedAt
    ? `本班已于 ${fmtTime(handedAt)} 完成交接。`
    : missingReasonShift.length > 0
      ? `有 ${missingReasonShift.length} 条待复核记录未填写原因，复检确认无效，本班不能完成交接。`
      : pendingShift.length > 0
        ? "待复核记录已填写原因，完成复检确认（工况确认）后方可交接。"
        : inShift.length > 0
          ? "本班记录均已确认，可完成交接。"
          : "本班暂无记录。";

  const pickShift = (s: string) => {
    setShift(s);
    setForm((f) => ({ ...f, shift: s }));
  };

  const pickEquipment = (e: string) => {
    setEquipFilter(e);
    if (e !== "全部") setForm((f) => ({ ...f, equipment: e }));
  };

  const saveRecord = () => {
    const fuelReading = form.fuelReading.trim() === "" ? null : Number(form.fuelReading);
    const rpm = form.rpm.trim() === "" ? null : Number(form.rpm);
    if (fuelReading != null && !Number.isFinite(fuelReading)) {
      setNotice("燃油读数格式不正确，请填写数字。");
      return;
    }
    if (rpm != null && !Number.isFinite(rpm)) {
      setNotice("主机转速格式不正确，请填写数字。");
      return;
    }
    const draft: RecordDraft = {
      shift: form.shift,
      equipment: form.equipment,
      fuelReading,
      rpm,
      lubePressure: form.lubePressure.trim(),
      coolantTemp: form.coolantTemp.trim(),
      anomaly: form.anomaly.trim() || "正常巡检",
      note: form.note.trim(),
      createdAt: Date.now(),
    };
    const record = appendRecord(records, draft);
    setRecords((prev) => [...prev, record]);
    setShift(record.shift);
    setEquipFilter((f) => (f === "全部" || f === record.equipment ? f : record.equipment));
    if (record.reviewStatus === "pending" && record.hourlyFuel != null && record.baselineHourly != null) {
      const pct = Math.round((record.hourlyFuel / record.baselineHourly - 1) * 100);
      setNotice(
        `已保存：折算小时油耗 ${record.hourlyFuel.toFixed(1)} L/h，较同设备上一稳定班次 ${record.baselineHourly.toFixed(1)} L/h 偏高 ${pct}%，已标记待复核并从确认油耗中剔除。`
      );
    } else if (record.hourlyFuel != null) {
      setNotice(
        `已保存：折算小时油耗 ${record.hourlyFuel.toFixed(1)} L/h${
          record.baselineHourly != null
            ? `（稳定班次基准 ${record.baselineHourly.toFixed(1)} L/h）`
            : "（同设备首个可折算记录）"
        }，状态正常。`
      );
    } else {
      setNotice("已保存：缺少相邻燃油读数或运转数据，未折算小时油耗。");
    }
    setForm((f) => ({ ...f, fuelReading: "", rpm: "", anomaly: "", note: "" }));
  };

  const updateReason = (id: string, reason: string) =>
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, reviewReason: reason } : r)));

  /* 复检确认：原因未填写时确认无效；确认后恢复计入统计 */
  const confirmReview = (id: string) =>
    setRecords((prev) =>
      prev.map((r) =>
        r.id === id && r.reviewStatus === "pending" && r.reviewReason.trim() !== ""
          ? { ...r, reviewStatus: "confirmed" as ReviewStatus, reviewedAt: Date.now() }
          : r
      )
    );

  const completeHandover = () => {
    if (!canHandover) return;
    setHandovers((prev) => ({ ...prev, [shift]: Date.now() }));
  };

  const exportSummary = () => {
    const sorted = [...inShift].sort((a, b) => a.createdAt - b.createdAt);
    const lines = [
      "船舶轮机值班交接摘要",
      `班次：${shift}`,
      `导出时间：${fmtTime(Date.now())}`,
      `记录数：${inShift.length}（待复核 ${pendingShift.length}）`,
      `确认油耗合计：${confirmedFuel.toFixed(1)} L`,
      `待复核剔除油耗：${excludedFuel.toFixed(1)} L`,
      `确认小时油耗均值：${avgShiftHourly != null ? `${avgShiftHourly.toFixed(1)} L/h` : "—"}`,
      `交接状态：${handedAt ? `已于 ${fmtTime(handedAt)} 完成交接` : "未交接"}`,
      "",
      "明细：",
      ...sorted.map(
        (r) =>
          `- ${fmtTime(r.createdAt)} ${r.equipment}｜读数 ${r.fuelReading ?? "—"} L｜转速 ${
            r.rpm ?? "—"
          } rpm｜小时油耗 ${r.hourlyFuel != null ? `${r.hourlyFuel.toFixed(1)} L/h` : "—"}｜${
            STATUS_META[r.reviewStatus].text
          }${r.reviewReason ? `｜原因：${r.reviewReason}` : ""}`
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `交接摘要-${shift}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetAll = () => {
    setRecords(buildSeeds());
    setHandovers({});
    setNotice("已恢复示例数据。");
  };

  return (
    <main className="app">
      <section className="hero">
        <p>
          {project.id} · 源提示词{project.sourceNo} · Port {project.port}
        </p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {metricCards.map((metric) => (
          <article key={metric.label}>
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
            <span>{metric.sub}</span>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <div className="filter-block">
            <h2>值班班次</h2>
            <div className="chips">
              {SHIFTS.map((s) => (
                <button key={s} className={s === shift ? "active" : ""} onClick={() => pickShift(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-block">
            <h2>设备筛选</h2>
            <div className="chips">
              {["全部", ...EQUIPMENTS].map((e) => (
                <button key={e} className={e === equipFilter ? "active" : ""} onClick={() => pickEquipment(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-block">
            <h2>本地数据</h2>
            <p className="aside-note">记录与交接状态保存在浏览器本地，后续可扩展为船队统一管理。</p>
            <button onClick={resetAll}>重置示例数据</button>
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary" onClick={saveRecord}>
              保存记录
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>值班班次</span>
              <select value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })}>
                {SHIFTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>设备名称</span>
              <select value={form.equipment} onChange={(e) => setForm({ ...form, equipment: e.target.value })}>
                {EQUIPMENTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>燃油读数（累计 L）</span>
              <input
                type="number"
                placeholder="如 14400"
                value={form.fuelReading}
                onChange={(e) => setForm({ ...form, fuelReading: e.target.value })}
              />
            </label>
            <label>
              <span>主机转速（rpm）</span>
              <input
                type="number"
                placeholder="如 84"
                value={form.rpm}
                onChange={(e) => setForm({ ...form, rpm: e.target.value })}
              />
            </label>
            <label>
              <span>滑油压力（MPa）</span>
              <input
                placeholder="如 0.42"
                value={form.lubePressure}
                onChange={(e) => setForm({ ...form, lubePressure: e.target.value })}
              />
            </label>
            <label>
              <span>冷却水温（℃）</span>
              <input
                type="number"
                placeholder="如 78"
                value={form.coolantTemp}
                onChange={(e) => setForm({ ...form, coolantTemp: e.target.value })}
              />
            </label>
            <label>
              <span>异常描述</span>
              <input
                placeholder="正常巡检"
                value={form.anomaly}
                onChange={(e) => setForm({ ...form, anomaly: e.target.value })}
              />
            </label>
            <label>
              <span>交接备注</span>
              <input
                placeholder="填写交接备注"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
          </div>
          <p className="formula">
            小时油耗 = 相邻两次燃油读数差 ÷（间隔小时 × 主机转速/额定转速）；高于同设备上一稳定班次 20%
            自动标记待复核，工况确认后恢复统计。
          </p>
          {notice && <p className="notice">{notice}</p>}
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>交接班摘要</p>
            <h2>{shift} · 确认油耗与交接</h2>
          </div>
          <div className="heading-actions">
            <button onClick={exportSummary}>导出摘要</button>
            <button className="primary" disabled={!canHandover} onClick={completeHandover}>
              {handedAt ? "已完成交接" : "完成交接"}
            </button>
          </div>
        </div>
        <div className="summary-grid">
          <article>
            <small>确认油耗合计</small>
            <strong>{confirmedFuel.toFixed(0)} L</strong>
            <span>待复核 {excludedFuel.toFixed(0)} L 已剔除</span>
          </article>
          <article>
            <small>确认小时油耗均值</small>
            <strong>{avgShiftHourly != null ? `${avgShiftHourly.toFixed(1)} L/h` : "—"}</strong>
            <span>工况确认后恢复统计</span>
          </article>
          <article>
            <small>本班记录</small>
            <strong>{inShift.length} 条</strong>
            <span>待复核 {pendingShift.length} 条</span>
          </article>
          <article>
            <small>交接状态</small>
            <strong>{handedAt ? "已交接" : "未交接"}</strong>
            <span>{handedAt ? fmtTime(handedAt) : "交接前需完成全部复核"}</span>
          </article>
        </div>
        <p className={`handover-hint ${canHandover || handedAt ? "ok" : "blocked"}`}>{handoverHint}</p>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>
              值班记录时间线 · {shift} · {equipFilter}
            </h2>
          </div>
        </div>
        <div className="records">
          {scoped.length === 0 && <p className="empty">当前班次与设备筛选下暂无记录。</p>}
          {scoped.map((r, index) => {
            const meta = STATUS_META[r.reviewStatus];
            const isAbnormal = r.anomaly.trim() !== "" && !r.anomaly.includes("正常");
            const parts: string[] = [];
            if (r.fuelReading != null) parts.push(`燃油读数 ${r.fuelReading} L`);
            if (r.rpm != null) parts.push(`转速 ${r.rpm} rpm`);
            if (r.fuelUsed != null) parts.push(`耗油 ${r.fuelUsed.toFixed(0)} L`);
            if (r.hourlyFuel != null) parts.push(`折算 ${r.hourlyFuel.toFixed(1)} L/h`);
            if (r.hourlyFuel != null && r.baselineHourly != null) {
              const pct = Math.round((r.hourlyFuel / r.baselineHourly - 1) * 100);
              parts.push(`稳定基准 ${r.baselineHourly.toFixed(1)}（${pct >= 0 ? "+" : ""}${pct}%）`);
            }
            if (r.lubePressure) parts.push(`滑油 ${r.lubePressure} MPa`);
            if (r.coolantTemp) parts.push(`水温 ${r.coolantTemp} ℃`);
            return (
              <article key={r.id} className={isAbnormal ? "abnormal" : ""}>
                <b>{pad(index + 1)}</b>
                <div>
                  <h3>
                    {r.equipment} · {r.shift} · {fmtTime(r.createdAt)}
                    <span className={`badge ${meta.cls}`}>{meta.text}</span>
                    {isAbnormal && <span className="badge warn">异常</span>}
                  </h3>
                  <p>{parts.length > 0 ? parts.join(" · ") : "无运转参数"}</p>
                  <p>
                    {r.anomaly}
                    {r.note ? ` · 备注：${r.note}` : ""}
                  </p>
                  {r.reviewStatus === "pending" && (
                    <div className="review-box">
                      <label>
                        <span>待复核原因（工况说明）</span>
                        <input
                          placeholder="如：主机加车、海况恶劣、读数异常……"
                          value={r.reviewReason}
                          onChange={(e) => updateReason(r.id, e.target.value)}
                        />
                      </label>
                      <div className="review-actions">
                        <button
                          className="primary"
                          disabled={r.reviewReason.trim() === ""}
                          onClick={() => confirmReview(r.id)}
                        >
                          复检确认
                        </button>
                        <em>
                          {r.reviewReason.trim() === ""
                            ? "待复核原因未填写，复检确认无效，本班不能完成交接"
                            : "确认后恢复计入确认油耗与看板统计"}
                        </em>
                      </div>
                    </div>
                  )}
                  {r.reviewStatus === "confirmed" && (
                    <p className="review-done">
                      工况确认：{r.reviewReason} · 已于 {r.reviewedAt != null ? fmtTime(r.reviewedAt) : "—"}{" "}
                      复检确认，油耗已恢复统计
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

export default App;
