// analyze.js
// 灾难性回溯分析：
//  1) 静态结构分析——扫描 AST，找出“无界量词内部又含无界量词且两边可匹配
//     同一字符”这类指数爆炸结构（(a+)+ 是经典例子），以及嵌套在量词里的
//     选择分支重叠。
//  2) 经验探针——用一串“几乎匹配但末尾不匹配”的对抗输入喂给回溯引擎，
//     比较输入长度与步数的增长关系，区分线性 / 平方级 / 指数级。

import { intersects } from '../charset.js';
import { buildNFA } from '../nfa/thompson.js';
import { matchBacktracking } from '../match/backtracker.js';

function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  fn(node, parent);
  switch (node.type) {
    case 'pattern':
      walk(node.body, fn, node);
      break;
    case 'concat':
      node.items.forEach((c) => walk(c, fn, node));
      break;
    case 'alternation':
      node.branches.forEach((b) => walk(b, fn, node));
      break;
    case 'repeat':
      walk(node.atom, fn, node);
      break;
    case 'group':
      walk(node.body, fn, node);
      break;
    default:
      break;
  }
}

function isUnbounded(node) {
  return node.type === 'repeat' && node.max === Infinity;
}

/** 取一个节点能消费的首字符集合（用于判断“重叠”） */
function firstChars(node) {
  if (!node) return [];
  if (node.type === 'char' || node.type === 'charClass') return node.set || [];
  if (node.type === 'group' || (node.type === 'repeat')) {
    return node.type === 'group' ? firstChars(node.body) : firstChars(node.atom);
  }
  if (node.type === 'concat') {
    // 简化处理：首段若可为空（量词 min=0）需并上后段；这里取首段并集即可
    // 覆盖最常见的 (a+)+ 重叠判定场景
    let acc = [];
    for (const item of node.items) {
      acc = [...acc, ...firstChars(item)];
      if (!(item.type === 'repeat' && item.min === 0) && item.type !== 'anchor') break;
    }
    return acc;
  }
  if (node.type === 'alternation') {
    return node.branches.reduce((acc, b) => [...acc, ...firstChars(b)], []);
  }
  return [];
}

function describeNode(ast, node) {
  return ast ? '' : '';
}

export function staticAnalyze(ast, source) {
  const warnings = [];

  walk(ast, (node) => {
    if (!isUnbounded(node)) return;
    const atom = node.atom;

    // 情形 A：外层无界量词包住无界量词（(a+)+ / (a*)* / (a+)* 等）
    let inner = null;
    walk(atom, (n) => {
      if (n !== atom && isUnbounded(n) && !inner) inner = n;
    });
    if (inner) {
      const outerFirst = firstChars(node.atom);
      const innerFirst = firstChars(inner.atom);
      const overlap = intersects(outerFirst, innerFirst) || outerFirst.length === 0;
      warnings.push({
        kind: 'nested-unbounded',
        severity: overlap ? 'exponential' : 'risk',
        pos: node.pos,
        end: node.end,
        title: overlap ? '嵌套无界量词，可能指数级回溯' : '嵌套无界量词',
        detail: overlap
          ? `外层与内层重复能匹配相同字符，输入“长得几乎对、最后一个字符不对”时尝试次数指数爆炸（经典反例 (a+)+）。位置 ${node.pos}..${node.end}`
          : `内外层重复字符集不重叠，通常安全，但结构仍可能在复杂输入下变慢。位置 ${node.pos}..${node.end}`,
        pattern: source.slice(node.pos, node.end),
      });
      return;
    }

    // 情形 B：无界量词内部是选择分支，且分支首字符有重叠（a|aa 类）
    if (atom.type === 'group' || atom.type === 'alternation') {
      const alt = atom.type === 'group' ? unwrapAlt(atom.body) : atom;
      if (alt && alt.type === 'alternation') {
        const firsts = alt.branches.map((b) => firstChars(b));
        for (let i = 0; i < firsts.length; i += 1) {
          for (let j = i + 1; j < firsts.length; j += 1) {
            if (intersects(firsts[i], firsts[j])) {
              warnings.push({
                kind: 'overlapping-alt',
                severity: 'exponential',
                pos: node.pos,
                end: node.end,
                title: '量词内选择分支首字符重叠',
                detail: `两个分支能匹配相同的起始字符，失败时引擎会尝试大量排列组合。位置 ${node.pos}..${node.end}`,
                pattern: source.slice(node.pos, node.end),
              });
              return;
            }
          }
        }
      }
    }

    // 情形 C：相邻两个无界量词字符集重叠（a*a* / \d+\w+ 这类）
    if (node.__inConcatAfterUnbounded) {
      // 由 concat 扫描填充（见下方第二段 walk）
    }
  });

  // 情形 C：相邻量词重叠（a*a* / .*.* 等）
  walk(ast, (n) => {
    if (n.type !== 'concat') return;
    n.items.forEach((item, idx) => {
      if (!isUnbounded(item) || idx === 0) return;
      const prev = n.items[idx - 1];
      if (isUnbounded(prev)) {
        const a = firstChars(prev.atom);
        const b = firstChars(item.atom);
        if (intersects(a, b) || a.length === 0 || b.length === 0) {
          warnings.push({
            kind: 'adjacent-unbounded',
            severity: 'quadratic-or-worse',
            pos: prev.pos,
            end: item.end,
            title: '相邻无界量词字符集重叠',
            detail: `前一个量词和后一个量词能匹配同一批字符，边界可以在多处滑动，失败时至少平方级回溯。位置 ${prev.pos}..${item.end}`,
            pattern: source.slice(prev.pos, item.end),
          });
        }
      }
    });
  });

  void describeNode;
  return {
    dangerous: warnings.some((w) => w.severity === 'exponential'),
    warnings,
  };
}

function unwrapAlt(node) {
  return node && node.type === 'alternation' ? node : null;
}

/** 用串首锚点包装 AST：^(?:body)，强制探针只从位置 0 尝试一次 */
function wrapStartAnchor(ast) {
  return {
    ...ast,
    body: {
      id: -1,
      type: 'concat',
      pos: 0,
      end: ast.body.end + 1,
      items: [
        { id: -2, type: 'anchor', dir: 'start', pos: 0, end: 1 },
        ast.body,
      ],
    },
  };
}

// ---------- 经验探针 ----------

/** 选一个“尽量能匹配整条正则”的重复字符：取 AST 中出现频率最高的字面字符/数字 */
function pickProbeChar(ast) {
  const freq = new Map();
  walk(ast, (n) => {
    if (n.type === 'char') freq.set(n.cp, (freq.get(n.cp) || 0) + 1);
  });
  let best = 0x61; // 默认 a
  let bestN = -1;
  freq.forEach((n, cp) => {
    if (n > bestN) {
      bestN = n;
      best = cp;
    }
  });
  return String.fromCodePoint(best);
}

/**
 * 经验探针：度量“单次起点尝试”内部的步数增长。
 * 搜索语义下失败串会在每个位置重跑一次，这层 O(n) 次重启会让任何正则
 * 都呈现平方级表象；为只测引擎本身的回溯增长，这里用“内部 NFA + 串首
 * 锚点包装”强制只从位置 0 尝试（锚点不改变量词结构的爆炸特性）。
 */
export function empiricalProbe(ast, source, { lengths = [6, 9, 12, 15, 18] } = {}) {
  const ch = pickProbeChar(ast);
  // 直接基于 AST 再包一层 ^：构造 ^(?:ast) 的 NFA
  const wrapped = wrapStartAnchor(ast);
  const nfa = buildNFA(wrapped);
  const samples = [];
  for (const k of lengths) {
    const input = ch.repeat(k) + '\x00'; // 末尾塞一个几乎必不匹配的字符
    const r = matchBacktracking(nfa, input, { stepCap: 500000 });
    samples.push({
      length: k + 1,
      attempts: r.metrics.edgeAttempts,
      backtracks: r.metrics.backtracks,
      capped: r.metrics.capped,
      matched: r.matched,
    });
  }

  // 用 ratios 判定增长级别
  const valid = samples.filter((s) => !s.capped && s.attempts > 0);
  let classification = 'linear-or-better';
  if (valid.length >= 3) {
    const ratios = [];
    for (let i = 1; i < valid.length; i += 1) {
      const dl = valid[i].length - valid[i - 1].length;
      const logG = Math.log(valid[i].attempts / valid[i - 1].attempts) / dl;
      ratios.push(logG);
    }
    const avgLog = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    // 指数：每多一个字符步数翻 ~2 倍（ln2≈0.69）
    if (avgLog > 0.45 || samples.some((s) => s.capped)) classification = 'exponential';
    else if (avgLog > 0.12) classification = 'quadratic-or-worse';
    else classification = 'linear-or-better';
  } else if (samples.some((s) => s.capped)) {
    classification = 'exponential';
  }

  const suggestion = buildSuggestion(source, classification);
  return { probeChar: ch, samples, classification, suggestion };
}

function buildSuggestion(source, classification) {
  if (classification === 'exponential') {
    return [
      `“${source}” 在对抗输入下步数指数增长。核心手法是消除“量词套量词还匹配同一字符”的歧义：`,
      '1) 用占有式思路改写：本工具不支持占有量词，但可把 (a+)+ 改成 a+（外层重复是多余的）；',
      '2) 收紧内部结构，例如 (\\w+\\s*)+ 改成 \\w+(?:\\s+\\w+)*，让每个重复段都强制吃掉一个明确分隔符；',
      '3) 用否定字符类消除“边界可以来回滑动”，例如 ".*" 改成 "[^"]*"；',
      '4) 若只想知道匹配与否，切换到 DFA 引擎播放——DFA 对任意输入都是线性时间，绝不回溯。',
    ];
  }
  if (classification === 'quadratic-or-worse') {
    return [
      `“${source}” 的步数随输入长度呈平方级以上增长。建议：`,
      '1) 检查相邻量词是否在抢同一批字符，给后一段加“必须先吃分隔符”的约束；',
      '2) 把 .*、.+ 换成明确的否定字符类（[^"]*、[^<]*）；',
      '3) 教学上可切换到 NFA/DFA 引擎对比：它们不会回溯，长度敏感场景更稳。',
    ];
  }
  return ['经验探针未观察到超线性增长。'];
}

export function analyzePattern(ast, source) {
  const staticResult = staticAnalyze(ast, source);
  const empirical = empiricalProbe(ast, source);
  return {
    ...staticResult,
    empirical,
    classification: empirical.classification,
  };
}
