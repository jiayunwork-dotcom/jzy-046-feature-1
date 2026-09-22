// nfa-sim.js
// NFA 子集模拟（不回溯）：每一帧维护“当前所有可能的活跃状态集合”。
// 按 search 语义从每个位置尝试一次；与回溯引擎、DFA 引擎结论一致。
// 贪婪（最左-最长）：记住沿途中过的最后一个接受位置，集合死光后取最长。

import { contains } from '../charset.js';
import { positionalClosure, indexEdges } from '../nfa/nfa-ops.js';
import { acceptsAt } from '../dfa/subset.js';

export const NFA_FRAME_CAP = 20000;

export function matchNFA(nfa, input) {
  const chars = Array.from(input);
  const len = chars.length;
  const edgeIndex = indexEdges(nfa);
  const frames = [];
  let transitions = 0;
  const visitedStates = new Set();

  const record = (f) => {
    if (frames.length < NFA_FRAME_CAP) frames.push({ index: frames.length, ...f });
  };

  // 取活跃集合（并集），并按“当前真实位置”判定接受
  const activeInfo = (seeds, pos) => {
    const atStart = pos === 0;
    const atEnd = pos === len;
    const info = positionalClosure(nfa, [...seeds], edgeIndex, {
      start: atStart, // 非串首尝试不得穿越 ^ 边
      end: true,
    });
    return {
      set: info.set,
      flags: info.acceptReach,
      accepts: acceptsAt(info.acceptReach, atStart, atEnd),
    };
  };

  let matched = false;
  let result = null;

  outer: for (let start = 0; start <= len; start += 1) {
    let { set: active, accepts: initialAccept } = activeInfo([nfa.start], start);
    active.forEach((s) => visitedStates.add(s));
    record({
      kind: 'attempt',
      pos: start,
      activeStates: [...active].sort((a, b) => a - b),
      message: `从位置 ${start} 尝试：初始活跃集合 = ε-闭包({S${nfa.start}})${start === 0 ? '（串首，^ 可通过）' : ''}`,
    });

    let lastAccept = initialAccept ? start : null;
    if (lastAccept !== null) {
      record({
        kind: 'accept-here', pos: start, start, end: start, match: '',
        activeStates: [...active].sort((a, b) => a - b),
        message: '当前集合在该位置满足接受条件（可停），继续看能否吃更长',
      });
    }

    for (let pos = start; pos < len; pos += 1) {
      const cp = chars[pos].codePointAt(0);
      const seeds = new Set();
      const usedEdges = [];
      active.forEach((u) => {
        const list = edgeIndex.get(u);
        if (!list) return;
        for (const e of list) {
          if (e.type === 'char' && e.set.length > 0 && contains(e.set, cp)) {
            seeds.add(e.to);
            usedEdges.push(e.id);
          }
        }
      });
      transitions += usedEdges.length;
      seeds.forEach((s) => visitedStates.add(s));
      if (seeds.size === 0) {
        record({
          kind: 'die',
          pos,
          char: chars[pos],
          activeStates: [],
          message: `字符 "${chars[pos]}" 杀死了所有活跃状态（没有任何可转移边）`,
        });
        active = new Set();
        break;
      }
      const info = activeInfo(seeds, pos + 1);
      active = info.set;
      active.forEach((s) => visitedStates.add(s));
      record({
        kind: 'consume',
        pos,
        char: chars[pos],
        activeStates: [...active].sort((a, b) => a - b),
        edgeIds: [...new Set(usedEdges)],
        message: `消费 "${chars[pos]}"：先走字符边再做 ε-闭包，得到 ${active.size} 个活跃状态${
          pos + 1 === len ? '（已到串尾，$ 可通过）' : ''
        }`,
      });
      if (info.accepts) {
        lastAccept = pos + 1;
        record({
          kind: 'accept-here',
          pos: pos + 1,
          activeStates: [...active].sort((a, b) => a - b),
          message: `活跃集合在位置 ${pos + 1} 满足接受条件（$ 与串尾状态一致），贪婪策略继续尝试吃更长`,
        });
      }
    }

    if (lastAccept !== null) {
      matched = true;
      result = { start, end: lastAccept };
      record({
        kind: 'accept',
        pos: lastAccept,
        start,
        end: lastAccept,
        match: chars.slice(start, lastAccept).join(''),
        message: `所有可能性已穷尽，取最长匹配：位置 ${start}..${lastAccept}`,
      });
      break outer;
    }
    record({ kind: 'attempt-fail', pos: start, activeStates: [], message: `起点 ${start} 失败：途中没有任何位置满足接受条件` });
  }

  return {
    engine: 'nfa',
    input,
    matched,
    result,
    frames,
    metrics: {
      transitions,
      backtracks: 0,
      visitedStates: visitedStates.size,
      frameCount: frames.length,
      inputLength: len,
    },
  };
}
