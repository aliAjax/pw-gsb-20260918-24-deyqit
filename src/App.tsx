import "./styles.css";

const project = {
  "sourceNo": 1,
  "id": "hxyfront-62001",
  "port": 62001,
  "title": "船舶轮机值班记录",
  "domain": "船舶轮机",
  "prompt": "我想做一个面向船舶轮机值班的前端记录系统，轮机员可以记录主机转速、滑油压力、冷却水温、燃油消耗、舱底水状态和异常巡检项。页面需要有值班班次切换、机舱参数看板、异常记录时间线、交接班摘要和按设备筛选的历史记录。数据先保存在浏览器本地，后续方便扩展成船队统一管理。",
  "palette": [
    "#0f766e",
    "#2563eb",
    "#f97316"
  ],
  "metrics": [
    "主机转速",
    "滑油压力",
    "冷却水温",
    "燃油消耗"
  ],
  "filters": [
    "主机",
    "发电机",
    "泵组",
    "舱底水"
  ],
  "fields": [
    "值班班次",
    "设备名称",
    "参数读数",
    "异常描述",
    "处理状态",
    "交接备注"
  ],
  "records": [
    [
      "08-12班",
      "主机",
      "转速82rpm，滑油压力0.42MPa",
      "正常巡检"
    ],
    [
      "12-16班",
      "发电机#2",
      "冷却水温偏高",
      "已安排复查"
    ],
    [
      "16-20班",
      "舱底水",
      "液位接近警戒线",
      "已记录交班"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[86, 14, 7, 32][index] ?? 12}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}筛选</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存草稿</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>近期工作台</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
