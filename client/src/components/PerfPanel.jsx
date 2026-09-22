// PerfPanel.jsx
// 性能分析：展示转移次数、回溯次数、访问状态总数，并根据相对输入长度的
// 增长曲线提示平方级/指数级风险，给出改写建议。

import React from 'react';

export default function PerfPanel({ metrics, analysis, engine, input }) {
  if (!metrics) return <div className="muted small">运行一次匹配后展示统计。</div>;
  const n = metrics.inputLength;
  const t = metrics.edgeAttempts || metrics.transitions || 0;
  const ratio = n > 0 ? (t / n).toFixed(1) : '–';
  const growthHint = detectGrowth(metrics, analysis);

  return (
    <div className="perf-panel">
      <div className="perf-grid">
        <Metric label="状态转移次数" value={metrics.transitions} />
        <Metric label="边尝试总数" value={metrics.edgeAttempts ?? '–'} />
        <Metric label="回溯次数" value={metrics.backtracks ?? 0} danger={metrics.backtracks > n * 4} />
        <Metric label="访问状态总数" value={metrics.visitedStates} />
        <Metric label="输入长度 n" value={n} />
        <Metric label="步数 / n" value={ratio} />
      </div>

      {engine !== 'backtracking' && (
        <div className="perf-note">
          {engine === 'dfa' || engine === 'minDFA'
            ? 'DFA 模式没有回溯：每读一个字符只走一次确定性转移，步数严格 O(n)。'
            : 'NFA 子集模拟也不回溯：它同时保留所有可能的活跃状态，用“集合合并”代替“选择—失败—回退”。'}
        </div>
      )}

      {metrics.capped && (
        <div className="danger-box">
          ⛔ {metrics.abortReason || '步数超限，引擎强制终止。'}
        </div>
      )}

      {growthHint && engine === 'backtracking' && (
        <div className={growthHint.level === 'exponential' ? 'danger-box' : 'warn-box'}>
          <b>{growthHint.title}</b>
          <div>{growthHint.body}</div>
        </div>
      )}

      {analysis && engine === 'backtracking' && (
        <div className="analysis-box">
          <div className="analysis-title">
            灾难性回溯分析
            <span className={`pill ${analysis.classification === 'exponential' ? 'bad' : analysis.classification === 'quadratic-or-worse' ? 'warn' : 'ok'}`}>
              {labelClass(analysis.classification)}
            </span>
          </div>
          {analysis.warnings?.length === 0 && <div className="small muted">静态结构扫描未发现嵌套/重叠量词。</div>}
          {analysis.warnings?.map((w, i) => (
            <div key={i} className={`warning-item ${w.severity === 'exponential' ? 'bad' : ''}`}>
              <code>{w.pattern}</code>
              <div>{w.title}：{w.detail}</div>
            </div>
          ))}
          {analysis.empirical && (
            <div className="probe">
              <div className="small muted">经验探针（输入“{analysis.empirical.probeChar}”重复 n 次 + 非法尾字符）：</div>
              <table className="probe-table">
                <thead><tr><th>n</th>{analysis.empirical.samples.map((s) => <th key={s.length}>{s.length}</th>)}</tr></thead>
                <tbody><tr><td>步数</td>{analysis.empirical.samples.map((s, i) => (
                  <th key={i} className={s.capped ? 'cap' : ''}>{s.capped ? `≥${s.attempts}` : s.attempts}</th>
                ))}</tr></tbody>
              </table>
            </div>
          )}
          {analysis.empirical?.suggestion && (
            <ul className="suggestions">
              {analysis.empirical.suggestion.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, danger }) {
  return (
    <div className={`metric ${danger ? 'danger' : ''}`}>
      <div className="m-value">{value}</div>
      <div className="m-label">{label}</div>
    </div>
  );
}

function detectGrowth(metrics, analysis) {
  if (metrics.capped) {
    return { level: 'exponential', title: '检测到灾难性回溯迹象', body: '步数在引擎上限处被截断，输入再长就会挂起。这是指数级爆炸的强信号，建议立即改写。' };
  }
  const n = metrics.inputLength;
  if (n >= 4 && metrics.backtracks > n * n) {
    return { level: 'exponential', title: '回溯次数超过 n²', body: `回溯 ${metrics.backtracks} 次，而 n=${n}，n²=${n * n}。增长已快于平方级。` };
  }
  if (n >= 4 && metrics.transitions > n * n * 0.8) {
    return { level: 'quadratic', title: '可能存在平方级回溯', body: `转移 ${metrics.transitions} 次，约为 n² 量级。长输入下会明显变慢。` };
  }
  if (analysis?.dangerous && n > 0) {
    return { level: 'exponential', title: '静态结构高度危险', body: '当前测试串也许还短，但结构分析已确认存在指数爆炸路径，换一条“几乎匹配”的串就会触发。' };
  }
  return null;
}

function labelClass(c) {
  if (c === 'exponential') return '指数级爆炸';
  if (c === 'quadratic-or-worse') return '平方级或更高';
  return '线性或更好';
}
