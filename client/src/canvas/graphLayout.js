// graphLayout.js
// 前端画布坐标计算：后端给出的是逻辑层位（NFA 的 x 层/y 序；DFA 的网格），
// 这里统一映射为画布像素，并提供命中测试。

export const NODE_R = 20;
export const X_GAP = 92;
export const Y_GAP = 64;
export const MARGIN = 60;

export function nfaPositions(states) {
  // states: {id,x,y,kind}。后端给的是逻辑层（x 列）与层内序（y），
  // 这里直接按统一网格映射为像素，保证同列节点绝不重叠。
  return states.map((s) => ({
    id: s.id,
    x: MARGIN + (s.x || 0) * X_GAP,
    y: MARGIN + (s.y ?? 0) * Y_GAP,
  }));
}

export function dfaPositions(states) {
  // 网格摆放：按 id 蛇形排列太挤，这里按 BFS 层（用转移边）排
  return gridPositions(states);
}

function gridPositions(states) {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(states.length * 1.6)));
  return states.map((s, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    return { id: s.id, x: MARGIN + col * 150, y: MARGIN + row * 120 };
  });
}

/** BFS 层次布局：适合 DFA / 最小 DFA，start 在最左 */
export function layeredPositions(states, transitions, startId) {
  const n = states.length;
  if (n === 0) return [];
  const adj = new Map();
  transitions.forEach((t) => {
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from).push(t.to);
  });
  const depth = new Map();
  const q = [[startId ?? 0, 0]];
  depth.set(startId ?? 0, 0);
  while (q.length) {
    const [u, d] = q.shift();
    for (const v of adj.get(u) || []) {
      if (!depth.has(v)) {
        depth.set(v, d + 1);
        q.push([v, d + 1]);
      }
    }
  }
  // 不可达（理论上不存在）放最后一列
  const maxDepth = Math.max(0, ...[...depth.values()]);
  const byDepth = Array.from({ length: maxDepth + 1 }, () => []);
  states.forEach((s) => {
    const d = depth.has(s.id) ? depth.get(s.id) : maxDepth + 1;
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(s.id);
  });
  const pos = new Map();
  byDepth.forEach((layer, d) => {
    layer.forEach((id, idx) => {
      pos.set(id, { id, x: MARGIN + d * 150, y: MARGIN + idx * 110 });
    });
  });
  return states.map((s) => pos.get(s.id));
}

export function bounds(positions) {
  if (positions.length === 0) return { w: 400, h: 300 };
  const maxX = Math.max(...positions.map((p) => p.x));
  const maxY = Math.max(...positions.map((p) => p.y));
  return { w: maxX + MARGIN + NODE_R, h: maxY + MARGIN + NODE_R };
}
