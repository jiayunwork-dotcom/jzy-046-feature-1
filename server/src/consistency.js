// consistency.js
// 对一批测试串并行运行 NFA / DFA / 最小 DFA / 回溯（贪婪+懒惰），
// 比较接受/拒绝结论是否完全一致——这是整套自动机构造正确性的核心判据。

import { matchBacktracking } from './match/backtracker.js';
import { matchNFA } from './match/nfa-sim.js';
import { matchDFA } from './match/dfa-sim.js';

export function checkConsistency({ nfa, dfa, minDFA }, strings) {
  const sameSpan = (a, b) =>
    a.matched === b.matched && (a.result?.start ?? null) === (b.result?.start ?? null) && (a.result?.end ?? null) === (b.result?.end ?? null);

  const results = strings.map((input) => {
    const runs = {
      nfa: matchNFA(nfa, input),
      dfa: matchDFA(dfa, input),
      minDfa: minDFA ? matchDFA(minDFA, input) : null,
      backtrackGreedy: matchBacktracking(nfa, input, { mode: 'greedy' }),
      backtrackLazy: matchBacktracking(nfa, input, { mode: 'lazy' }),
    };
    const baseline = {
      matched: runs.nfa.matched,
      start: runs.nfa.result?.start ?? null,
      end: runs.nfa.result?.end ?? null,
    };
    // 懒惰引擎允许跨度更短（最短匹配），但接受/拒绝结论必须一致；
    // 其余引擎（贪婪回溯、NFA、DFA、最小 DFA）连匹配区间都应完全相同。
    const spanEngines = ['dfa', 'minDfa', 'backtrackGreedy'];
    const boolConsistent = Object.values(runs).every((r) => r === null || r.matched === baseline.matched);
    const spanConsistent = spanEngines.every((k) => {
      const r = runs[k];
      return r === null || sameSpan({ matched: baseline.matched, result: { start: baseline.start, end: baseline.end } }, r);
    });

    const answers = {};
    for (const [k, r] of Object.entries(runs)) {
      answers[k] = r === null ? null : {
        matched: r.matched,
        start: r.result ? r.result.start : null,
        end: r.result ? r.result.end : null,
      };
    }
    return { input, consistent: boolConsistent && spanConsistent, answers };
  });
  return {
    allConsistent: results.every((r) => r.consistent),
    cases: results,
  };
}

