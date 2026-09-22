// App.jsx
// 页面编排：
//   左：正则输入（实时解析、错误定位）+ AST 树（悬停联动）+ 案例
//   中：自动机构造三阶段（NFA / DFA / 最小化）逐帧动画
//   右/下：匹配演示（三引擎切换）、播放控制、性能分析、贪婪懒惰对比

import React, { useEffect, useMemo, useState } from 'react';
import { api } from './state/api.js';
import PatternInput from './components/PatternInput.jsx';
import AstTree from './components/AstTree.jsx';
import ConstructionPlayer from './components/ConstructionPlayer.jsx';
import MatchPlayer from './components/MatchPlayer.jsx';
import PerfPanel from './components/PerfPanel.jsx';
import ExamplesBar from './components/ExamplesBar.jsx';
import ModeCompare from './components/ModeCompare.jsx';

const DEFAULT_PATTERN = '(a+)+b';
const DEFAULT_INPUT = 'aaaaaaa!';

export default function App() {
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [input, setInput] = useState(DEFAULT_INPUT);
  const [ast, setAst] = useState(null);
  const [groupCount, setGroupCount] = useState(0);
  const [hoverSpan, setHoverSpan] = useState(null);
  const [hoverAstId, setHoverAstId] = useState(null);
  const [phase, setPhase] = useState('nfa'); // nfa | dfa | min
  const [engine, setEngine] = useState('backtracking');
  const [mode, setMode] = useState('greedy');
  const [compileData, setCompileData] = useState(null);
  const [compileErr, setCompileErr] = useState(null);
  const [matchData, setMatchData] = useState(null);
  const [matchErr, setMatchErr] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [dfaLimit, setDfaLimit] = useState(256);
  const [tab, setTab] = useState('run'); // run | compare
  const [loading, setLoading] = useState(false);

  // 编译（ast 有效时）
  useEffect(() => {
    if (!ast) { setCompileData(null); return; }
    let cancelled = false;
    setLoading(true);
    api
      .compile(pattern, {
        dfaLimit,
        verifyStrings: [input, '', 'a', 'aa', 'abc', '123', 'aaa'],
      })
      .then((res) => { if (!cancelled) { setCompileData(res); setCompileErr(null); } })
      .catch((e) => { if (!cancelled) setCompileErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ast, pattern, dfaLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  // 分析
  useEffect(() => {
    if (!ast) { setAnalysis(null); return; }
    api.analyze(pattern).then((res) => setAnalysis(res.analysis)).catch(() => setAnalysis(null));
  }, [ast, pattern]);

  // 匹配（引擎/串变化时自动跑）
  useEffect(() => {
    if (!compileData) { setMatchData(null); return; }
    let cancelled = false;
    api
      .match(pattern, input, engine, mode)
      .then((res) => { if (!cancelled) { setMatchData(res); setMatchErr(null); } })
      .catch((e) => { if (!cancelled) setMatchErr(e.message); });
    return () => { cancelled = true; };
  }, [compileData, pattern, input, engine, mode]);

  const matchGraph = useMemo(() => {
    if (!compileData) return null;
    if (engine === 'backtracking' || engine === 'nfa') return compileData.nfa;
    if (engine === 'dfa') return compileData.dfa;
    if (engine === 'minDFA') return compileData.minDFA;
    return null;
  }, [compileData, engine]);

  // 贪婪/懒惰对比需要两张按不同全局模式构造的 NFA（后端接口内部自行构造，
  // 画布只需要图结构；这里复用 compile 的贪婪 NFA 与按懒惰重取的数据）。
  const nfaLazy = useMemo(() => compileData?.nfa, [compileData]); // 结构相同，仅边顺序差异在引擎内部翻转
  const nfaGreedy = compileData?.nfa;

  const loadExample = ({ pattern: p, test }) => {
    setPattern(p);
    setInput(test || '');
    setTab('run');
    setEngine('backtracking');
    setPhase('nfa');
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="title">
          <span className="logo">⟬␦⟭</span>
          <h1>正则可视化调试器</h1>
          <span className="subtitle">Thompson NFA → 子集构造 DFA → 最小化 · 逐帧播放构造、匹配与回溯</span>
        </div>
        <div className="header-right">
          <label className="limit-label">
            DFA 状态上限
            <input type="number" min="16" max="4096" value={dfaLimit} onChange={(e) => setDfaLimit(Number(e.target.value) || 256)} />
          </label>
        </div>
      </header>

      <div className="layout">
        {/* 左侧 */}
        <aside className="sidebar">
          <PatternInput
            pattern={pattern}
            setPattern={setPattern}
            onAst={(a, gc) => { setAst(a); setGroupCount(gc || 0); }}
            hoverSpan={hoverSpan}
            setHoverAstId={setHoverAstId}
          />
          <div className="sidebar-section">
            <div className="section-head">
              抽象语法树 AST
              {groupCount > 0 && <span className="pill ok">{groupCount} 个捕获组</span>}
            </div>
            <div className="ast-container">
              <AstTree ast={ast} hoverId={hoverAstId} setHoverId={setHoverAstId} onHoverSpan={setHoverSpan} />
            </div>
          </div>
          <ExamplesBar onLoad={loadExample} />
        </aside>

        {/* 中间：构造 + 匹配 */}
        <main className="main">
          <div className="tabs construct-tabs">
            <Tab id="nfa" cur={phase} set={setPhase} label="① Thompson 构造 NFA" />
            <Tab id="dfa" cur={phase} set={setPhase} label="② 子集构造 DFA" />
            <Tab id="min" cur={phase} set={setPhase} label="③ DFA 最小化" disabled={!compileData?.minDFA} />
            <div className="grow" />
            {compileData?.verification && (
              <span className={`pill ${compileData.verification.allConsistent ? 'ok' : 'bad'}`}>
                {compileData.verification.allConsistent ? '三机结论一致 ✓' : '一致性校验失败 ✗'}
              </span>
            )}
          </div>

          {compileErr && <div className="error-banner">{compileErr}</div>}
          {loading && <div className="loading-bar">引擎计算中…</div>}
          <ConstructionPlayer compileData={compileData} phase={phase} />

          <div className="match-area">
            <div className="tabs">
              <Tab id="run" cur={tab} set={setTab} label="匹配演示" />
              <Tab id="compare" cur={tab} set={setTab} label="贪婪 / 懒惰 并排对比" />
              <div className="grow" />
            </div>

            {tab === 'run' && (
              <>
                <div className="match-toolbar">
                  <div className="engine-switch">
                    {[
                      ['backtracking', '回溯引擎'],
                      ['nfa', 'NFA 子集模拟'],
                      ['dfa', 'DFA'],
                      ['minDFA', '最小 DFA'],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={`seg ${engine === id ? 'active' : ''}`}
                        disabled={id === 'minDFA' && !compileData?.minDFA}
                        onClick={() => setEngine(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {engine === 'backtracking' && (
                    <div className="mode-switch">
                      <button className={`seg sm ${mode === 'greedy' ? 'active' : ''}`} onClick={() => setMode('greedy')}>贪婪</button>
                      <button className={`seg sm ${mode === 'lazy' ? 'active' : ''}`} onClick={() => setMode('lazy')}>懒惰</button>
                    </div>
                  )}
                  <input
                    className="test-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="测试字符串"
                  />
                </div>
                {matchErr && <div className="error-banner">{matchErr}</div>}
                {matchData && (
                  <MatchPlayer
                    graph={matchGraph}
                    kind={engine === 'backtracking' ? 'backtracking' : engine}
                    frames={matchData.frames}
                    metrics={matchData.metrics}
                    input={input}
                    result={matchData.result}
                    engineLabel={
                      engine === 'backtracking'
                        ? `回溯引擎 · ${mode === 'greedy' ? '贪婪' : '懒惰'}`
                        : engine === 'nfa' ? 'NFA 子集模拟（活跃状态集合）' : engine === 'dfa' ? 'DFA（唯一当前状态）' : '最小 DFA'
                    }
                  />
                )}
                {matchData && <PerfPanel metrics={matchData.metrics} analysis={analysis} engine={engine} input={input} />}
              </>
            )}

            {tab === 'compare' && compileData && (
              <>
                <div className="compare-toolbar">
                  <input className="test-input" value={input} onChange={(e) => setInput(e.target.value)} />
                  <div className="muted small">同一条正则、同一个串；注意两条 ε 选择边的尝试顺序相反。</div>
                </div>
                <ModeCompare pattern={pattern} input={input} nfaGreedy={nfaGreedy} nfaLazy={nfaLazy} />
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function Tab({ id, cur, set, label, disabled }) {
  return (
    <button className={`tab ${cur === id ? 'active' : ''}`} disabled={disabled} onClick={() => set(id)}>
      {label}
    </button>
  );
}
