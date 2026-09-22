// match-backtrack.test.js
// 匹配与回溯：帧序列合理性、贪婪/懒惰路径、回溯计数、捕获组、步数上限。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { matchBacktracking, BACKTRACK_STEP_CAP } from '../src/match/backtracker.js';
import { matchNFA } from '../src/match/nfa-sim.js';

test('成功匹配以 accept 帧收尾，失败以 attempt-fail/abort 收尾', () => {
  const c = compile('abc');
  const ok = matchBacktracking(c.nfa, 'xabc');
  assert.equal(ok.matched, true);
  assert.equal(ok.frames.at(-1).kind, 'accept');
  assert.deepEqual([ok.result.start, ok.result.end], [1, 4]);

  const no = matchBacktracking(c.nfa, 'abd');
  assert.equal(no.matched, false);
  assert.ok(no.frames.at(-1).kind === 'attempt-fail' || no.frames.at(-1).kind === 'abort');
});

test('回溯帧记录回退源与回退目标', () => {
  const c = compile('ab');
  const r = matchBacktracking(c.nfa, 'ac');
  const backs = r.frames.filter((f) => f.kind === 'backtrack');
  assert.ok(backs.length > 0, '失配输入必然产生回溯');
  for (const b of backs) {
    assert.ok(b.state !== undefined);
    assert.ok(b.backtrackToState === null || typeof b.backtrackToState === 'number');
  }
});

test('贪婪匹配取最长：<.+> 吃到最后一个 >', () => {
  const c = compile('<.+>');
  const r = matchBacktracking(c.nfa, '<b>x</b>', { mode: 'greedy' });
  assert.equal(r.result.end, 8);
  // 贪婪先冲到串尾，必然存在从接受点返回继续搜索的帧或回溯帧
  assert.ok(r.frames.some((f) => f.kind === 'return-from-accept' || f.kind === 'backtrack'));
});

test('懒惰匹配取最短：<.+?> 停在第一个 >', () => {
  const c = compile('<.+?>');
  const r = matchBacktracking(c.nfa, '<b>x</b>', { mode: 'lazy' });
  assert.equal(r.result.end, 3);
});

test('惰性 a*? 允许空匹配，a+? 至少一个', () => {
  assert.equal(matchBacktracking(compile('a*?').nfa, 'aaa', { mode: 'lazy' }).result.end, 0);
  assert.equal(matchBacktracking(compile('a+?').nfa, 'aaa', { mode: 'lazy' }).result.end, 1);
});

test('回溯次数为非负整数，失配输入通常 > 0', () => {
  const c = compile('a+b');
  const fail = matchBacktracking(c.nfa, 'aaa!');
  assert.ok(fail.metrics.backtracks > 0);
  const ok = matchBacktracking(c.nfa, 'aaab');
  assert.equal(ok.matched, true);
});

test('NFA 子集模拟 backtracks 恒为 0', () => {
  const c = compile('(a+)+b');
  const r = matchNFA(c.nfa, 'aaaa!');
  assert.equal(r.metrics.backtracks, 0);
  assert.equal(r.matched, false);
});

test('捕获组记录起止位置', () => {
  const c = compile('(\\d{4})-(\\d{2})-(\\d{2})');
  const r = matchBacktracking(c.nfa, '2026-09-20');
  assert.deepEqual(r.result.captures[1], { start: 0, end: 4 });
  assert.deepEqual(r.result.captures[2], { start: 5, end: 7 });
  assert.deepEqual(r.result.captures[3], { start: 8, end: 10 });
});

test('嵌套捕获组', () => {
  const c = compile('((a)b)+');
  const r = matchBacktracking(c.nfa, 'abab');
  assert.equal(r.matched, true);
  assert.deepEqual(r.result.captures[1], { start: 2, end: 4 });
  assert.deepEqual(r.result.captures[2], { start: 2, end: 3 });
});

test('灾难性输入触发步数上限并标记 capped', () => {
  const c = compile('(a+)+b');
  const r = matchBacktracking(c.nfa, 'a'.repeat(40) + '!', { stepCap: 5000 });
  assert.equal(r.metrics.capped, true);
  assert.match(r.metrics.abortReason, /上限/);
  assert.equal(r.matched, false);
  assert.ok(r.frames.some((f) => f.kind === 'abort'));
}, { timeout: 10000 });

test('默认上限足够大但危险结构长输入仍会被截断', () => {
  const c = compile('(a+)+b');
  const r = matchBacktracking(c.nfa, 'a'.repeat(30) + '!');
  assert.equal(r.metrics.capped, true);
  assert.ok(r.metrics.edgeAttempts >= BACKTRACK_STEP_CAP || r.metrics.capped);
}, { timeout: 15000 });

test('零宽环保护：a* 对空串不死循环', () => {
  const c = compile('a*');
  const r = matchBacktracking(c.nfa, '');
  assert.equal(r.matched, true);
  assert.deepEqual([r.result.start, r.result.end], [0, 0]);
});

test('锚点帧：^ 不成立时 anchor-fail，成立时 anchor-pass', () => {
  const c = compile('^a');
  // search 从位置 1 起尝试时，^ 在 pos=1 不成立
  const r = matchBacktracking(c.nfa, 'ba');
  assert.equal(r.matched, false);
  assert.ok(r.frames.some((f) => f.kind === 'anchor-fail'));
});

test('指标字段齐全', () => {
  const c = compile('\\w+');
  const r = matchBacktracking(c.nfa, 'hello');
  for (const k of ['transitions', 'edgeAttempts', 'backtracks', 'visitedStates', 'frameCount', 'inputLength']) {
    assert.ok(k in r.metrics, `缺少指标 ${k}`);
  }
  assert.equal(r.metrics.inputLength, 5);
});

test('帧数量受 FRAME_CAP 约束（超长危险输入不撑爆响应）', () => {
  const c = compile('(a+)+b');
  const r = matchBacktracking(c.nfa, 'a'.repeat(50) + '!', { stepCap: 200000 });
  assert.ok(r.frames.length <= 14000);
}, { timeout: 15000 });
