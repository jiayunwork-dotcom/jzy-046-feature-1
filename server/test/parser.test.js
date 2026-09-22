// parser.test.js
// 覆盖：字面字符、字符类（区间/取反/预定义类）、量词（含 {n} {n,m}
// 与贪婪/懒惰）、捕获/非捕获组、选择分支、锚点、空正则，以及各类语法错误
// 的位置与原因。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern, RegexSyntaxError } from '../src/parser/parser.js';
import { contains } from '../src/charset.js';

test('字面字符与连接产生 concat', () => {
  const ast = parsePattern('abc');
  assert.equal(ast.type, 'pattern');
  assert.equal(ast.body.type, 'concat');
  assert.equal(ast.body.items.length, 3);
  assert.deepEqual(ast.body.items.map((n) => n.type), ['char', 'char', 'char']);
  // 源码区间
  assert.deepEqual([ast.body.items[0].pos, ast.body.items[0].end], [0, 1]);
  assert.deepEqual([ast.body.pos, ast.body.end], [0, 3]);
});

test('单个字符节点记录码点与单字符集', () => {
  const ast = parsePattern('A');
  assert.equal(ast.body.cp, 65);
  assert.deepEqual(ast.body.set, [[65, 66]]);
});

test('预定义类 \\d \\w \\s 与大写取反', () => {
  const d = parsePattern('\\d').body;
  assert.equal(d.type, 'charClass');
  assert.equal(d.builtin, 'd');
  assert.equal(d.negated, false);
  const D = parsePattern('\\D').body;
  assert.equal(D.negated, true);
  for (const c of ['w', 's']) {
    assert.equal(parsePattern(`\\${c}`).body.builtin, c);
    assert.equal(parsePattern(`\\${c.toUpperCase()}`).body.negated, true);
  }
});

test('字符类支持区间与并集', () => {
  const cls = parsePattern('[a-cx]').body;
  assert.equal(cls.type, 'charClass');
  // 区间 a..c + 字面 x
  assert.ok(cls.set.some(([lo, hi]) => lo === 0x61 && hi === 0x64));
  assert.ok(cls.set.some(([lo, hi]) => lo === 0x78 && hi === 0x79));
});

test('取反字符类 [^0-9] 不包含数字、包含字母', () => {
  const cls = parsePattern('[^0-9]').body;
  assert.equal(contains(cls.set, 0x35), false);
  assert.equal(contains(cls.set, 0x61), true);
  assert.equal(cls.negated, true);
});

test('点号被识别为取换行类', () => {
  const dot = parsePattern('.').body;
  assert.equal(dot.dot, true);
});

test('量词 * + ? {n} {n,} {n,m}', () => {
  const star = parsePattern('a*').body;
  assert.equal(star.type, 'repeat');
  assert.equal(star.min, 0);
  assert.equal(star.max, Infinity);
  assert.equal(star.greedy, true);

  const plus = parsePattern('a+').body;
  assert.equal(plus.min, 1);
  assert.equal(plus.max, Infinity);

  const q = parsePattern('a?').body;
  assert.equal(q.min, 0);
  assert.equal(q.max, 1);

  const n = parsePattern('a{3}').body;
  assert.equal(n.min, 3);
  assert.equal(n.max, 3);

  const range = parsePattern('a{2,5}').body;
  assert.equal(range.min, 2);
  assert.equal(range.max, 5);

  const open = parsePattern('a{2,}').body;
  assert.equal(open.min, 2);
  assert.equal(open.max, Infinity);
});

test('贪婪与懒惰标记', () => {
  assert.equal(parsePattern('a+').body.greedy, true);
  assert.equal(parsePattern('a+?').body.greedy, false);
  assert.equal(parsePattern('a{2,4}?').body.greedy, false);
});

test('捕获组编号与非捕获组', () => {
  const ast = parsePattern('(a)(?:b)(c)');
  assert.equal(ast.groupCount, 2);
  const items = ast.body.items;
  assert.equal(items[0].capture, true);
  assert.equal(items[0].index, 1);
  assert.equal(items[1].capture, false);
  assert.equal(items[2].index, 2);
});

test('选择分支', () => {
  const alt = parsePattern('ab|cd').body;
  assert.equal(alt.type, 'alternation');
  assert.equal(alt.branches.length, 2);
  const tri = parsePattern('a|b|c').body;
  assert.equal(tri.branches.length, 3);
});

test('锚点 ^ 与 $', () => {
  const s = parsePattern('^a').body;
  assert.equal(s.items[0].type, 'anchor');
  assert.equal(s.items[0].dir, 'start');
  const e = parsePattern('a$').body;
  assert.equal(e.items[1].dir, 'end');
});

test('空正则与空分支合法（ε）', () => {
  assert.equal(parsePattern('').body.type, 'epsilon');
  const alt = parsePattern('a|').body;
  assert.equal(alt.type, 'alternation');
  assert.equal(alt.branches[1].type, 'epsilon');
  assert.equal(parsePattern('()').body.body.type, 'epsilon');
});

test('转义标点按字面处理', () => {
  const ast = parsePattern('\\.\\+\\?');
  assert.deepEqual(ast.body.items.map((n) => n.cp), [0x2e, 0x2b, 0x3f]);
});

test('错误：括号未闭合并定位在左括号', () => {
  assertError('(a', /没有闭合/, 0);
  assertError('(a(b)', /没有闭合/, 0);
});

test('错误：多余右括号', () => {
  assertError('a)', /多余的右括号/, 1);
});

test('错误：字符类未闭合定位在左括号', () => {
  assertError('[a-z', /字符类没有闭合/, 0);
});

test('错误：量词范围非法 {3,2} 定位在量词上', () => {
  assertError('a{3,2}', /量词范围非法/, 1);
  assertError('x{5,2}', /min ≤ max/, 1);
});

test('错误：区间顺序颠倒', () => {
  assertError('[z-a]', /顺序颠倒/, 1);
});

test('错误：量词前无对象', () => {
  assertError('+a', /没有可重复的对象/, 0);
  assertError('*x', /没有可重复的对象/, 0);
});

test('错误：未知转义', () => {
  assertError('\\q', /未知的转义/, 0);
});

test('错误：不支持的单词边界', () => {
  assertError('a\\b', /单词边界/, 1);
});

test('错误：末尾孤立反斜杠', () => {
  assertError('abc\\', /转义字符不完整/, 3);
});

test('不构成量词的花括号按字面处理', () => {
  const ast = parsePattern('a{,2}');
  assert.equal(ast.body.items[0].type, 'char'); // a
  assert.equal(ast.body.items[1].cp, 0x7b); // {
});

function assertError(src, msgRe, position) {
  assert.throws(
    () => parsePattern(src),
    (err) => err instanceof RegexSyntaxError && msgRe.test(err.message) && err.position === position,
    `expected error ${msgRe} at ${position} for ${src}`
  );
}
