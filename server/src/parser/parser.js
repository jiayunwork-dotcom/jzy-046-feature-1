// parser.js
// 递归下降解析器，文法（自上而下）：
//   pattern   := alternation
//   alternation := concat ('|' concat)*
//   concat    := quantified*
//   quantified := atom quantifier?
//   atom      := '(' pattern ')' | '[' class ']' | '\\d' | '\\N' / '\\k<name>' | literal | anchor
// 产出带源码位置的 AST，量词记录 min/max/贪婪性，捕获组按出现顺序编号
// （命名捕获组 (?<name>...) 同时占一个编号）。反向引用在解析阶段完成
// “目标存在性 + 自引用/前向引用”校验，非法时在反向引用位置抛语法错误。

import { tokenize, RegexSyntaxError } from './lexer.js';
import { makeNode, resetNodeIds } from './ast.js';

export { RegexSyntaxError };

class Parser {
  constructor(tokens, src) {
    this.tokens = tokens;
    this.src = src;
    this.i = 0;
    this.groupCount = 0;
    this.groupByName = new Map(); // name -> index
    this.openGroups = []; // 当前尚未闭合的捕获组 [{index, name}]
    this.pendingBackrefs = []; // 解析时目标尚未注册的反向引用（闭合后再判定）
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
    const ast = makeNode('pattern', pos, end, {
      body: alt,
      groupCount: this.groupCount,
      groupNames: this.nameIndexMap(),
    });
    // 解析过程中目标尚未注册的反向引用：此刻所有分组都已注册，统一裁决
    // （前向引用 vs 根本不存在）
    for (const ref of this.pendingBackrefs) this.resolvePending(ref);
    return ast;
  }

  nameIndexMap() {
    const m = {};
    for (const [name, index] of this.groupByName) m[name] = index;
    return m;
  }

  describeRef(ref) {
    return ref.refType === 'name' ? `\\k<${ref.refValue}>` : `\\${ref.refValue}`;
  }

  /** 反向引用的解析期校验（目标已存在时立即调用） */
  checkBackref(t) {
    if (t.refType === 'number') {
      const num = t.refValue;
      if (num > this.groupCount) {
        // 可能是前向引用，也可能根本不存在：先挂起，parse() 末尾裁决
        this.pendingBackrefs.push({ token: t });
        return;
      }
      const self = this.openGroups.find((g) => g.index === num);
      if (self) {
        throw new RegexSyntaxError(
          `反向引用 \\${num} 指向的第 ${num} 个捕获组此时还没有闭合：` +
            `反向引用不能出现在它所引用的分组内部（自引用在回溯引擎里无法收敛）`,
          t.pos,
          t.end - t.pos
        );
      }
    } else {
      const name = t.refValue;
      if (!this.groupByName.has(name)) {
        this.pendingBackrefs.push({ token: t });
        return;
      }
      const index = this.groupByName.get(name);
      const self = this.openGroups.find((g) => g.index === index);
      if (self) {
        throw new RegexSyntaxError(
          `反向引用 \\k<${name}> 指向命名捕获组 "${name}"，但该分组此时还没有闭合：` +
            `反向引用不能出现在它所引用的分组内部（自引用在回溯引擎里无法收敛）`,
          t.pos,
          t.end - t.pos
        );
      }
    }
  }

  /** 全部分组注册完毕后，裁决挂起的反向引用 */
  resolvePending({ token: t }) {
    if (t.refType === 'number') {
      if (t.refValue > this.groupCount) {
        throw new RegexSyntaxError(
          `反向引用 \\${t.refValue} 不存在：整条正则只有 ${this.groupCount} 个捕获组`,
          t.pos,
          t.end - t.pos
        );
      }
      // 编号已存在 → 解析时该组必然位于反向引用之后（前向引用）
      throw new RegexSyntaxError(
        `反向引用 \\${t.refValue} 出现在第 ${t.refValue} 个捕获组闭合之前：` +
          '不能前向引用尚未闭合的分组（被引用的文本此刻还不存在）',
        t.pos,
        t.end - t.pos
      );
    }
    const name = t.refValue;
    if (!this.groupByName.has(name)) {
      throw new RegexSyntaxError(
        `反向引用 \\k<${name}> 不存在：正则中没有名为 "${name}" 的捕获组`,
        t.pos,
        t.end - t.pos
      );
    }
    throw new RegexSyntaxError(
      `反向引用 \\k<${name}> 出现在命名捕获组 "${name}" 闭合之前：` +
        '不能前向引用尚未闭合的分组（被引用的文本此刻还不存在）',
      t.pos,
      t.end - t.pos
    );
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
    if (t.kind === 'backref') {
      this.next();
      this.checkBackref(t);
      // 数字引用在编号已存在时可直接定到目标组；具名引用同时记下编号
      let index = null;
      let name = null;
      if (t.refType === 'number') {
        index = t.refValue <= this.groupCount ? t.refValue : null;
      } else {
        name = t.refValue;
        index = this.groupByName.get(name) ?? null;
      }
      return makeNode('backref', t.pos, t.end, {
        refType: t.refType,
        refValue: t.refValue,
        index,
        name,
      });
    }
    // 理论不可达
    this.next();
    throw new RegexSyntaxError(`无法识别的 token：${this.src.slice(t.pos, t.end)}`, t.pos, t.end - t.pos);
  }

  parseGroup() {
    const open = this.next(); // lparen
    let index = null;
    let name = null;
    if (open.capture) {
      this.groupCount += 1;
      index = this.groupCount;
      if (open.name) {
        name = open.name;
        if (this.groupByName.has(name)) {
          throw new RegexSyntaxError(
            `命名捕获组的组名 "${name}" 重复：第 ${this.groupByName.get(name)} 组已经使用过这个名字，组名必须唯一`,
            open.pos,
            open.end - open.pos
          );
        }
        this.groupByName.set(name, index);
      }
      // 入栈：该组闭合之前出现的反向引用可以检测“自引用/前向引用”
      this.openGroups.push({ index, name });
    }
    const body = this.parseAlternation(true);
    const close = this.peek();
    if (!close || close.kind !== 'rparen') {
      throw new RegexSyntaxError(
        `${open.name ? `命名捕获组 (?<${open.name}>...)` : open.capture ? '捕获组' : '非捕获组'}没有闭合：缺少右括号 )`,
        open.pos,
        open.end - open.pos
      );
    }
    this.next();
    if (open.capture) this.openGroups.pop();
    return makeNode('group', open.pos, close.end, {
      capture: open.capture,
      index,
      name,
      body,
    });
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
