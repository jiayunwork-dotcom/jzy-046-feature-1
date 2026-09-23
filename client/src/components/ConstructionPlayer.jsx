// ConstructionPlayer.js
// 自动机构造动画播放器：NFA 的 Thompson 规则、DFA 的子集合并、最小化的
// 等价类分裂与合并，都按后端给的 steps 顺序逐帧播放。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import GraphCanvas from '../canvas/GraphCanvas.jsx';
import PlayerControls from './PlayerControls.jsx';
import { nfaPositions, layeredPositions, bounds } from '../canvas/graphLayout.js';

export default function ConstructionPlayer({ compileData, phase }) {
  // phase: 'nfa' | 'dfa' | 'min'
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timer = useRef(null);

  const blocked = !!compileData?.nonDeterminizable;

  const model = useMemo(() => {
    if (!compileData || blocked) return null;
    if (phase === 'nfa') {
      return {
        kind: 'nfa',
        steps: compileData.nfa.steps,
        fullStates: compileData.nfa.states,
        fullEdges: compileData.nfa.edges,
        startId: compileData.nfa.start,
      };
    }
    if (phase === 'dfa') {
      return {
        kind: 'dfa',
        steps: compileData.dfa.steps,
        startId: compileData.dfa.start,
        symbols: compileData.dfa.symbols,
      };
    }
    return {
      kind: 'minDFA',
      steps: compileData.minDFA?.steps || [],
      startId: compileData.minDFA?.start,
      symbols: compileData.minDFA?.symbols || [],
    };
  }, [compileData, phase, blocked]);

  useEffect(() => { setStepIdx(0); setPlaying(false); }, [phase, compileData]);

  useEffect(() => {
    if (!playing || !model) return;
    timer.current = setInterval(() => {
      setStepIdx((i) => {
        if (i >= model.steps.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, Math.max(120, 900 / speed));
    return () => clearInterval(timer.current);
  }, [playing, speed, model]);

  const frame = useMemo(() => {
    if (!model) return null;
    if (phase === 'nfa') return buildNFAFrame(model, stepIdx);
    if (phase === 'dfa') return buildDFAFrame(compileData.dfa, stepIdx);
    return buildMinFrame(compileData.dfa, compileData.minDFA, stepIdx);
  }, [model, stepIdx, phase, compileData]);

  // 含反向引用：NFA/DFA/最小化三步都不可确定化，给出明确说明而不是空白图
  if (blocked) return <NonDeterminizablePanel compileData={compileData} phase={phase} />;

  if (!compileData) return <div className="panel-empty">输入一条合法正则后，这里开始构造。</div>;
  if (phase === 'min' && !compileData.minDFA) {
    return <div className="panel-empty warn">DFA 已在 {compileData.dfa.limit} 个状态处截断，无法进行最小化。请调高上限或简化正则。</div>;
  }

  const step = model.steps[stepIdx];

  // 完整图的边界（用于一次性自适应，逐帧生长不重排视口）
  const fullBounds = useMemo(() => {
    if (!compileData) return null;
    if (phase === 'nfa') return bounds(nfaPositions(compileData.nfa.states));
    const g = phase === 'dfa' ? compileData.dfa : compileData.minDFA;
    return bounds(layeredPositions(g.states, g.transitions, g.start));
  }, [compileData, phase]);

  return (
    <div className="construct-player">
      <GraphCanvas
        kind={frame.kind}
        states={frame.states}
        edges={frame.edges}
        transitions={frame.transitions}
        symbols={frame.symbols}
        startId={frame.startId}
        activeStates={frame.activeStates}
        activeEdges={frame.activeEdges}
        newStates={frame.newStates}
        newEdges={frame.newEdges}
        mergedGroups={frame.mergedGroups}
        backEdgeId={null}
        deadStateIds={frame.deadIds}
        fitKey={`${phase}-${compileData.nfa.states.length}-${compileData.dfa.states.length}`}
        fitBounds={fullBounds}
        height={440}
      />
      <PlayerControls
        idx={stepIdx}
        total={model.steps.length}
        playing={playing}
        speed={speed}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onStep={(d) => { setPlaying(false); setStepIdx((i) => Math.min(model.steps.length - 1, Math.max(0, i + d))); }}
        onSeek={setStepIdx}
        onSpeed={setSpeed}
        onFinish={() => { setStepIdx(model.steps.length - 1); setPlaying(false); }}
      />
      <StepExplain phase={phase} step={step} compileData={compileData} frame={frame} index={stepIdx} total={model.steps.length} />
      {phase === 'dfa' && compileData.dfa.truncated && (
        <div className="warn-box">
          ⚠ 状态数达到上限 {compileData.dfa.limit}，子集构造已截断展示。实际 DFA 可能还有更多状态；最小化不可用。
        </div>
      )}
      {phase === 'min' && compileData.minDFA && (
        <div className="stat-line">
          最小化前 <b>{compileData.minDFA.beforeCount}</b> 个状态 → 最小化后 <b className="ok">{compileData.minDFA.afterCount}</b> 个状态
        </div>
      )}
    </div>
  );
}

// ---------- 各阶段帧推导 ----------

function buildNFAFrame(model, idx) {
  // 累计到当前步骤为止“已诞生”的状态/边
  const aliveStates = new Set();
  const aliveEdges = new Set();
  let newestStates = [];
  let newestEdges = [];
  for (let i = 0; i <= idx; i += 1) {
    const s = model.steps[i];
    s.newStates.forEach((x) => aliveStates.add(x));
    s.newEdges.forEach((x) => aliveEdges.add(x));
    newestStates = s.newStates;
    newestEdges = s.newEdges;
  }
  return {
    kind: 'nfa',
    states: model.fullStates.filter((s) => aliveStates.has(s.id)),
    edges: model.fullEdges.filter((e) => aliveEdges.has(e.id)),
    startId: model.startId,
    newStates: newestStates,
    newEdges: newestEdges,
    activeStates: [],
    activeEdges: newestEdges,
  };
}

function buildDFAFrame(dfa, idx) {
  // 按 steps 前缀重放到 idx：累积“此刻已发现的 DFA 状态与转移”。
  const alive = new Set();
  const edgeKeys = new Set();
  let newestState = null;
  let newestTransition = null;
  let deadLoopsAdded = false;

  for (let i = 0; i <= idx; i += 1) {
    const s = dfa.steps[i];
    if (!s) break;
    if (s.type === 'newState') {
      alive.add(s.dfaId);
      newestState = s.dfaId;
      newestTransition = null;
    } else if (s.type === 'transition') {
      alive.add(s.from);
      alive.add(s.to);
      edgeKeys.add(`${s.from}:${s.symbol}:${s.to}`);
      newestState = s.isNew ? s.to : null;
      newestTransition = { from: s.from, to: s.to };
    } else if (s.type === 'deadLoops') {
      dfa.states.forEach((st) => alive.add(st.id));
      deadLoopsAdded = true;
    }
  }
  // 还没有任何转移步骤时（初始 q0/q0NoStart 连续注册），始终高亮起点 D0
  const sawTransition = dfa.steps.slice(0, idx + 1).some((s) => s?.type === 'transition');
  if (!sawTransition) newestState = dfa.start;

  // deadLoops 步骤之后才展示补齐的死状态转移；在此之前只显示真实子集转移
  const transitions = dfa.transitions.filter((t) => {
    if (!alive.has(t.from) || !alive.has(t.to)) return false;
    if (edgeKeys.has(`${t.from}:${t.symbol}:${t.to}`)) return true;
    return deadLoopsAdded; // 补齐的死状态/其他符号转移
  });
  const states = dfa.states.filter((s) => alive.has(s.id));
  const currentIsTransition = dfa.steps[idx]?.type === 'transition';
  return {
    kind: 'dfa',
    states,
    transitions,
    symbols: dfa.symbols,
    startId: dfa.start,
    newStates: newestState === null ? [] : [newestState],
    activeStates: currentIsTransition && newestTransition ? [newestTransition.to] : [],
    activeEdges: currentIsTransition && newestTransition ? [`d-${newestTransition.from}-${newestTransition.to}`] : [],
    deadIds: states.filter((s) => s.dead).map((s) => s.id),
  };
}

function buildMinFrame(dfa, minDFA, idx) {
  // 最小化阶段：底图始终是“子集构造 DFA”，用 partition/mapping 着色
  const steps = minDFA.steps;
  let partition = null;
  let mergedGroups = [];
  let activeStates = [];
  let activeEdges = [];
  for (let i = 0; i <= idx; i += 1) {
    const s = steps[i];
    if (s.type === 'init' || s.type === 'split') partition = s.partition;
    if (s.type === 'merge') {
      partition = s.mapping;
      mergedGroups = s.groups;
    }
    if (s.type === 'split' && s.splits?.length) {
      activeStates = s.splits.flat(2);
    }
  }
  const classOf = new Map((partition || []).map((x) => [x.state, x.cls]));
  // 给原 DFA 状态染“等价类颜色”（边框色由 mergedGroups/newStates 控制有限，
  // 这里借用 activeStates 高亮当前轮涉及的分裂组）
  const states = dfa.states.map((st) => ({
    ...st,
    accepting: st.accepting,
  }));
  return {
    kind: 'dfa',
    states,
    transitions: dfa.transitions,
    symbols: dfa.symbols,
    startId: dfa.start,
    activeStates,
    activeEdges,
    newStates: [],
    mergedGroups: mergedGroups.flat(),
    mergedGroupsNested: mergedGroups,
    deadIds: states.filter((s) => s.dead).map((s) => s.id),
    classOf,
  };
}

function StepExplain({ phase, step, compileData, frame, index, total }) {
  if (!step) return null;
  let title = '';
  let body = '';
  if (phase === 'nfa') {
    title = `规则 ${index + 1}/${total}：${step.title}`;
    body = step.description || '';
  } else if (phase === 'dfa') {
    if (step.type === 'newState') {
      title = `新 DFA 状态 D${step.dfaId}：合并了 ${step.nfaStates.length} 个 NFA 状态`;
      body = step.reason;
    } else if (step.type === 'transition') {
      const sym = compileData.dfa.symbols[step.symbolIndex];
      const label = sym ? rangeLabel(sym) : '其他';
      title = `转移：D${step.from} —${label}→ D${step.to}${step.isNew ? '（新状态，高亮）' : ''}`;
      body = `先沿字符边从 ${step.fromNfaStates.length} 个活跃 NFA 状态收集种子（${step.nfaSeedStates.length} 个），再求 ε-闭包得到 ${step.nfaClosure.length} 个状态的集合，整体合并成 D${step.to}。`;
    } else if (step.type === 'deadLoops') {
      title = '补全死状态转移';
      body = step.reason;
    }
  } else {
    title = step.type === 'merge' ? '等价状态合并' : `第 ${step.round || 0} 轮划分`;
    body = step.description || '';
    if (step.type === 'split' && step.splits?.length) {
      body += ` 本轮分裂 ${step.splits.length} 组：${step.splits.map((g) => `{${g.map((x) => `D${x}`).join(',')}}`).join(' ')}`;
    }
    if (step.type === 'merge') {
      body += ` 合并组：${step.groups.map((g) => `{${g.map((x) => `D${x}`).join('=')}}`).join('  ')}`;
    }
  }
  return (
    <div className="step-explain">
      <div className="step-title">{title}</div>
      <div className="step-body">{body}</div>
    </div>
  );
}

function rangeLabel(sym) {
  const cp = (c) => (c < 0x20 ? `\\x${c.toString(16)}` : String.fromCodePoint(c));
  return sym.hi - sym.lo === 1 ? cp(sym.lo) : `${cp(sym.lo)}-${cp(sym.hi - 1)}`;
}

// 含反向引用时替代三张自动机图的说明面板
const PHASE_NAME = { nfa: 'NFA（Thompson 构造）', dfa: 'DFA（子集构造）', min: '最小化 DFA' };

function NonDeterminizablePanel({ compileData, phase }) {
  const refs = compileData.backrefs || [];
  return (
    <div className="nondet-panel">
      <div className="nondet-head">
        <span className="nondet-icon">⛔</span>
        <div>
          <div className="nondet-title">本阶段不可确定化：{PHASE_NAME[phase]} 未构造</div>
          <div className="nondet-sub">
            这条正则已超出有限自动机的能力范围，只能由<span className="nondet-hl">带回溯与捕获栈的引擎</span>执行。
          </div>
        </div>
      </div>
      <div className="nondet-refs">
        <div className="nondet-refs-title">导致不可确定化的反向引用：</div>
        {refs.map((r, i) => (
          <div key={i} className="nondet-ref-item">
            <code className="nondet-ref-code">{r.ref}</code>
            <span className="muted small">位置 [{r.pos},{r.end})</span>
            <div className="nondet-ref-reason">{r.reason}</div>
          </div>
        ))}
      </div>
      <div className="nondet-foot small muted">
        三步状态：① NFA 未构造 → ② DFA 未构造 → ③ 最小化未进行。切换到下方“匹配演示 → 回溯引擎”可看到
        反向引用如何从捕获栈取值并逐字符比对；NFA / DFA / 最小 DFA 引擎在该模式下不可选用。
      </div>
    </div>
  );
}
