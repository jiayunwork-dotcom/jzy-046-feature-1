// GraphCanvas.jsx
// 通用状态机画布：NFA / DFA / 最小 DFA 共用。
//  - 状态画圆圈，接受态双圈，起始态带“入口箭头”；
//  - ε 边画灰色虚线，字符/锚点/字符类边画实线并带标注；
//  - 回溯边（activeBackEdgeId）画红色粗虚线；
//  - 支持滚轮缩放、拖拽平移、节点悬停命中。

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { NODE_R, nfaPositions, layeredPositions, bounds } from './graphLayout.js';

const COLORS = {
  bg: '#0f1420',
  grid: '#1b2233',
  node: '#1d2740',
  nodeStroke: '#7c93c3',
  nodeActive: '#2f6df6',
  nodeActiveStroke: '#9cc2ff',
  nodeNew: '#f5a524',
  nodeMerged: '#9b6dff',
  accept: '#17c964',
  edge: '#5b6b92',
  epsilon: '#6b7a9e',
  edgeActive: '#ffd34d',
  edgeBack: '#ff4d5e',
  label: '#cdd6f4',
  dim: '#3a445c',
};

export default function GraphCanvas({
  kind = 'nfa', // nfa | dfa | minDFA
  states,
  edges, // NFA: {from,to,type,labelText,dir,set,choice}
  transitions, // DFA: {from,to,symbol}
  symbols = [],
  startId,
  activeStates = [],
  activeEdges = [],
  newStates = [],
  newEdges = [],
  mergedGroups = [],
  backEdgeId = null,
  backPath = [], // 一串 edgeId
  deadStateIds = [],
  fitKey = '', // 变化时按完整内容重新自适应缩放（构造阶段传阶段标识）
  fitBounds = null, // 完整内容的 {w,h}，避免逐帧生长时反复重定位
  onStateHover,
  height = 420,
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [size, setSize] = useState({ w: 800, h: height });

  // 位置
  const positions = useMemo(() => {
    if (!states) return [];
    if (kind === 'nfa') return nfaPositions(states);
    return layeredPositions(states, transitions || [], startId);
  }, [states, kind, transitions, startId]);
  const posMap = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions]);
  const world = useMemo(() => bounds(positions), [positions]);

  // DFA 转移按 (from,to) 合并标签
  const dfaEdgeList = useMemo(() => {
    if (kind === 'nfa' || !transitions) return [];
    const map = new Map();
    transitions.forEach((t) => {
      const key = `${t.from}->${t.to}`;
      if (!map.has(key)) map.set(key, { from: t.from, to: t.to, syms: [] });
      if (t.symbol >= 0) map.get(key).syms.push(t.symbol);
      else map.get(key).other = true;
    });
    return [...map.values()].map((e) => ({
      ...e,
      label:
        e.syms
          .slice(0, 4)
          .map((i) => symbolShort(symbols[i]))
          .join(',') +
        (e.syms.length > 4 ? `+${e.syms.length - 4}` : '') +
        (e.other ? (e.syms.length ? ',其他' : '其他') : ''),
    }));
  }, [transitions, symbols, kind]);

  // 自适应
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: height });
    return () => ro.disconnect();
  }, [height]);

  // 自适应：仅在阶段/图种类切换（fitKey 变化）或容器宽度变化时执行一次，
  // 用“完整图”的边界 fitBounds，避免构造动画逐帧生长时画面反复跳动。
  useEffect(() => {
    const target = fitBounds || world;
    const fit = Math.min(size.w / (target.w + 40), 1.1);
    setScale(Math.max(0.3, Math.min(1.15, fit)));
    setOffset({ x: 10, y: 10 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w, kind]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.w, size.h);

    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);

    // 网格
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1 / scale;
    const grid = 40;
    for (let x = 0; x < world.w; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.h); ctx.stroke();
    }
    for (let y = 0; y < world.h; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(world.w, y); ctx.stroke();
    }

    const activeSet = new Set(activeStates);
    const newSet = new Set(newStates);
    const mergedSet = new Set();
    (mergedGroups || []).flat().forEach((s) => mergedSet.add(s));
    const backSet = new Set(backPath);

    // ---- 边 ----
    const drawEdge = (from, to, { label, type, dir, id, symsLen } = {}) => {
      const a = posMap.get(from);
      const b = posMap.get(to);
      if (!a || !b) return;
      const isBack = backSet.has(id) || backEdgeId === id;
      const isActive = activeEdges.includes(id);
      const isEps = type === 'epsilon';
      const isAnchor = type === 'anchor';
      const selfLoop = from === to;

      let pathColor = isBack ? COLORS.edgeBack : isActive ? COLORS.edgeActive : isEps ? COLORS.epsilon : COLORS.edge;
      ctx.strokeStyle = pathColor;
      ctx.lineWidth = isBack ? 2.6 / scale + 1 : isActive ? 2.4 / scale + 0.8 : 1.4 / scale + 0.4;
      ctx.setLineDash(isBack ? [7 / scale, 5 / scale] : isEps ? [4 / scale, 4 / scale] : []);

      if (selfLoop) {
        ctx.beginPath();
        ctx.arc(b.x, b.y - NODE_R - 6, 12, Math.PI * 0.1, Math.PI * 1.9, true);
        ctx.stroke();
        drawArrowHead(ctx, b.x + 10, b.y - NODE_R - 2, Math.PI / 2, pathColor, scale);
        if (label) drawLabel(ctx, b.x + 14, b.y - NODE_R - 16, label, pathColor, scale);
        ctx.setLineDash([]);
        return;
      }

      // 同方向平行边做轻微弯曲，避免完全重叠
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const sx = a.x + ux * NODE_R;
      const sy = a.y + uy * NODE_R;
      const tx = b.x - ux * (NODE_R + 2);
      const ty = b.y - uy * (NODE_R + 2);
      const back = dx < -10;
      const bend = back ? 34 : 0;
      const mx = (sx + tx) / 2 - uy * bend;
      const my = (sy + ty) / 2 + ux * bend;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(mx, my, tx, ty);
      ctx.stroke();
      // 箭头
      const ang = Math.atan2(ty - my, tx - mx);
      drawArrowHead(ctx, tx, ty, ang, pathColor, scale);

      if (label) {
        drawLabel(ctx, mx, my - 6, label, pathColor, scale);
      }
      void dir; void symsLen;
      ctx.setLineDash([]);
    };

    if (kind === 'nfa' && edges) {
      edges.forEach((e) => drawEdge(e.from, e.to, {
        id: e.id,
        type: e.type,
        dir: e.dir,
        label: e.labelText || (e.type === 'epsilon' ? 'ε' : e.type === 'anchor' ? (e.dir === 'start' ? '^' : '$') : ''),
      }));
    } else {
      dfaEdgeList.forEach((e) => drawEdge(e.from, e.to, {
        id: `d-${e.from}-${e.to}`,
        label: e.label,
        type: 'char',
      }));
    }

    // ---- 状态 ----
    states?.forEach((s) => {
      const p = posMap.get(s.id);
      if (!p) return;
      const active = activeSet.has(s.id);
      const fresh = newSet.has(s.id);
      const merged = mergedSet.has(s.id);
      const isAccept = kind === 'nfa' ? s.kind === 'accept' : s.accepting;
      const isStart = kind === 'nfa' ? s.kind === 'start' : s.id === startId;
      const isDead = kind === 'nfa' ? false : (s.dead || deadStateIds.includes(s.id));

      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = active ? COLORS.nodeActive : isDead ? '#181d2b' : COLORS.node;
      ctx.fill();
      ctx.lineWidth = active ? 3 / scale + 1 : 1.6 / scale + 0.4;
      ctx.strokeStyle = active ? COLORS.nodeActiveStroke : fresh ? COLORS.nodeNew : merged ? COLORS.nodeMerged : COLORS.nodeStroke;
      ctx.stroke();

      if (isAccept) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, NODE_R - 6, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.accept;
        ctx.lineWidth = 1.8 / scale + 0.4;
        ctx.stroke();
      }
      if (isStart) {
        // 入口箭头
        ctx.strokeStyle = COLORS.nodeActiveStroke;
        ctx.lineWidth = 1.6 / scale + 0.4;
        ctx.beginPath();
        ctx.moveTo(p.x - NODE_R - 22, p.y);
        ctx.lineTo(p.x - NODE_R - 4, p.y);
        ctx.stroke();
        drawArrowHead(ctx, p.x - NODE_R - 1, p.y, 0, COLORS.nodeActiveStroke, scale);
      }

      ctx.fillStyle = isDead ? COLORS.dim : COLORS.label;
      ctx.font = `${12 / scale + 4}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(kind === 'nfa' ? `S${s.id}` : `D${s.id}`, p.x, p.y);
    });

    ctx.restore();
  }, [size, scale, offset, positions, posMap, world, states, edges, dfaEdgeList, activeStates, activeEdges, newStates, mergedGroups, backEdgeId, backPath, deadStateIds, kind, startId]);

  useEffect(() => { draw(); }, [draw]);

  // 交互
  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0012;
    setScale((s) => Math.max(0.2, Math.min(2.5, s * (1 + delta))));
  };
  const onDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const wx = (e.clientX - rect.left - offset.x) / scale;
    const wy = (e.clientY - rect.top - offset.y) / scale;
    let hit = null;
    for (const p of positions) {
      if (Math.hypot(wx - p.x, wy - p.y) <= NODE_R) { hit = p.id; break; }
    }
    setHoverNode(hit);
    onStateHover?.(hit);
    if (dragRef.current) {
      setOffset({ x: dragRef.current.ox + (e.clientX - dragRef.current.x), y: dragRef.current.oy + (e.clientY - dragRef.current.y) });
    }
  };
  const onUp = () => { dragRef.current = null; };

  return (
    <div ref={wrapRef} className="canvas-wrap" style={{ position: 'relative', height, borderRadius: 10, overflow: 'hidden', border: '1px solid #232c44' }}>
      <canvas
        ref={canvasRef}
        onWheel={onWheel}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => { onUp(); setHoverNode(null); onStateHover?.(null); }}
        style={{ display: 'block', cursor: hoverNode !== null ? 'pointer' : 'grab' }}
      />
      <div className="canvas-hint">滚轮缩放 · 拖拽平移 {hoverNode !== null ? `· 悬停 S${hoverNode}` : ''}</div>
    </div>
  );
}

function drawArrowHead(ctx, x, y, angle, color, scale) {
  const size = 8 / scale + 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.55);
  ctx.lineTo(-size, size * 0.55);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawLabel(ctx, x, y, text, color, scale) {
  ctx.font = `${11 / scale + 3}px ui-monospace, monospace`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(15,20,32,0.82)';
  ctx.fillRect(x - w / 2 - 4 / scale, y - 9 / scale, w + 8 / scale, (18) / scale + 4);
  ctx.fillStyle = color === COLORS.epsilon ? '#9fb0d8' : color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

function symbolShort(sym) {
  if (!sym) return '?';
  const cp = (c) => {
    if (c === 0x0a) return '\\n';
    if (c === 0x0d) return '\\r';
    if (c === 0x09) return '\\t';
    if (c < 0x20) return `\\x${c.toString(16)}`;
    return String.fromCodePoint(c);
  };
  if (sym.hi - sym.lo === 1) return cp(sym.lo);
  return `${cp(sym.lo)}-${cp(sym.hi - 1)}`;
}
