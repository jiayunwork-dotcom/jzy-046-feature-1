// dfa-sim.js
// DFA 模拟：任意时刻只有一个当前状态，每个字符确定性走一步，绝不回溯。
// search 语义：位置 0 起跑用 q0（闭包允许 ^）；位置 p>0 起跑用 q0NoStart。
// 接受判定结合当前位置：accept 标志区分 plain / startOnly / endOnly / both。

import { dfaStep, acceptsAt } from '../dfa/subset.js';

export const DFA_FRAME_CAP = 20000;

export function matchDFA(dfa, input) {
  const chars = Array.from(input);
  const len = chars.length;
  const frames = [];
  let transitions = 0;
  const visited = new Set();

  const record = (f) => {
    if (frames.length < DFA_FRAME_CAP) frames.push({ index: frames.length, ...f });
  };

  let matched = false;
  let result = null;

  outer: for (let start = 0; start <= len; start += 1) {
    const state0 = start === 0 ? dfa.start : (dfa.searchStart ?? dfa.start);
    let state = state0;
    visited.add(state);
    record({
      kind: 'attempt',
      pos: start,
      state,
      nfaStates: dfa.states[state] ? dfa.states[state].nfaStates : [],
      message:
        start === 0
          ? `从串首启动 DFA（q0，允许 ^ 路径），当前状态 S${state}`
          : `从位置 ${start} 启动 DFA（非串首初始态，^ 路径已排除），当前状态 S${state}`,
    });

    const accepts = (sid, pos) => acceptsAt(dfa.states[sid]?.accept, pos === 0, pos === len);
    let lastAccept = accepts(state, start) ? start : null;
    if (lastAccept !== null) {
      record({ kind: 'accept-here', pos: start, state, start, end: start, message: '当前状态在该位置满足接受条件（可停），贪婪继续吃更长' });
    }

    for (let pos = start; pos < len; pos += 1) {
      const cp = chars[pos].codePointAt(0);
      const next = dfaStep(dfa, state, cp);
      transitions += 1;
      visited.add(next);
      if (next === null || (dfa.states[next] && dfa.states[next].dead)) {
        record({
          kind: 'die',
          pos,
          char: chars[pos],
          state: next,
          message: next === null ? '不存在该转移，拒绝' : `字符 "${chars[pos]}" 进入死状态，所有可能性死亡`,
        });
        break;
      }
      state = next;
      record({
        kind: 'consume',
        pos,
        char: chars[pos],
        state,
        nfaStates: dfa.states[state].nfaStates,
        message: `消费 "${chars[pos]}"，确定性转移到 S${state}`,
      });
      if (accepts(state, pos + 1)) {
        lastAccept = pos + 1;
        record({
          kind: 'accept-here',
          pos: pos + 1,
          state,
          message: `S${state} 在位置 ${pos + 1} 满足接受条件（若到串尾则 $ 成立），继续吃更长`,
        });
      }
    }
    if (lastAccept !== null) {
      matched = true;
      result = { start, end: lastAccept };
      record({
        kind: 'accept',
        pos: lastAccept,
        state,
        start,
        end: lastAccept,
        match: chars.slice(start, lastAccept).join(''),
        message: `进入死状态或读完，取最长匹配：位置 ${start}..${lastAccept}`,
      });
      break outer;
    }
    record({ kind: 'attempt-fail', pos: start, message: `起点 ${start} 失败：途中未经过任何在该位置可接受的状态` });
  }

  return {
    engine: 'dfa',
    input,
    matched,
    result,
    frames,
    metrics: {
      transitions,
      backtracks: 0,
      visitedStates: visited.size,
      frameCount: frames.length,
      inputLength: len,
    },
  };
}
