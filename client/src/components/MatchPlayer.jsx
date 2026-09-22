// MatchPlayer.jsx
// 匹配演示：逐帧播放后端匹配引擎给出的 frames。
//  - 输入框中当前被消费的字符同步高亮，并展示匹配区间；
//  - NFA 模式高亮整组活跃状态；DFA/minDFA 高亮唯一当前状态；
//  - 回溯引擎把回退边画成红色虚线，路径上的调用链也一同描红。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import GraphCanvas from '../canvas/GraphCanvas.jsx';
import PlayerControls from './PlayerControls.jsx';

export default function MatchPlayer({
  graph, // nfa / dfa / minDFA 图（compileData 中对应对象）
  kind, // 'nfa' | 'dfa'
  frames,
  metrics,
  input,
  result,
  engineLabel,
  height = 400,
}) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timer = useRef(null);

  useEffect(() => { setIdx(0); setPlaying(false); }, [frames]);

  useEffect(() => {
    if (!playing || !frames?.length) return;
    timer.current = setInterval(() => {
      setIdx((i) => {
        if (i >= frames.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, Math.max(90, 750 / speed));
    return () => clearInterval(timer.current);
  }, [playing, speed, frames]);

  const frame = frames?.[idx];
  const view = useMemo(() => {
    if (!frame || !graph) return null;
    return renderFrame(graph, kind, frame);
  }, [frame, graph, kind]);

  if (!graph || !frames) {
    return <div className="panel-empty">选择引擎并输入测试串后开始匹配演示。</div>;
  }

  const charPos = highlightPos(frame, input);
  const isBack = frame?.kind === 'backtrack';
  const verdict = verdictOf(frames, idx);

  return (
    <div className="match-player">
      <InputStrip input={input} pos={charPos} frame={frame} result={result} verdict={verdict} />
      <div className="engine-tag">{engineLabel}</div>
      <GraphCanvas
        kind={kind === 'backtracking' ? 'nfa' : kind}
        states={kind === 'backtracking' || kind === 'nfa' ? graph.states : graph.states}
        edges={graph.edges}
        transitions={graph.transitions}
        symbols={graph.symbols}
        startId={graph.start}
        activeStates={view?.activeStates || []}
        activeEdges={view?.activeEdges || []}
        backEdgeId={isBack ? frame.edgeId : null}
        backPath={isBack ? edgePathToBack(graph, frame) : []}
        deadStateIds={view?.deadIds || []}
        height={height}
      />
      <PlayerControls
        idx={idx}
        total={frames.length}
        playing={playing}
        speed={speed}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onStep={(d) => { setPlaying(false); setIdx((i) => Math.min(frames.length - 1, Math.max(0, i + d))); }}
        onSeek={setIdx}
        onSpeed={setSpeed}
        onFinish={() => { setIdx(frames.length - 1); setPlaying(false); }}
      />
      <div className={`match-msg ${frameClass(frame)}`}>
        <span className="msg-kind">{frameKindLabel(frame)}</span>
        <span>{frame?.message}</span>
      </div>
    </div>
  );
}

// ---- 帧 -> 画布高亮 ----

function renderFrame(graph, kind, frame) {
  const isBacktracking = kind === 'backtracking';
  if (isBacktracking) {
    // 回溯帧给出 activeStates（整条调用链上的状态）或单状态
    const activeStates = frame.activeStates || (frame.state !== undefined ? [frame.state] : []);
    const activeEdges = frame.edgeId !== undefined && frame.edgeId !== null ? [frame.edgeId] : [];
    return { activeStates, activeEdges, deadIds: [] };
  }
  if (kind === 'nfa') {
    return {
      activeStates: frame.activeStates || [],
      activeEdges: frame.edgeIds || [],
      deadIds: frame.kind === 'die' ? [] : [],
    };
  }
  // DFA / minDFA
  return {
    activeStates: frame.state === undefined || frame.state === null ? [] : [frame.state],
    activeEdges: [],
    deadIds: frame.kind === 'die' && frame.state !== null && frame.state !== undefined ? [frame.state] : [],
  };
}

function edgePathToBack(graph, frame) {
  // 回溯帧只带“刚刚回退的那条边”，画红即可；历史路径信息在 path 中
  return frame.path || (frame.edgeId !== null && frame.edgeId !== undefined ? [frame.edgeId] : []);
}

function highlightPos(frame, input) {
  if (!frame) return null;
  if (frame.kind === 'consume' || frame.kind === 'char-match' || frame.kind === 'char-fail' || frame.kind === 'die') {
    return frame.pos;
  }
  return null;
}

function verdictOf(frames, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    if (frames[i].kind === 'accept') return { label: '接受', ok: true, frame: frames[i] };
  }
  const last = frames[idx];
  if (last?.kind === 'abort') return { label: '终止', ok: false, frame: last };
  return null;
}

function frameClass(frame) {
  if (!frame) return '';
  if (frame.kind === 'backtrack' || frame.kind === 'char-fail' || frame.kind === 'anchor-fail' || frame.kind === 'char-eof' || frame.kind === 'die') return 'bad';
  if (frame.kind === 'accept' || frame.kind === 'accept-here' || frame.kind === 'char-match' || frame.kind === 'anchor-pass') return 'good';
  return '';
}

function frameKindLabel(frame) {
  const map = {
    attempt: '起点尝试',
    consume: '消费字符',
    epsilon: 'ε 转移',
    'skip-epsilon': '跳过零宽环',
    'char-match': '字符匹配',
    'char-fail': '字符不匹配',
    'char-eof': '输入结束',
    'anchor-pass': '锚点成立',
    'anchor-fail': '锚点不成立',
    backtrack: '回溯',
    'return-from-accept': '从接受点回退',
    'accept-here': '经过接受态',
    accept: '匹配成功',
    die: '进入死状态',
    abort: '步数超限终止',
    'attempt-fail': '起点失败',
  };
  return map[frame?.kind] || frame?.kind || '';
}

// ---- 输入串条 ----

function InputStrip({ input, pos, frame, result, verdict }) {
  const chars = Array.from(input);
  // 计算每个字符的显示偏移（代理对也按字符显示）
  const matchStart = frame?.start ?? result?.start ?? null;
  const matchEnd = frame?.end ?? result?.end ?? null;
  return (
    <div className="input-strip">
      <div className="input-chars">
        {chars.map((c, i) => {
          const cls = [
            'ch',
            i === pos ? 'cur' : '',
            matchStart !== null && i >= matchStart && i < (matchEnd ?? matchStart) ? 'matched' : '',
          ].join(' ');
          return (
            <span key={i} className={cls}>
              {c === ' ' ? '␠' : c === '\n' ? '↵' : c === '\t' ? '⇥' : c}
            </span>
          );
        })}
        {chars.length === 0 && <span className="muted">（空串）</span>}
      </div>
      <div className="input-meta">
        长度 {chars.length}
        {verdict && <span className={verdict.ok ? 'verdict ok' : 'verdict bad'}>{verdict.label}</span>}
        {result && <span className="match-range">匹配区间 [{result.start},{result.end})</span>}
      </div>
    </div>
  );
}
