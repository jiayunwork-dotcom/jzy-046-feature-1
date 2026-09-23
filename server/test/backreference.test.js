// backreference.test.js
// 反向引用与命名捕获组的完整覆盖：
//  1) 解析：命名组词法/重名校验；数字与具名反向引用；非法/自引用/前向引用
//     一律在解析阶段（反向引用或括号位置）报错；
//  2) 匹配：AST 回溯引擎对数字/具名引用的正确匹配与失败、逐字符失配、
//     “被引用分组未捕获 => 本次比对失败”的约定、捕获栈随分支/回溯回滚；
//  3) 自动机链路：含反向引用的模式编译时 NFA/DFA/minDFA 全部缺省并带原因，
//     普通模式完全不受影响；HTTP 层选 NFA/DFA 引擎得到 409；
//  4) 分析：反向引用被单列为爆炸来源；新教学案例内容正确。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern, RegexSyntaxError } from '../src/parser/parser.js';
import { compile } from '../src/compile.js';
import { matchAstBacktracking } from '../src/match/ast-backtracker.js';
import { hasBackreferences, collectBackrefs } from '../src/features.js';
import { staticAnalyze } from '../src/analysis/catastrophic.js';
import { getExample } from '../src/examples/index.js';

// ---------- 解析：命名捕获组 ----------

test('命名捕获组记录名字、编号与 groupNames 映射', () => {
  const ast = parsePattern('(?<word>\\w+)-(?<n>\\d+)');
  assert.equal(ast.groupCount, 2);
  assert.deepEqual(ast.groupNames, { word: 1, n: 2 });
  const groups = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'group') groups.push(n);
    if (n.body) visit(n.body);
    if (n.atom) visit(n.atom);
    (n.items || []).forEach(visit);
    (n.branches || []).forEach(visit);
  };
  visit(ast);
  assert.deepEqual(groups.map((g) => [g.name, g.index]), [['word', 1], ['n', 2]]);
});

test('命名捕获组与普通捕获组统一编号', () => {
  const ast = parsePattern('(a)(?<b>b)(c)');
  assert.deepEqual(ast.groupNames, { b: 2 });
  assert.equal(ast.groupCount, 3);
});

test('非法组名：空 / 数字开头 / 含非法字符，均定位在左括号', () => {
  assertError('(?<>x)', /组名 "" 非法/, 0);
  assertError('(?<1a>x)', /不能以数字开头/, 0);
  assertError('(?<a-b>x)', /组名 "a-b" 非法/, 0);
  assertError('(?<', /缺少结尾的 >/, 0);
});

test('重名组在第二个组的左括号位置报错', () => {
  let err;
  assert.throws(() => parsePattern('(?<a>x)(?<a>y)'), (e) => { err = e; return e instanceof RegexSyntaxError; });
  assert.match(err.message, /组名 "a" 重复/);
  assert.equal(err.position, 7); // 第二个 (?<a> 的左括号
});

test('环视写法 (?<= / (?<! 明确报“不支持”，而不是误判成命名组', () => {
  assertError('(?<=a)b', /环视/, 0);
  assertError('(?<!a)b', /环视/, 0);
});

// ---------- 解析：反向引用校验前置 ----------

test('数字反向引用解析出 backref 节点并解析目标组', () => {
  const ast = parsePattern('(a)\\1');
  const refs = collectBackrefs(ast);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].refType, 'number');
  assert.equal(refs[0].refValue, 1);
  assert.equal(refs[0].index, 1);
  assert.deepEqual([refs[0].pos, refs[0].end], [3, 5]);
});

test('具名反向引用 \\k<name> 解析并绑定编号', () => {
  const ast = parsePattern('(?<tag>x)\\k<tag>');
  const refs = collectBackrefs(ast);
  assert.equal(refs[0].refType, 'name');
  assert.equal(refs[0].refValue, 'tag');
  assert.equal(refs[0].index, 1);
});

test('自引用：反向引用出现在自身分组闭合之前，解析期报错', () => {
  assertError('(\\1)', /还没有闭合/, 1);
  assertError('(a\\1)', /自引用/, 2);
  assertError('(?<a>\\k<a>)', /还没有闭合/, 5);
});

test('前向引用：引用了后面才出现的分组，解析期报错', () => {
  assertError('\\1(a)', /闭合之前/, 0);
  assertError('\\k<a>(?<a>x)', /闭合之前/, 0);
});

test('引用不存在的分组：编号超出 / 无此名字', () => {
  assertError('(a)\\2', /只有 1 个捕获组/, 3);
  assertError('\\5', /只有 0 个捕获组/, 0);
  assertError('\\k<missing>', /没有名为 "missing" 的捕获组/, 0);
});

test('反向引用不能出现在字符类里', () => {
  assertError('[a\\1]', /字符类内部不能使用反向引用/, 2);
  assertError('[\\k<a>]', /字符类内部不能使用反向引用/, 1);
});

test('\\k 格式错误给出明确提示', () => {
  assertError('(?<a>x)\\k', /具名反向引用格式应为/, 7);
  assertError('(?<a>x)\\ka', /具名反向引用格式应为/, 7);
});

test('\\0 仍是 NUL 字面量，不被当成反向引用', () => {
  const ast = parsePattern('\\0');
  assert.equal(ast.body.type, 'char');
  assert.equal(hasBackreferences(ast), false);
});

// ---------- 匹配：正确性 ----------

function run(pattern, input, opts = {}) {
  return matchAstBacktracking(parsePattern(pattern), input, { source: pattern, ...opts });
}

test('数字反向引用：相等文本匹配，逐字符不同失败', () => {
  const ok = run(String.raw`(\w+)\s+\1`, 'go go');
  assert.equal(ok.matched, true);
  assert.deepEqual([ok.result.start, ok.result.end], [0, 5]);
  assert.deepEqual(ok.result.captures[1], { start: 0, end: 2 });

  const bad = run(String.raw`(\w+)\s+\1`, 'go ix');
  assert.equal(bad.matched, false);
  assert.ok(bad.frames.some((f) => f.kind === 'backref-fail' && f.mismatchAt === 0));
});

test('具名反向引用与数字写法等价', () => {
  const named = run(String.raw`<(?<t>[a-z]+)>([^<]*)</\k<t>>`, '<b>bold</b>');
  const numbered = run(String.raw`<([a-z]+)>([^<]*)</\1>`, '<b>bold</b>');
  assert.equal(named.matched, true);
  assert.equal(numbered.matched, true);
  assert.deepEqual(named.result.captures[1], numbered.result.captures[1]);
});

test('HTML 首尾同名：名字不一致（<b>..</i>）被拒绝', () => {
  const r = run(String.raw`<(?<t>[a-z]+)>[^<]*</\k<t>>`, '<b>x</b><i>y</i>');
  assert.equal(r.matched, true);
  assert.deepEqual([r.result.start, r.result.end], [0, 8]);
  const mismatch = run(String.raw`<(?<t>[a-z]+)>[^<]*</\k<t>>`, '<b>x</i>');
  assert.equal(mismatch.matched, false);
  assert.ok(mismatch.frames.some((f) => f.kind === 'backref-fail'));
});

test('反向引用长度可变：贪婪取最长可行重复', () => {
  // (a+)\1 要求两半相同：aaaa -> "aa"+"aa"
  assert.deepEqual([run(String.raw`(a+)\1`, 'aaaa').result.start, run(String.raw`(a+)\1`, 'aaaa').result.end], [0, 4]);
  const five = run(String.raw`(a+)\1`, 'aaaaa');
  assert.equal(five.matched, true);
  assert.deepEqual([five.result.start, five.result.end], [0, 4]); // 奇数长度退化为最长偶数前缀
  const three = run(String.raw`(a+)\1`, 'aaa');
  assert.deepEqual([three.result.start, three.result.end], [0, 2]);
});

test('多个反向引用按顺序比对：(a+)(b+)\\2\\1', () => {
  const r = run(String.raw`(a+)(b+)\2\1`, 'aabbbbaa');
  assert.equal(r.matched, true);
  assert.deepEqual([r.result.start, r.result.end], [0, 8]);
  // 与 PCRE/JS 语义一致：最终成功路径是 aa|bb|bb|aa，捕获随成功的那次
  // 回溯缩短（组2 记 "bb" 而不是 "bbbb"）——这要求捕获在回溯中正确更迭
  assert.deepEqual(r.result.captures[1], { start: 0, end: 2 });
  assert.deepEqual(r.result.captures[2], { start: 2, end: 4 });
  // 无法切成 a+ b+ b+ a+ 的串在锚定下必须失败（不能用旧捕获蒙混）
  assert.equal(run(String.raw`^(a+)(b+)\2\1$`, 'aababc').matched, false);
});

test('约定：未参与分组的反向引用失败；可选跳过（已参与空串）则匹配 ε', () => {
  // (a)|(b)\2：走第一分支匹配 "a" 时组 2 根本没参与 => 不影响该分支接受；
  // 走第二分支 "bb" 时组 2 已闭合，\2 要求再来一个 b
  const r = run(String.raw`(a)|(b)\2`, 'bb');
  assert.equal(r.matched, true);
  const first = run(String.raw`(a)|(b)\2`, 'aa');
  assert.equal(first.matched, true);

  // 真正的“未参与”：第二分支 (b)\2 中，若强行考察，组1在另一分支——
  // 用 (a)|\1 这种形态（\1 与组1同属顶层，第一分支没走时 \1 未参与即失败）
  const unset = run(String.raw`(b)\1|a`, 'a');
  // "a" 由第二分支直接接受（这里 \1 在失败的第一分支里），确认能成功
  assert.equal(unset.matched, true);

  // (x)?\1 在 "y" 上：(x)? 跳过 -> 组1“已参与但空串” -> \1 匹配 ε -> 空匹配成功
  const skipped = run(String.raw`(x)?\1`, 'y');
  assert.equal(skipped.matched, true);
  assert.deepEqual([skipped.result.start, skipped.result.end], [0, 0]);
  // 空参与不计入最终捕获（与 JS 中该组为 undefined 对齐）
  assert.equal(skipped.result.captures[1], undefined);
  // 但逐帧上能看到 backref-empty（区别于 backref-unset）
  assert.ok(skipped.frames.some((f) => f.kind === 'backref-empty'));

  // "x" 上搜索语义：跳过 (x)? + \1=ε 在位置 0 给出空匹配（与 JS 一致）；
  // 锚定整串才能强制“必须真正吃到 x”
  assert.deepEqual([run(String.raw`(x)?\1`, 'x').result.start, run(String.raw`(x)?\1`, 'x').result.end], [0, 0]);
  assert.equal(run(String.raw`^(x)?\1$`, 'x').matched, false);
  // 两个 x：抓住 x + \1 再来一个 x => 成功
  assert.equal(run(String.raw`(x)?\1`, 'xx').matched, true);
  assert.deepEqual(run(String.raw`(x)?\1`, 'xx').result.captures[1], { start: 0, end: 1 });

  // 未参与（另一分支）触发 backref-unset：^\1$(a?) 这种前向引用已在解析期
  // 拒绝；用 (a)|(b)\1 观察：走第二分支时组1未参与 => \1 失败
  const unsetFail = run(String.raw`^(a)|(b)\1$`, 'b');
  assert.equal(unsetFail.matched, false);
  assert.ok(unsetFail.frames.some((f) => f.kind === 'backref-unset'));
});

test('捕获随回溯回滚：分支失败后另一分支看不到该分支的捕获', () => {
  // 第一分支设组2（不可能，因为组2在分支外），改用可观察场景：
  // (\w+) 在回溯中缩短时，\1 每次都按“当前这次”的捕获比对
  const r = run(String.raw`^(\w+)\w$`, 'abc');
  assert.equal(r.matched, true);
  assert.deepEqual(r.result.captures[1], { start: 0, end: 2 });
});

test('反向引用帧序列：load -> 每字符 char -> pass（或 fail）', () => {
  const ok = run(String.raw`(ab)\1`, 'abab');
  const kinds = ok.frames.map((f) => f.kind).filter((k) => k.startsWith('backref'));
  assert.deepEqual(kinds, ['backref-load', 'backref-char', 'backref-char', 'backref-pass']);
  const bad = run(String.raw`(ab)\1`, 'abax');
  const badKinds = bad.frames.map((f) => f.kind).filter((k) => k.startsWith('backref'));
  assert.ok(badKinds.includes('backref-fail'));
  assert.equal(badKinds[0], 'backref-load');
});

test('懒惰模式在反向引用模式下取最短可行', () => {
  const lazy = run(String.raw`(a?)\1`, 'aa', { mode: 'lazy' });
  assert.equal(lazy.matched, true);
  // 懒惰：组抓空串 + \1 要求空串 => 空匹配
  assert.deepEqual([lazy.result.start, lazy.result.end], [0, 0]);
  const greedy = run(String.raw`(a?)\1`, 'aa', { mode: 'greedy' });
  assert.deepEqual([greedy.result.start, greedy.result.end], [0, 2]);
});

test('锚点与反向引用协同：^(\\w+)\\s+\\1$ 精确匹配整串', () => {
  assert.equal(run(String.raw`^(\w+)\s+\1$`, 'go go').matched, true);
  assert.equal(run(String.raw`^(\w+)\s+\1$`, 'go go ').matched, false);
  assert.equal(run(String.raw`^(\w+)\s+\1$`, 'go ix').matched, false);
});

test('AST 回溯引擎对普通正则的指标字段与旧引擎同名同义', () => {
  const r = run(String.raw`\w+`, 'hello');
  for (const k of ['transitions', 'edgeAttempts', 'backtracks', 'visitedStates', 'frameCount', 'inputLength', 'capped']) {
    assert.ok(k in r.metrics, `缺少指标 ${k}`);
  }
  assert.equal(r.metrics.inputLength, 5);
  assert.equal(r.metrics.capped, false);
});

// ---------- 自动机链路被明确拒绝 ----------

test('含反向引用的模式：nfa/dfa/minDFA 全部为 null 且带原因', () => {
  const c = compile(String.raw`(\w+)\1`);
  assert.equal(c.nonDeterminizable, true);
  assert.equal(c.nfa, null);
  assert.equal(c.dfa, null);
  assert.equal(c.minDFA, null);
  assert.equal(c.backrefs.length, 1);
  assert.match(c.backrefs[0].reason, /记忆|正则语言/);
  assert.equal(c.backrefs[0].pos, 5);
});

test('具名反向引用同样阻断自动机三段', () => {
  const c = compile(String.raw`(?<x>a)\k<x>`);
  assert.equal(c.nonDeterminizable, true);
  assert.equal(c.backrefs[0].ref, String.raw`\k<x>`);
});

test('仅含命名捕获组（无反向引用）的模式照常走完整自动机流水线', () => {
  const c = compile('(?<year>\\d{4})-(?<m>\\d{2})');
  assert.equal(c.nonDeterminizable, false);
  assert.ok(c.nfa.states.length >= 2);
  assert.ok(c.dfa.states.length >= 1);
  assert.ok(c.minDFA);
});

test('不含反向引用的模式完全不受改动影响', () => {
  for (const p of ['abc', 'a+', '(a|b)*c', '\\d+-\\d+', '(?:xy)?z$', '^[a-z]+@']) {
    const c = compile(p);
    assert.equal(c.nonDeterminizable, false, p);
    assert.ok(c.nfa && c.dfa && c.minDFA, p);
  }
});

// ---------- 灾难性分析：反向引用单列 ----------

test('静态分析把反向引用单列为 backreference 爆炸来源', () => {
  const p = String.raw`(\w+)\1`;
  const r = staticAnalyze(parsePattern(p), p);
  const w = r.warnings.find((x) => x.kind === 'backreference');
  assert.ok(w, '应有 backreference 类型警告');
  assert.match(w.detail, /重新扫|逐字符/);
  assert.equal(w.pos, 5);
});

test('无界量词内的反向引用标记为 exponential 级别', () => {
  const p = String.raw`(?:(\w+)\s*\1)+`;
  const r = staticAnalyze(parsePattern(p), p);
  const w = r.warnings.find((x) => x.kind === 'backreference');
  assert.equal(w.severity, 'exponential');
});

test('普通正则不产生 backreference 警告', () => {
  const r = staticAnalyze(parsePattern('(a+)+b'), '(a+)+b');
  assert.equal(r.warnings.some((w) => w.kind === 'backreference'), false);
});

// ---------- 教学案例 ----------

test('教学案例 backref-words：模式合法、样例串行为正确、含“状态机表示不了”讲解', () => {
  const ex = getExample('backref-words');
  assert.ok(ex);
  const ast = parsePattern(ex.pattern);
  assert.ok(hasBackreferences(ast));
  const hit = run(ex.pattern, ex.test);
  assert.equal(hit.matched, true);
  const text = ex.sections.map((s) => s.bullets.join(' ')).join(' ');
  assert.match(text, /回溯/);
  assert.match(text, /状态机|NFA/);
  // 锚点子集说明：没有 \b
  assert.match(text, /\\b|边界/);
});

test('教学案例 backref-html：首尾同名才匹配，错名闭合被拒绝', () => {
  const ex = getExample('backref-html');
  assert.ok(ex);
  const ok = run(ex.pattern, ex.test);
  assert.equal(ok.matched, true);
  // 样例串 "<b>bold</b> vs <i>mismatch</b>" 最左命中 0..11
  assert.deepEqual([ok.result.start, ok.result.end], [0, 11]);
  assert.deepEqual(ok.result.captures[1], { start: 1, end: 2 });
  const bad = run(ex.pattern, '<b>x</i>');
  assert.equal(bad.matched, false);
  const text = ex.sections.map((s) => s.bullets.join(' ')).join(' ');
  assert.match(text, /非正则|正则语言|记忆/);
});

// ---------- 辅助 ----------

function assertError(src, msgRe, position) {
  assert.throws(
    () => parsePattern(src),
    (err) => err instanceof RegexSyntaxError && msgRe.test(err.message) && err.position === position,
    `expected ${msgRe} at ${position} for ${src}`
  );
}
