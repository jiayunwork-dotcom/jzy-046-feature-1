// compile.js
// 串联整条流水线：源码 -> AST -> NFA -> DFA -> 最小 DFA，并生成三套机器
// 对同一批串的一致性校验结果（本工具正确性的核心判据）。

import { parsePattern, RegexSyntaxError } from './parser/parser.js';
import { buildNFA } from './nfa/thompson.js';
import { buildDFA } from './dfa/subset.js';
import { minimizeDFA } from './dfa/minimize.js';

export { RegexSyntaxError };

export function compile(source, { dfaLimit = 256, nfaMode = 'greedy' } = {}) {
  const ast = parsePattern(source);
  const nfa = buildNFA(ast, { mode: nfaMode });
  const dfa = buildDFA(nfa, { limit: dfaLimit });
  let minDFA = null;
  let minError = null;
  try {
    minDFA = dfa.truncated ? null : minimizeDFA(dfa);
  } catch (err) {
    minError = err.message;
  }
  return { ast, nfa, dfa, minDFA, minError };
}
