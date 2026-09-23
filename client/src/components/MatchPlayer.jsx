// MatchPlayer.jsx
// 匹配演示：逐帧播放后端匹配引擎给出的 frames。
//  - 输入框中当前被消费的字符同步高亮，并展示匹配区间；
//  - NFA 模式高亮整组活跃状态；DFA/minDFA 高亮唯一当前状态；
//  - 回溯引擎把回退边画成红色虚线，路径上的调用链也一同描红；
//  - 含反向引用的模式没有自动机图（不可确定化）：改为“捕获栈 + 步骤说明”
//    的专用回放视图，反向引用取值/比对帧用紫色单独呈现。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import GraphCanvas from '../canvas/GraphCanvas.jsx';
import PlayerControls from './PlayerControls.jsx';

export default function MatchPlayer({
  graph, // nfa / dfa / minDFA 图（compileData 中对应对象）；反向引用模式为 null
  kind, // 'nfa' | 'dfa' | 'minDFA' | 'backtracking' | 'backtracking-ref'
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

  const backrefMode = kind === 'backtracking-ref';

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
    if (!frame || !graph || backrefMode) return null;
    return renderFrame(graph, kind, frame);
  }, [frame, graph, kind, backrefMode]);

  if (!frames) {
    return <div className="panel-empty">选择引擎并输入测试串后开始匹配演示。</div>;
  }
  if (!graph && !backrefMode) {
    return <div className="panel-empty">选择引擎并输入测试串后开始匹配演示。</div>;
  }

  const charPos = highlightPos(frame, input);
  const isBack = frame?.kind === 'backtrack';
  const verdict = verdictOf(frames, idx);

  return (
    <div className="match-player">
      <InputStrip input={input} pos={charPos} frame={frame} result={result} verdict={verdict} />
      <div className="engine-tag">{engineLabel}</div>
      {backrefMode ? (
        <BackrefTrace frames={frames} idx={idx} frame={frame} height={height} />
      ) : (
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
      )}
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
        <span className={`msg-kind ${msgKindClass(frame)}`}>{frameKindLabel(frame)}</span>
        <span>{frame?.message}</span>
      </div>
    </div>
  );
}

// ---- 反向引用专用回放：捕获栈 + 当前比对信息（无状态机图） ----

function BackrefTrace({ frames, idx, frame, height = 400 }) {
  const captures = frame?.captures || [];
  const isRef = frame && frame.kind.startsWith('backref');
  return (
    <div className={`backref-trace ${isRef ? 'ref-active' : ''}`} style={{ minHeight: height }}>
      <div className="trace-head">
        回溯执行轨迹（AST 直接匹配 · 无自动机图）
        {isRef && <span className="pill ref">当前步骤：反向引用</span>}
      </div>
      <div className="trace-body">
        <div className="capture-stack">
          <div className="capture-title">捕获栈（各分组最近一次闭合的文本）</div>
          {captures.length === 0 && <div className="muted small capture-empty">（当前路径上还没有任何分组闭合）</div>}
          {captures.map((c) => (
            <div
              key={c.group}
              className={`capture-item ${frame?.group === c.group && isRef ? 'in-use' : ''} ${c.empty ? 'empty-cap' : ''}`}
            >
              <span className="cap-gname">
                {c.name ? `#${c.group} ${c.name}` : `#${c.group}`}
              </span>
              <span className="cap-text">{c.empty ? '（空串参与）' : `"${c.text}"`}</span>
              {!c.empty && <span className="cap-range">[{c.start},{c.end})</span>}
            </div>
          ))}
          {frame?.kind === 'backref-unset' && (
            <div className="capture-note bad">
              引用目标在当前路径未参与匹配（可能在没走过的另一分支）——按约定本次比对失败
            </div>
          )}
          {frame?.kind === 'backref-empty' && (
            <div className="capture-note ok-note">
              引用目标已参与但抓到空串（如可选量词跳过）：反向引用匹配零个字符，零宽通过
            </div>
          )}
        </div>
        <div className="ref-compare">
          {frame?.kind?.startsWith('backref') ? (
            <BackrefCompare frame={frame} />
          ) : (
            <div className="ref-idle muted small">
              普通匹配步骤（字符/字符类/锚点/量词选择/分组开闭）。
              走到反向引用时，这里会显示“从捕获栈取值并逐字符比对”的过程。
            </div>
          )}
        </div>
      </div>
      <div className="trace-foot muted small">帧 {idx + 1} / {frames.length}</div>
    </div>
  );
}

function BackrefCompare({ frame }) {
  if (frame.kind === 'backref-unset') {
    return <div className="ref-card unset">反向引用 {frame.ref}：捕获栈中没有可用文本</div>;
  }
  if (frame.kind === 'backref-load') {
    return (
      <div className="ref-card load">
        <div className="ref-line"><span className="ref-sym">{frame.ref}</span> 从捕获栈取值</div>
        <div className="ref-value">"{frame.value}"</div>
        <div className="muted small">来源：分组 {frame.label}，位置 [{frame.capturedRange[0]},{frame.capturedRange[1]})；接下来逐字符比对</div>
      </div>
    );
  }
  if (frame.kind === 'backref-empty') {
    return (
      <div className="ref-card empty">
        <div className="ref-line">{frame.ref} 引用的分组已参与但捕获为空串</div>
        <div className="muted small">反向引用要求“再来一段相同文本”，空串的副本就是空串——零宽通过，不消费字符。</div>
      </div>
    );
  }
  if (frame.kind === 'backref-char') {
    return (
      <div className="ref-card pass">
        <div className="ref-line">逐字符比对 {frame.offset + 1}/{frame.total}</div>
        <div className="ref-chars">
          {Array.from(frame.value).map((c, i) => (
            <span key={i} className={`rc ${i === frame.offset ? 'cur good' : i < frame.offset ? 'done' : ''}`}>{c}</span>
          ))}
        </div>
      </div>
    );
  }
  if (frame.kind === 'backref-fail') {
    return (
      <div className="ref-card fail">
        <div className="ref-line">比对失败：{frame.char === null ? '输入已结束' : `"${frame.char}" ≠ 期望值`}</div>
        <div className="ref-chars">
          {Array.from(frame.value).map((c, i) => (
            <span key={i} className={`rc ${i === frame.mismatchAt ? 'cur bad' : i < frame.mismatchAt ? 'done' : ''}`}>{c}</span>
          ))}
        </div>
      </div>
    );
  }
  if (frame.kind === 'backref-pass') {
    return (
      <div className="ref-card pass">
        <div className="ref-line">{frame.ref} 全部字符一致 ✓</div>
        <div className="ref-value">"{frame.value}"</div>
      </div>
    );
  }
  return null;
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
  if (['consume', 'char-match', 'char-fail', 'die', 'backref-char', 'backref-fail', 'char-eof'].includes(frame.kind)) {
    return Math.min(frame.pos, Array.from(input).length);
  }
  return null;
}

function verdictOf(frames, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    if (frames[i].kind === 'accept') return { label: '接受', ok: true, frame: frames[i] };
  }
  const last = frames[idx];
  if (last?.kind === 'abort' || last?.kind === 'abort-final') return { label: '终止', ok: false, frame: last };
  return null;
}

function frameClass(frame) {
  if (!frame) return '';
  if ([
    'backtrack', 'char-fail', 'anchor-fail', 'char-eof', 'die',
    'backref-fail', 'backref-unset',
  ].includes(frame.kind)) return 'bad';
  if ([
    'accept', 'accept-here', 'char-match', 'anchor-pass',
    'backref-pass', 'backref-char', 'backref-empty',
  ].includes(frame.kind)) return 'good';
  if (['backref-load'].includes(frame.kind)) return 'ref';
  return '';
}

function msgKindClass(frame) {
  if (!frame) return '';
  if (frame.kind.startsWith('backref')) return 'msg-ref';
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
    'abort-final': '步数超限终止',
    'attempt-fail': '起点失败',
    // AST 回溯引擎新增帧型
    'alt-branch': '尝试分支',
    'alt-exhausted': '分支穷尽',
    'repeat-mandatory': '必选副本',
    'repeat-choice': '量词选择',
    'repeat-continue': '继续重复',
    'repeat-zero-skip': '零宽防环',
    'group-open': '捕获组开始',
    'group-close': '捕获组闭合',
    'backref-load': '反向引用·取值',
    'backref-unset': '反向引用·未参与',
    'backref-empty': '反向引用·空串',
    'backref-char': '反向引用·比对',
    'backref-fail': '反向引用·失配',
    'backref-pass': '反向引用·通过',
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
