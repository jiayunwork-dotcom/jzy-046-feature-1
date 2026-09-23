// parser.js
// 递归下降解析器，文法（自上而下）：
//   pattern   := alternation
//   alternation := concat ('|' concat)*
//   concat    := quantified*
//   quantified := atom quantifier?
//   atom      := '(' pattern ')' | '[' class ']' | '\\d' | backref | literal | anchor
// 产出带源码位置的 AST，量词记录 min/max/贪婪性，捕获组按出现顺序编号；
// 命名捕获组 (?<name>...) 同步登记名字，反向引用 \数字 / \k<名字> 在解析
// 阶段就完成“组是否存在 / 是否自引用 / 是否闭合前置引用”的全部检查。

import { tokenize, RegexSyntaxError } from './lexer.js';
import { makeNode, resetNodeIds } from './ast.js';

export { RegexSyntaxError };

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Parser {
  constructor(tokens, src) {
    this.tokens = tokens;
    this.src = src;
    this.i = 0;
    this.groupCount = 0;
    this.groups = []; // [{ index, name, pos, end }]
    this.nameToIndex = new Map();
    this.openGroups = []; // 当前正在解析、尚未闭合的捕获组编号栈
    this.backrefs = [];
  }

  peek() {
    return this.tokens[this.i] || null;
  }
  next() {
    return this.tokens[this.i++];
  }

  parse() {
    const pos = this.peek() ? this.peek().pos : 0;
    const end = this.src.length;
    const alt = this.parseAlternation(/* untilRParen */ false);
    return makeNode('pattern', pos, end, {
      body: alt,
      groupCount: this.groupCount,
      groups: this.groups,
      backrefs: this.backrefs.map((n) => ({
        pos: n.pos,
        end: n.end,
        group: n.group,
        name: n.name ?? null,
      })),
    });
  }

  parseAlternation(untilRParen) {
    const branches = [this.parseConcat()];
    let start = branches[0].pos;
    let end = branches[0].end;
    while (this.peek() && this.peek().kind === 'pipe') {
      const pipe = this.next();
      // 允许 a| 或 |b 形式的空分支：解析直到 | 或 ) 或结尾
      branches.push(this.parseConcat());
      end = pipe.end;
    }
    const lastBranch = branches[branches.length - 1];
    end = lastBranch ? lastBranch.end : end;
    if (branches.length === 1) return branches[0];
    return makeNode('alternation', start, end, { branches });
  }

  parseConcat() {
    const items = [];
    let end = null;
    const startPos = this.peek() ? this.peek().pos : this._lastEnd();
    while (this.peek()) {
      const t = this.peek();
      if (t.kind === 'pipe' || t.kind === 'rparen') break;
      items.push(this.parseQuantified());
      end = items[items.length - 1].end;
    }
    if (items.length === 0) {
      const pos = startPos;
      return makeNode('epsilon', pos, pos, {});
    }
    if (items.length === 1) return items[0];
    return makeNode('concat', items[0].pos, end ?? items[items.length - 1].end, { items });
  }

  _lastEnd() {
    // 空分支定位用：尽量取前一个 token 的结尾
    const prev = this.tokens[this.i - 1];
    return prev ? prev.end : 0;
  }

  parseQuantified() {
    const atom = this.parseAtom();
    const t = this.peek();
    if (!t || t.kind !== 'quant') return atom;
    this.next();

    let kind;
    let min;
    let max;
    if (t.op === '*' || t.op === '+' || t.op === '?') {
      kind = t.op;
      min = t.op === '+' ? 1 : 0;
      max = t.op === '?' ? 1 : Infinity;
    } else {
      kind = 'brace';
      ({ min, max } = t);
    }

    if (max !== Infinity && min > max) {
      throw new RegexSyntaxError(
        `量词范围非法：最少重复 ${min} 次却最多重复 ${max} 次（应为 min ≤ max）`,
        t.pos,
        t.end - t.pos
      );
    }

    let greedy = true;
    let lazyMark = null;
    // 紧跟量词的 '?' 是惰性标记（词法器统一把 ? 识别成 quant token）
    const after = this.peek();
    if (
      after &&
      after.kind === 'quant' &&
      after.op === '?' &&
      after.pos === t.end
    ) {
      this.next();
      greedy = false;
      lazyMark = after;
    }

    const end = lazyMark ? lazyMark.end : t.end;
    return makeNode('repeat', atom.pos, end, {
      atom,
      kind,
      min,
      max,
      greedy,
      quantPos: t.pos,
      quantEnd: t.end,
    });
  }

  parseAtom() {
    const t = this.peek();
    if (!t) {
      throw new RegexSyntaxError('此处需要一个正则原子（字符、字符类或分组）', this.src.length, 1);
    }

    if (t.kind === 'quant') {
      throw new RegexSyntaxError(
        `量词 "${t.op || t.raw}" 前面没有可重复的对象`,
        t.pos,
        t.end - t.pos
      );
    }
    if (t.kind === 'rparen') {
      throw new RegexSyntaxError('多余的右括号 )，没有与之配对的 (', t.pos, 1);
    }

    if (t.kind === 'lparen') {
      return this.parseGroup();
    }
    if (t.kind === 'anchor') {
      this.next();
      return makeNode('anchor', t.pos, t.end, { dir: t.dir });
    }
    if (t.kind === 'backrefName') {
      this.next();
      return this.makeNamedBackref(t);
    }
    if (t.kind === 'backrefNum') {
      this.next();
      return this.makeNumericBackref(t);
    }
    if (t.kind === 'literal') {
      this.next();
      return makeNode('char', t.pos, t.end, { cp: t.cp, set: t.set });
    }
    if (t.kind === 'builtin') {
      this.next();
      return makeNode('charClass', t.pos, t.end, {
        set: t.set,
        builtin: t.name,
        negated: t.negated,
      });
    }
    if (t.kind === 'class') {
      this.next();
      return makeNode('charClass', t.pos, t.end, {
        set: t.set,
        builtin: null,
        negated: !!t.negated,
        dot: !!t.dot,
      });
    }
    // 理论不可达
    this.next();
    throw new RegexSyntaxError(`无法识别的 token：${this.src.slice(t.pos, t.end)}`, t.pos, t.end - t.pos);
  }

  /** 校验组名（报错位置一律定在这对括号的左括号上） */
  validateGroupName(name, open) {
    if (name.length === 0) {
      throw new RegexSyntaxError(
        '命名捕获组的组名不能为空：(?<名字>...) 里必须写出标识符',
        open.pos,
        open.end - open.pos
      );
    }
    if (/^[0-9]/.test(name)) {
      throw new RegexSyntaxError(
        `命名捕获组的组名 "${name}" 不能以数字开头（标识符规则：字母或下划线开头）`,
        open.pos,
        open.end - open.pos
      );
    }
    if (!IDENTIFIER_RE.test(name)) {
      // 找出第一个非法字符，辅助定位
      let bad = 0;
      while (bad < name.length && /[A-Za-z0-9_]/.test(name[bad])) bad += 1;
      throw new RegexSyntaxError(
        `命名捕获组的组名 "${name}" 不合法：只能使用字母、数字和下划线，且不能以数字开头（非法字符${bad < name.length ? ` "${name[bad]}"` : ''}）`,
        open.pos,
        open.end - open.pos
      );
    }
    if (this.nameToIndex.has(name)) {
      const first = this.groups[this.nameToIndex.get(name) - 1];
      throw new RegexSyntaxError(
        `命名捕获组 "${name}" 重复：该名字已被位置 ${first.pos}..${first.end} 的分组使用，同一模式内组名必须唯一`,
        open.pos,
        open.end - open.pos
      );
    }
  }

  parseGroup() {
    const open = this.next(); // lparen
    let index = null;
    let name = null;
    if (open.capture) {
      if (open.named) {
        this.validateGroupName(open.name, open);
        name = open.name;
      }
      this.groupCount += 1;
      index = this.groupCount;
      if (name) this.nameToIndex.set(name, index);
      this.groups.push({ index, name, pos: open.pos, end: null });
      this.openGroups.push(index);
    }
    const body = this.parseAlternation(true);
    const close = this.peek();
    if (!close || close.kind !== 'rparen') {
      throw new RegexSyntaxError(
        `${open.capture ? (open.named ? `命名捕获组 (?<${open.name}>...)` : '捕获组') : '非捕获组'}没有闭合：缺少右括号 )`,
        open.pos,
        open.end - open.pos
      );
    }
    this.next();
    if (open.capture) {
      this.openGroups.pop();
      this.groups[index - 1].end = close.end;
    }
    return makeNode('group', open.pos, close.end, {
      capture: open.capture,
      index,
      name,
      body,
    });
  }

  /** 具名反向引用 \k<name>：名字必须存在，且被引用的分组此刻必须已经闭合 */
  makeNamedBackref(t) {
    const group = this.nameToIndex.get(t.name);
    if (t.name.length === 0) {
      throw new RegexSyntaxError(
        '具名反向引用 \\k<> 的组名不能为空，应为 \\k<组名>',
        t.pos,
        t.end - t.pos
      );
    }
    if (group === undefined) {
      throw new RegexSyntaxError(
        `具名反向引用 \\k<${t.name}> 指向的命名捕获组不存在：当前模式中没有名为 "${t.name}" 的分组（注意区分大小写）`,
        t.pos,
        t.end - t.pos
      );
    }
    this.assertNotOpenRef(group, t, `\\k<${t.name}>`);
    const node = makeNode('backref', t.pos, t.end, { group, name: t.name });
    this.backrefs.push(node);
    return node;
  }

  /**
   * 数字反向引用 \12：按“能对上现有分组号的最长前缀”解析。
   * 此刻对不上的情况一律为语法错误；用掉前缀后剩余的数字不可能再构成
   * 反向引用，按字面数字 token 插回流（与 PCRE 的消歧惯例一致）。
   */
  makeNumericBackref(t) {
    const digits = t.digits;
    let useLen = 0;
    for (let len = digits.length; len >= 1; len -= 1) {
      const n = Number(digits.slice(0, len));
      if (n >= 1 && n <= this.groupCount) { useLen = len; break; }
    }
    if (useLen === 0) {
      const rangeHint = this.groupCount === 0
        ? '当前模式中没有任何捕获组'
        : `当前模式只有 ${this.groupCount} 个捕获组，编号应在 1..${this.groupCount} 之间`;
      throw new RegexSyntaxError(
        `反向引用 \\${digits} 不存在：${rangeHint}（引用必须在被引用分组闭合之后；若只想匹配字面数字，请用 [${digits[0]}] 或拆开书写）`,
        t.pos,
        t.end - t.pos
      );
    }
    const group = Number(digits.slice(0, useLen));
    const refEnd = t.pos + 1 + useLen; // 反斜杠 + useLen 位数字
    this.assertNotOpenRef(group, { pos: t.pos, end: refEnd }, `\\${digits.slice(0, useLen)}`);

    // 用不掉的尾数字：插回 token 流，作为普通字面数字继续解析
    if (useLen < digits.length) {
      const extra = [];
      for (let k = useLen; k < digits.length; k += 1) {
        const cp = 0x30 + Number(digits[k]);
        const dpos = t.pos + 1 + k;
        extra.push({ kind: 'literal', cp, set: [[cp, cp + 1]], pos: dpos, end: dpos + 1 });
      }
      this.tokens.splice(this.i, 0, ...extra);
    }

    const node = makeNode('backref', t.pos, refEnd, { group, name: null });
    this.backrefs.push(node);
    return node;
  }

  /**
   * 自引用 / 闭合前置引用检查：
   * 被引用组还在打开栈里，说明引用点位于该分组内部（自引用）或该组尚未
   * 闭合——这类引用在任何回溯引擎里都不可能拿到已捕获文本，只会陷入
   * 无意义的自引用，必须在解析层挡掉。
   */
  assertNotOpenRef(group, loc, label) {
    if (this.openGroups.includes(group)) {
      const g = this.groups[group - 1];
      const self = this.openGroups[this.openGroups.length - 1] === group;
      throw new RegexSyntaxError(
        self
          ? `反向引用 ${label} 引用了它自己所在的第 ${group} 组：分组闭合之前无法引用自身，任何回溯引擎都无法收敛，请把引用移到分组闭合之后`
          : `反向引用 ${label} 出现在第 ${group} 组闭合之前（位置 ${g.pos}.. 的分组尚未闭合）：引用只能指向已经闭合的捕获组`,
        loc.pos,
        loc.end - loc.pos
      );
    }
  }
}

/** 解析正则源码，成功返回 AST，失败抛 RegexSyntaxError */
export function parsePattern(src) {
  resetNodeIds();
  const tokens = tokenize(src);
  const parser = new Parser(tokens, src);
  const ast = parser.parse();
  // 残余 token 检查（通常已被括号配对覆盖）
  if (parser.i < tokens.length) {
    const t = tokens[parser.i];
    if (t.kind === 'rparen') {
      throw new RegexSyntaxError('多余的右括号 )，没有与之配对的 (', t.pos, 1);
    }
  }
  return ast;
}
