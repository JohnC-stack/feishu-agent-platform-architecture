const navigation = [
  ['总览', '当前'],
  ['任务中心', 'P2'],
  ['会话中心', 'P2'],
  ['队列与 Worker', 'P2'],
  ['执行器与沙箱', 'P3'],
  ['系统集成', 'P4'],
  ['审批中心', 'P5'],
  ['用户与权限', 'P5'],
  ['Token 与成本', 'P6'],
  ['日志与 Trace', 'P6'],
  ['告警中心', 'P6'],
  ['配置中心', 'P6'],
  ['发布与备份', 'P7'],
] as const;

const services = [
  { name: 'Control API', port: '3000', state: '基线就绪', tone: 'green' },
  { name: 'Feishu Gateway', port: '3100', state: '等待 P1 接入', tone: 'blue' },
  { name: 'Windows Worker', port: '3200', state: '协议就绪', tone: 'purple' },
] as const;

const milestones = [
  { phase: 'P0', name: '工程基线', state: '进行中' },
  { phase: 'P1', name: '飞书 WSS PoC', state: '待开始' },
  { phase: 'P2', name: '调度与数据', state: '待开始' },
  { phase: 'P3', name: '三类执行器', state: '待开始' },
] as const;

export function App() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">A</span>
          <span>
            <strong>Feishu Agent</strong>
            <small>Enterprise Platform</small>
          </span>
        </div>
        <nav aria-label="平台功能">
          {navigation.map(([label, phase], index) => (
            <button
              className={index === 0 ? 'navItem active' : 'navItem'}
              key={label}
              type="button"
            >
              <span>{label}</span>
              <small>{phase}</small>
            </button>
          ))}
        </nav>
        <div className="sidebarFooter">
          <span className="statusDot" />
          P0 本地开发环境
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">PLATFORM OVERVIEW</p>
            <h1>平台工程基线</h1>
          </div>
          <div className="phaseBadge">P0 · 实施中</div>
        </header>

        <section className="hero">
          <div>
            <span className="heroLabel">当前目标</span>
            <h2>建立可构建、可测试、可观测的基础平台</h2>
            <p>三类执行器共享契约，Windows 执行面与 Linux 控制面保持清晰边界。</p>
          </div>
          <div className="progressRing" aria-label="P0 完成进度 80%">
            <strong>80%</strong>
            <span>P0</span>
          </div>
        </section>

        <section className="metricGrid" aria-label="工程指标">
          <article>
            <span>应用</span>
            <strong>4</strong>
            <small>Web + 3 个服务</small>
          </article>
          <article>
            <span>共享包</span>
            <strong>7</strong>
            <small>契约、策略、数据等</small>
          </article>
          <article>
            <span>执行器类型</span>
            <strong>3</strong>
            <small>统一事件协议</small>
          </article>
          <article>
            <span>公网入站</span>
            <strong>0</strong>
            <small>默认全部关闭</small>
          </article>
        </section>

        <div className="contentGrid">
          <section className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">RUNTIME</p>
                <h3>服务基线</h3>
              </div>
              <span>健康端点已统一</span>
            </div>
            <div className="serviceList">
              {services.map((service) => (
                <article className="serviceRow" key={service.name}>
                  <span className={`serviceIcon ${service.tone}`}>{service.name[0]}</span>
                  <div>
                    <strong>{service.name}</strong>
                    <small>127.0.0.1:{service.port}</small>
                  </div>
                  <span className={`serviceState ${service.tone}`}>{service.state}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">ROADMAP</p>
                <h3>实施阶段</h3>
              </div>
              <span>共 20 周</span>
            </div>
            <div className="timeline">
              {milestones.map((milestone, index) => (
                <article
                  className={index === 0 ? 'milestone current' : 'milestone'}
                  key={milestone.phase}
                >
                  <span>{milestone.phase}</span>
                  <div>
                    <strong>{milestone.name}</strong>
                    <small>{milestone.state}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
