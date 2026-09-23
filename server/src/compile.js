// compile.js
// 串联整条流水线：源码 -> AST -> NFA -> DFA -> 最小 DFA，并生成三套机器
// 对同一批串的一致性校验结果（本工具正确性的核心判据）。
//
// 例外：含反向引用的模式不是正则语言，有限状态机无法表示。此时流水线在
// AST 之后明确进入“不可确定化”状态，nfa/dfa/minDFA 全部为 null 并给出
// nonRegular 说明，绝不静默构造语义错误的自动机去污染一致性校验。

import { parsePattern, RegexSyntaxError } from './parser/parser.js';
import { buildNFA } from './nfa/thompson.js';
import { buildDFA } from './dfa/subset.js';
import { minimizeDFA } from './dfa/minimize.js';
import { findBackrefs, nonRegularInfo } from './regularity.js';

export { RegexSyntaxError };

export function compile(source, { dfaLimit = 256, nfaMode = 'greedy' } = {}) {
  const ast = parsePattern(source);
  const backrefs = findBackrefs(ast);

  if (backrefs.length) {
    return {
      ast,
      nfa: null,
      dfa: null,
      minDFA: null,
      minError: null,
      nonRegular: nonRegularInfo(ast, source),
    };
  }

  const nfa = buildNFA(ast, { mode: nfaMode });
  const dfa = buildDFA(nfa, { limit: dfaLimit });
  let minDFA = null;
  let minError = null;
  try {
    minDFA = dfa.truncated ? null : minimizeDFA(dfa);
  } catch (err) {
    minError = err.message;
  }
  return { ast, nfa, dfa, minDFA, minError, nonRegular: null };
}
