// nfa-ops.js
// NFA 上的基础运算：ε-闭包、按字符转移、接受判定。
// 锚点 ^ / $ 是零宽边，闭包时按“当前输入位置”决定是否可穿越：
//   atStart=true  才能走 ^ 边
//   atEnd=true    才能走 $ 边
//
// epsilonClosureFast 同时返回每个状态到达时所依赖的锚点条件：
//   reach.get(s) = { start: Bool, end: Bool }（两个条件的“与”）
// 这样 DFA 状态可以知道：接受态是“无条件可达”，还是“仅在串首/串尾可达”。

export function epsilonClosure(nfa, seeds, { atStart = false, atEnd = false } = {}) {
  const { set } = epsilonClosureWithReach(nfa, seeds, null, { atStart, atEnd });
  return set;
}

export function indexEdges(nfa) {
  const out = new Map();
  return indexInto(nfa, out);
}

function indexInto(nfa, out) {
  for (const e of nfa.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
  }
  return out;
}

/**
 * 核心闭包：在 atStart/atEnd 给定的穿越权限下做 DFS。
 * reach（可选）记录到达状态的锚点依赖。
 */
export function epsilonClosureWithReach(nfa, seedArr, edgeIndex, { atStart, atEnd }) {
  const index = edgeIndex || indexEdges(nfa);
  const set = new Set();
  const reach = new Map(); // state -> {start, end}
  const stack = seedArr.map((s) => ({ s, reqStart: false, reqEnd: false }));
  seedArr.forEach((s) => {
    set.add(s);
    reach.set(s, { start: false, end: false });
  });

  const relax = (to, reqStart, reqEnd) => {
    const prev = reach.get(to);
    // 依赖只增不减；若新路径要求更少，则以更少者为准（存在一条不依赖锚点
    // 的路径时，状态就可以无条件到达）
    if (!prev) {
      set.add(to);
      reach.set(to, { start: reqStart, end: reqEnd });
      stack.push({ s: to, reqStart, reqEnd });
      return;
    }
    if ((!reqStart && prev.start) || (!reqEnd && prev.end)) {
      prev.start = prev.start && reqStart;
      prev.end = prev.end && reqEnd;
      stack.push({ s: to, reqStart: prev.start, reqEnd: prev.end });
    }
  };

  while (stack.length) {
    const { s: u, reqStart, reqEnd } = stack.pop();
    const list = index.get(u);
    if (!list) continue;
    for (const e of list) {
      if (e.type === 'epsilon') {
        relax(e.to, reqStart, reqEnd);
      } else if (e.type === 'anchor') {
        if (e.dir === 'start' && !atStart) continue;
        if (e.dir === 'end' && !atEnd) continue;
        relax(e.to, reqStart || e.dir === 'start', reqEnd || e.dir === 'end');
      }
    }
  }
  return { set, reach };
}

/** 向后兼容的快速闭包：只返回状态集合 */
export function epsilonClosureFast(nfa, seedArr, edgeIndex, opts = {}) {
  const { set } = epsilonClosureWithReach(nfa, seedArr, edgeIndex, {
    atStart: opts.atStart ?? false,
    atEnd: opts.atEnd ?? false,
  });
  return set;
}

/**
 * 完整位置闭包：分别按 4 种锚点条件闭包，返回状态集合（以最宽松的并集）
 * 以及每个状态在 4 种位置条件下的可达性，供子集构造判定接受标记。
 * 返回:
 *   set: 任意条件下可达的并集
 *   acceptFlags: { plain, needStart, needEnd, needBoth } 表示 accept 可达所需条件
 *   perState: Map<state, {start,end}> 在“串首且串尾”闭包里该状态的依赖
 */
export function positionalClosureInfo(nfa, seedArr, edgeIndex, allow = { start: true, end: true }) {
  const variants = [
    { atStart: false, atEnd: false },
    { atStart: true, atEnd: false },
    { atStart: false, atEnd: true },
    { atStart: true, atEnd: true },
  ].filter((v) => (allow.start ? true : !v.atStart) && (allow.end ? true : !v.atEnd));
  const union = new Set();
  const acceptReach = { plain: false, startOnly: false, endOnly: false, both: false };
  let widest = null;
  for (const v of variants) {
    const { set, reach } = epsilonClosureWithReach(nfa, seedArr, edgeIndex, v);
    set.forEach((s) => union.add(s));
    if (v.atStart && v.atEnd) widest = reach;
    if (set.has(nfa.accept)) {
      const req = reach.get(nfa.accept) || { start: false, end: false };
      if (!req.start && !req.end) acceptReach.plain = true;
      else if (req.start && !req.end) acceptReach.startOnly = true;
      else if (!req.start && req.end) acceptReach.endOnly = true;
      else acceptReach.both = true;
    }
  }
  return { set: union, reach: widest, acceptReach };
}

export function positionalClosure(nfa, seedArr, edgeIndex, allow = { start: true, end: true }) {
  return positionalClosureInfo(nfa, seedArr, edgeIndex, allow);
}

export function setAccepts(nfa, stateSet) {
  return stateSet.has(nfa.accept);
}

export function markersOnSet(nfa, stateSet) {
  const found = [];
  for (const e of nfa.edges) {
    if (stateSet.has(e.from) && e.marker) found.push(e);
  }
  return found;
}
