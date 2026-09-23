// compile.js
// 串联整条流水线：源码 -> AST -> NFA -> DFA -> 最小 DFA，并生成三套机器
// 对同一批串的一致性校验结果（本工具正确性的核心判据）。
//
// 反向引用（\N / \k<name>）超出正则语言的表达能力：它要求“接下来读到的
// 文本必须等于之前记下的文本”，有限状态机没有记忆，任何 Thompson 构造都
// 只会产出语义错误的自动机。因此一旦 AST 中出现反向引用，NFA / DFA /
// 最小化三个阶段一律不构造，明确标记为 nonDeterminizable，只保留 AST 与
// 回溯引擎；不含反向引用的模式流水线完全不变。

import { parsePattern, RegexSyntaxError } from './parser/parser.js';
import { buildNFA } from './nfa/thompson.js';
import { buildDFA } from './dfa/subset.js';
import { minimizeDFA } from './dfa/minimize.js';
import { collectBackrefs, formatBackref } from './features.js';

export { RegexSyntaxError };

export function compile(source, { dfaLimit = 256, nfaMode = 'greedy' } = {}) {
  const ast = parsePattern(source);
  const backrefs = collectBackrefs(ast);

  if (backrefs.length > 0) {
    // 每个反向引用都给出源码位置与写法，前端可精确高亮“是谁挡住了自动机”
    const blockers = backrefs.map((node) => ({
      pos: node.pos,
      end: node.end,
      ref: formatBackref(node),
      refType: node.refType,
      group: node.index,
      reason:
        '反向引用要求后续文本与某个捕获组之前抓到的内容逐字相同；这是依赖“记忆”的比较，' +
        '不是正则语言，NFA/DFA 的状态只表示“已经读到哪里”，无法保存任意长度的已捕获文本',
    }));
    return {
      ast,
      nfa: null,
      dfa: null,
      minDFA: null,
      minError: null,
      nonDeterminizable: true,
      backrefs: blockers,
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
  return { ast, nfa, dfa, minDFA, minError, nonDeterminizable: false, backrefs: [] };
}
