// lexer.js
// 正则子集的词法分析：把源码切成 token。字符类 [a-z]、[^...] 以及
// 预定义类 \d \w \s（含大写取反）在这里整体识别，报错带源码位置。

import {
  singleton,
  builtinSet,
  complement,
  union,
  formatCodePoint,
} from '../charset.js';

export class RegexSyntaxError extends Error {
  constructor(message, position, length = 1) {
    super(message);
    this.name = 'RegexSyntaxError';
    this.position = position; // 出错位置（相对源码的下标）
    this.length = length;
  }
}

const SIMPLE_ESCAPES = {
  t: 0x09,
  n: 0x0a,
  r: 0x0d,
  f: 0x0c,
  v: 0x0b,
  0: 0x00,
};

function isDigit(cp) {
  return cp >= 0x30 && cp <= 0x39;
}
function isLetter(cp) {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/** 读取 \ 开头的转义，返回 { token-ish 描述 } */
function readEscape(src, i, inClass) {
  const slashPos = i;
  if (i + 1 >= src.length) {
    throw new RegexSyntaxError('转义字符不完整：末尾的反斜杠没有内容', slashPos);
  }
  const ch = src[i + 1];
  const cp = ch.codePointAt(0);

  if ('dDwWsS'.includes(ch)) {
    const negated = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
    let set = builtinSet(ch.toLowerCase());
    if (negated) set = complement(set);
    return { kind: 'builtin', name: ch.toLowerCase(), negated, set, pos: slashPos, end: i + 2 };
  }
  if (ch in SIMPLE_ESCAPES) {
    return { kind: 'litcp', cp: SIMPLE_ESCAPES[ch], pos: slashPos, end: i + 2 };
  }
  if (ch === 'b' || ch === 'B') {
    throw new RegexSyntaxError(
      `暂不支持 \\${ch}（单词边界），本工具支持的锚点只有 ^ 和 $`,
      slashPos,
      2
    );
  }
  if (ch === 'u' || ch === 'x') {
    throw new RegexSyntaxError(
      `暂不支持 \\${ch}  Unicode/十六进制转义，请直接写出字符或使用区间`,
      slashPos,
      2
    );
  }
  // 标点转义：按字面处理（\. \\ \+ \^ ...）
  if (!isLetter(cp) && !isDigit(cp)) {
    return { kind: 'litcp', cp, pos: slashPos, end: i + 2 };
  }
  void inClass;
  throw new RegexSyntaxError(`未知的转义序列：\\${ch}`, slashPos, 2);
}

/** 尝试在位置 i 解析 {n} / {n,} / {n,m}，失败则返回 null（{ 按字面处理） */
function readBraceQuant(src, i) {
  // 逗号必须保留：用 (,(\d*)?)? 捕获可选的“逗号 + 上界”，
  // 再根据“是否出现逗号”区分 {n} 与 {n,}
  const m = /^\{(\d+)(,(\d*)?)?\}/.exec(src.slice(i));
  if (!m) return null;
  const raw = m[0];
  const min = Number(m[1]);
  let max;
  if (m[2] === undefined) {
    max = min; // {n}
  } else if (m[3] === undefined || m[3] === '') {
    max = Infinity; // {n,}
  } else {
    max = Number(m[3]); // {n,m}
  }
  return { kind: 'quant', raw, min, max, pos: i, end: i + raw.length };
}

/** 解析字符类内部的一个“原子”：普通字符或转义 */
function readClassAtom(src, i) {
  if (src[i] === '\\') return readEscape(src, i, true);
  const cp = src.codePointAt(i);
  // 代理对按 code point 推进（BMP 之外的字符在字符集里被取反类排除，
  // 这里仍保证词法推进正确）
  const step = cp > 0xffff ? 2 : 1;
  return { kind: 'litcp', cp, pos: i, end: i + step };
}

/** 从 '[' 开始扫描整个字符类 */
function readClass(src, i) {
  const start = i;
  let j = i + 1;
  let negated = false;
  if (src[j] === '^') {
    negated = true;
    j += 1;
  }
  // JS 语义：] 紧跟在 [ 或 [^ 后时是字面量
  if (src[j] === ']') j += 1;

  let set = [];
  const items = []; // {set} 列表，最终取并集
  const pushSet = (s, label) => items.push({ set: s, label });

  while (j < src.length && src[j] !== ']') {
    const atom = readClassAtom(src, j);
    j = atom.end;
    // 区间：a-z （- 后面是 ] 或结尾时，- 为字面量）
    if (src[j] === '-' && j + 1 < src.length && src[j + 1] !== ']') {
      const dashPos = j;
      j += 1;
      const right = readClassAtom(src, j);
      j = right.end;
      if (atom.kind !== 'litcp' || right.kind !== 'litcp') {
        throw new RegexSyntaxError(
          '区间两端必须是普通字符，预定义类（如 \\d）不能用于 a-z 这样的区间',
          atom.pos,
          right.end - atom.pos
        );
      }
      if (atom.cp > right.cp) {
        throw new RegexSyntaxError(
          `字符区间顺序颠倒：${formatCodePoint(atom.cp)}-${formatCodePoint(right.cp)}，起点码点不能大于终点`,
          dashPos - 1,
          right.end - (dashPos - 1)
        );
      }
      pushSet(singleton(atom.cp).map(([lo]) => [lo, right.cp + 1]), null);
    } else if (atom.kind === 'builtin') {
      pushSet(atom.set, `\\${atom.negated ? atom.name.toUpperCase() : atom.name}`);
    } else {
      pushSet(singleton(atom.cp), null);
    }
  }

  if (j >= src.length) {
    throw new RegexSyntaxError('字符类没有闭合：缺少对应的 ]', start, 1);
  }
  const end = j + 1; // 吃掉 ]
  set = items.reduce((acc, it) => union(acc, it.set), []);
  if (negated) set = complement(set);
  return { kind: 'class', set, negated, pos: start, end };
}

/** 词法分析主入口 */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const cp = src.codePointAt(i);

    if (ch === '\\') {
      const esc = readEscape(src, i, false);
      if (esc.kind === 'builtin') {
        tokens.push({ kind: 'builtin', name: esc.name, negated: esc.negated, set: esc.set, pos: esc.pos, end: esc.end });
      } else {
        tokens.push({ kind: 'literal', cp: esc.cp, set: singleton(esc.cp), pos: i, end: esc.end });
      }
      i = esc.end;
      continue;
    }
    if (ch === '[') {
      const cls = readClass(src, i);
      tokens.push({ kind: 'class', set: cls.set, negated: cls.negated, pos: i, end: cls.end });
      i = cls.end;
      continue;
    }
    if (ch === '.') {
      // . 匹配除换行符之外的任意字符
      tokens.push({ kind: 'class', set: complement([[0x0a, 0x0b], [0x0d, 0x0e]]), negated: false, dot: true, pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '^') {
      tokens.push({ kind: 'anchor', dir: 'start', pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '$') {
      tokens.push({ kind: 'anchor', dir: 'end', pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '(') {
      if (src.startsWith('(?:', i)) {
        tokens.push({ kind: 'lparen', capture: false, pos: i, end: i + 3 });
        i += 3;
      } else {
        tokens.push({ kind: 'lparen', capture: true, pos: i, end: i + 1 });
        i += 1;
      }
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '|') {
      tokens.push({ kind: 'pipe', pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      tokens.push({ kind: 'quant', op: ch, pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '{') {
      const q = readBraceQuant(src, i);
      if (q) {
        tokens.push(q);
        i = q.end;
        continue;
      }
      tokens.push({ kind: 'literal', cp: 0x7b, set: singleton(0x7b), pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (cp > 0xffff) {
      tokens.push({ kind: 'literal', cp, set: [], pos: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'literal', cp, set: singleton(cp), pos: i, end: i + 1 });
    i += 1;
  }
  return tokens;
}
