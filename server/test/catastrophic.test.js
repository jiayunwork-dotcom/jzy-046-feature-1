// catastrophic.test.js
// 灾难性回溯：静态结构识别 + 经验探针增长分级。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../src/parser/parser.js';
import { staticAnalyze, empiricalProbe, analyzePattern } from '../src/analysis/catastrophic.js';

test('静态识别 (a+)+ 嵌套无界量词', () => {
  const ast = parsePattern('(a+)+b');
  const r = staticAnalyze(ast, '(a+)+b');
  assert.equal(r.dangerous, true);
  assert.ok(r.warnings.some((w) => w.kind === 'nested-unbounded' && w.severity === 'exponential'));
});

test('静态识别 (a*)* 、 (\\d+)+', () => {
  for (const p of ['(a*)*', '(\\d+)+', '(\\w+)*x']) {
    const r = staticAnalyze(parsePattern(p), p);
    assert.ok(r.warnings.some((w) => w.kind === 'nested-unbounded'), p);
  }
});

test('静态识别量词内重叠分支 (a|aa)+', () => {
  const p = '(a|aa)+';
  const r = staticAnalyze(parsePattern(p), p);
  assert.ok(r.warnings.some((w) => w.kind === 'overlapping-alt' && w.severity === 'exponential'));
});

test('静态识别相邻重叠无界量词 a*a*', () => {
  const p = 'a*a*';
  const r = staticAnalyze(parsePattern(p), p);
  assert.ok(r.warnings.some((w) => w.kind === 'adjacent-unbounded'));
});

test('安全结构不报警：abc、\\d+-\\d+、a+b', () => {
  for (const p of ['abc', '\\d+-\\d+', 'a+b', '[a-z]+@[a-z]+']) {
    const r = staticAnalyze(parsePattern(p), p);
    assert.equal(r.warnings.filter((w) => w.severity === 'exponential').length, 0, p);
  }
});

test('警告带源码位置，前端可定位到片段', () => {
  const p = 'x(a+)+y';
  const r = staticAnalyze(parsePattern(p), p);
  const w = r.warnings.find((x) => x.kind === 'nested-unbounded');
  assert.ok(w.pos >= 1 && w.end <= p.length - 1);
});

test('经验探针：(a+)+b 步数随长度爆炸并判为 exponential', () => {
  const ast = parsePattern('(a+)+b');
  const r = empiricalProbe(ast, '(a+)+b', { lengths: [6, 9, 12, 15] });
  assert.equal(r.classification, 'exponential');
  // 步数单调快速增长，较大 n 处触及上限
  assert.ok(r.samples.at(-1).capped || r.samples.at(-1).attempts > 100000);
}, { timeout: 20000 });

test('经验探针：线性正则判为 linear-or-better', () => {
  const ast = parsePattern('a+b');
  const r = empiricalProbe(ast, 'a+b', { lengths: [10, 20, 40, 80] });
  assert.equal(r.classification, 'linear-or-better');
  // 步数应近似线性：80 个 a 的尝试次数不应离谱
  const last = r.samples.at(-1);
  assert.ok(last.attempts < last.length * 20);
});

test('分析报告带改写建议（针对嵌套量词与否定字符类）', () => {
  const r = analyzePattern(parsePattern('(a+)+b'), '(a+)+b');
  assert.ok(r.empirical.suggestion.length >= 2);
  const joined = r.empirical.suggestion.join(' ');
  assert.match(joined, /DFA|占有|a\+/);
});

test('平方级结构 (a|aa)*c 至少被静态或经验手段捕获', () => {
  const p = '(a|aa)*c';
  const r = analyzePattern(parsePattern(p), p);
  const caught =
    r.warnings.some((w) => w.severity === 'exponential') ||
    r.classification === 'exponential' ||
    r.classification === 'quadratic-or-worse';
  assert.ok(caught);
});
