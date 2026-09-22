// subset.js
// 子集构造法：NFA -> DFA。
// 字母表不是穷举所有字符，而是对“出现在 NFA 字符边上的字符集”做 minterm
// 布尔划分——每个原子区间内，任意字符的转移完全一致，因此一个原子就是
// DFA 的一个符号。BMP 之外字符落入“其他”符号（通向死状态）。
//
// 锚点处理：闭包按 (atStart, atEnd) 的允许组合分别计算并集，DFA 状态记录
// “接受态在什么位置条件下可达”（plain / startOnly / endOnly / both），
// 模拟时按当前真实位置判断，避免把仅在串尾可达的接受态误当成任意位置接受。

import { contains, partition, formatCodePoint } from '../charset.js';
import { positionalClosure, indexEdges } from '../nfa/nfa-ops.js';

export const DEFAULT_DFA_LIMIT = 256;

export class SubsetBuildError extends Error {
  constructor(message, truncated = false) {
    super(message);
    this.name = 'SubsetBuildError';
    this.truncated = truncated;
  }
}

/** 模拟时：某 DFA 状态在当前位置是否接受 */
export function acceptsAt(accept, atStart, atEnd) {
  if (!accept) return false;
  if (accept.plain) return true;
  if (accept.startOnly) return atStart;
  if (accept.endOnly) return atEnd;
  if (accept.both) return atStart && atEnd;
  return false;
}

/** 任一位置条件下可能接受（画布双圈展示用宽松判定） */
export function maybeAccepts(accept) {
  return !!accept && (accept.plain || accept.startOnly || accept.endOnly || accept.both);
}

function closureOf(nfa, seeds, edgeIndex, allow = { start: true, end: true }) {
  const info = positionalClosure(nfa, seeds, edgeIndex, allow);
  return { members: [...info.set].sort((a, b) => a - b), accept: info.acceptReach };
}

/**
 * @param {object} nfa buildNFA 的产物
 */
export function buildDFA(nfa, { limit = DEFAULT_DFA_LIMIT } = {}) {
  const edgeIndex = indexEdges(nfa);

  // 1) 收集字符边上的字符集，做 minterm 划分
  const charEdges = nfa.edges.filter((e) => e.type === 'char');
  const sets = charEdges.map((e) => e.set);
  const atoms = partition(sets);
  const symbols = atoms.filter((a) => a.mask !== 0).map((a) => ({ lo: a.lo, hi: a.hi, mask: a.mask }));
  const other = atoms.filter((a) => a.mask === 0).map((a) => [a.lo, a.hi]);

  // 2) 两个初始闭包：串首（允许 ^）与非串首（search 语义 p>0 起跑）
  const c0 = closureOf(nfa, [nfa.start], edgeIndex, { start: true, end: true });
  const c0NoStart = closureOf(nfa, [nfa.start], edgeIndex, { start: false, end: true });

  const dfaStates = [];
  const keyToId = new Map();
  const transitions = [];
  const steps = [];
  let stepId = 0;

  const register = (members, accept, { seedReason, initial = false, searchInitial = false }) => {
    const key = members.join(',');
    if (keyToId.has(key)) return keyToId.get(key);
    const id = dfaStates.length;
    dfaStates.push({
      id,
      nfaStates: members,
      accept,
      accepting: maybeAccepts(accept),
      initial,
      searchInitial,
    });
    keyToId.set(key, id);
    steps.push({
      type: 'newState',
      id: stepId++,
      dfaId: id,
      nfaStates: members,
      accept,
      accepting: maybeAccepts(accept),
      initial,
      searchInitial,
      reason: seedReason,
    });
    return id;
  };

  const q0 = register(c0.members, c0.accept, {
    initial: true,
    seedReason: 'q0 = ε-闭包({NFA 起点}) 的并集；接受标记记录“仅在串首/串尾可达”等位置条件',
  });
  const q0NoStart = register(c0NoStart.members, c0NoStart.accept, {
    searchInitial: c0NoStart.members.join(',') !== c0.members.join(','),
    seedReason: "q0' = 不穿越 ^ 边的初始闭包（从非串首位置搜索时使用）；成员相同则与 q0 复用",
  });

  const worklist = q0NoStart === q0 ? [q0] : [q0, q0NoStart];
  let truncated = false;
  let truncationDetail = null;

  while (worklist.length) {
    const id = worklist.shift();
    const members = dfaStates[id].nfaStates;

    for (let symIdx = 0; symIdx < symbols.length; symIdx += 1) {
      if (truncated) break;
      const sym = symbols[symIdx];
      const cp = sym.lo;
      const dests = [];
      const usedEdges = [];
      for (const u of members) {
        const list = edgeIndex.get(u);
        if (!list) continue;
        for (const e of list) {
          if (e.type === 'char' && contains(e.set, cp)) {
            if (!dests.includes(e.to)) dests.push(e.to);
            usedEdges.push(e.id);
          }
        }
      }
      // 消费字符后 atStart 必为 false；闭包时仍允许 $（是否在串尾由模拟器判断）
      const { members: targetMembers, accept } = closureOf(nfa, dests, edgeIndex, {
        start: false,
        end: true,
      });
      const key = targetMembers.join(',');
      let target = keyToId.get(key);
      const isNew = target === undefined;
      if (isNew) {
        if (dfaStates.length >= limit) {
          truncated = true;
          truncationDetail = { limit, fromState: id, symbol: { lo: sym.lo, hi: sym.hi } };
          break;
        }
        target = register(targetMembers, accept, {
          seedReason:
            targetMembers.length === 0
              ? '空集合：没有任何 NFA 状态可达，这就是 DFA 的死状态'
              : `由 DFA 状态 S${id} 在符号 ${symbolLabel(sym)} 下转移而来（先字符边，再 ε-闭包）`,
        });
        worklist.push(target);
      }
      transitions.push({ from: id, symbol: symIdx, to: target });
      steps.push({
        type: 'transition',
        id: stepId++,
        from: id,
        to: target,
        isNew,
        symbolIndex: symIdx,
        nfaSeedStates: [...new Set(dests)].sort((a, b) => a - b),
        nfaClosure: targetMembers,
        usedEdgeIds: [...new Set(usedEdges)],
        fromNfaStates: [...members],
      });
    }

    if (truncated) break;
  }

  // 3) 缺失转移与“其他”符号补死状态
  const symCount = symbols.length;
  let deadState = keyToId.get('');
  if (deadState === undefined && !truncated) {
    deadState = dfaStates.length;
    dfaStates.push({ id: deadState, nfaStates: [], accept: null, accepting: false, dead: true });
    keyToId.set('', deadState);
    steps.push({
      type: 'newState',
      id: stepId++,
      dfaId: deadState,
      nfaStates: [],
      accept: null,
      accepting: false,
      dead: true,
      reason: '死状态：任何字符类都不匹配时落入，进入后无法离开',
    });
  }
  if (deadState !== undefined) {
    for (let fromId = 0; fromId < dfaStates.length; fromId += 1) {
      for (let s = 0; s < symCount; s += 1) {
        if (!transitions.some((t) => t.from === fromId && t.symbol === s)) {
          transitions.push({ from: fromId, symbol: s, to: deadState });
        }
      }
      transitions.push({ from: fromId, symbol: -1, to: deadState });
    }
    steps.push({
      type: 'deadLoops',
      id: stepId++,
      deadState,
      reason: '为每个缺失转移补“进入死状态”，死状态在所有符号（含其他符号）上自环',
    });
  }

  const transitionMap = buildTransitionMap(transitions, symCount);

  return {
    states: dfaStates,
    transitions,
    transitionMap,
    symbols,
    other,
    start: q0,
    searchStart: q0NoStart,
    steps,
    truncated,
    truncationDetail,
    limit,
  };
}

function buildTransitionMap(transitions, symbolCount) {
  const map = new Map();
  for (const t of transitions) {
    map.set(t.from * (symbolCount + 1) + t.symbol, t.to);
  }
  return map;
}

export function symbolLabel(sym) {
  if (sym.hi - sym.lo === 1) return formatCodePoint(sym.lo);
  return `${formatCodePoint(sym.lo)}-${formatCodePoint(sym.hi - 1)}`;
}

/** DFA 上按字符走一步；BMP 之外字符或未覆盖字符走“其他”符号（-1） */
export function dfaStep(dfa, stateId, cp) {
  const symCount = dfa.symbols.length;
  let symIdx = -1;
  if (cp <= 0xffff) {
    for (let i = 0; i < symCount; i += 1) {
      const s = dfa.symbols[i];
      if (cp >= s.lo && cp < s.hi) {
        symIdx = i;
        break;
      }
    }
  }
  const key = stateId * (symCount + 1) + symIdx;
  if (dfa.transitionMap.has(key)) return dfa.transitionMap.get(key);
  return null;
}
