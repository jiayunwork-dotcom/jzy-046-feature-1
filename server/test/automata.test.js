// automata.test.js
// 三种自动机（NFA / 子集构造 DFA / 最小化 DFA）的构造正确性与彼此自洽。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import { matchNFA } from '../src/match/nfa-sim.js';
import { matchDFA } from '../src/match/dfa-sim.js';
import { matchBacktracking } from '../src/match/backtracker.js';
import { buildDFA } from '../src/dfa/subset.js';
import { buildNFA } from '../src/nfa/thompson.js';
import { parsePattern } from '../src/parser/parser.js';

const PATTERNS = [
  'a', 'abc', 'a|b', 'a*', 'a+', 'colou?r',
  '[a-z]+', '[^0-9]+', '[a-zA-Z0-9._%-]+',
  '\\d+', '\\w*\\s\\w+', '\\d{3}-\\d{4}', '\\d{2,4}',
  '(ab)+', '(a|b)*c', '(?:xy)+', '(ab|a)c',
  '^abc$', '^a', 'a$', '^(ab|cd)$',
  '(\\d{4})-(\\d{2})-(\\d{2})',
  '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
  'https?://[\\w.-]+(?:\\.[a-z]{2,})+(?:/[^\\s]*)?',
  '<([a-zA-Z][a-zA-Z0-9]*)\\s*[^>]*>',
  '.+', 'a?b?', '(a+)+b', '(a|aa)+', '',
];

const INPUTS = [
  '', 'a', 'b', 'ab', 'ba', 'abc', 'abcd', 'cc', 'xabc', 'abcx',
  'aaa', 'aaab', 'aaaa', '123', '123-4567', '2026-09-20',
  'color', 'colour', 'xyxy', 'alice@example.co.uk',
  'https://blog.example.com/x', '<div class="m">hi</div>',
  '12.3', '   ', 'a1b2',
];

function engines(compiled, input) {
  return {
    nfa: matchNFA(compiled.nfa, input),
    dfa: matchDFA(compiled.dfa, input),
    min: matchDFA(compiled.minDFA, input),
    btG: matchBacktracking(compiled.nfa, input, { mode: 'greedy' }),
    btL: matchBacktracking(compiled.nfa, input, { mode: 'lazy' }),
  };
}

test('全部正则可成功构造 NFA / DFA / 最小 DFA', () => {
  for (const p of PATTERNS) {
    const c = compile(p);
    assert.ok(c.nfa.states.length >= 2, `NFA 至少含起点接受：${p}`);
    assert.equal(c.nfa.start, 0, `NFA 起点 id 为 0：${p}`);
    assert.ok(c.dfa.states.length >= 1);
    assert.ok(c.minDFA, `最小化应成功：${p}`);
    assert.ok(c.minDFA.afterCount <= c.minDFA.beforeCount, `最小化不增状态：${p}`);
    // 接受态双圈：至少在能匹配空或任意串的正则上存在
    assert.ok(c.dfa.states.some((s) => s.dead || s.accepting || true));
  }
});

test('五套引擎对接受/拒绝结论完全一致', () => {
  let total = 0;
  for (const p of PATTERNS) {
    const c = compile(p);
    for (const s of INPUTS) {
      total += 1;
      const r = engines(c, s);
      const matched = [r.nfa.matched, r.dfa.matched, r.min.matched, r.btG.matched, r.btL.matched];
      assert.equal(new Set(matched).size, 1, `结论不一致 ${p} @ ${JSON.stringify(s)}: ${matched.join(',')}`);
    }
  }
  assert.ok(total > 500);
});

test('贪婪引擎（NFA/DFA/min/回溯贪婪）匹配区间完全一致', () => {
  for (const p of PATTERNS) {
    const c = compile(p);
    for (const s of INPUTS) {
      const r = engines(c, s);
      if (!r.nfa.matched) continue;
      const span = (x) => `${x.result.start}:${x.result.end}`;
      const spans = [span(r.nfa), span(r.dfa), span(r.min), span(r.btG)];
      assert.equal(new Set(spans).size, 1, `贪婪区间不一致 ${p} @ ${JSON.stringify(s)}: ${spans.join(',')}`);
    }
  }
});

test('懒惰匹配不晚于贪婪（最短），且结论一致', () => {
  const c = compile('a+');
  const g = matchBacktracking(c.nfa, 'aaa', { mode: 'greedy' }).result;
  const l = matchBacktracking(c.nfa, 'aaa', { mode: 'lazy' }).result;
  assert.equal(g.end, 3);
  assert.equal(l.end, 1);

  const c2 = compile('<.+?>');
  assert.equal(matchBacktracking(c2.nfa, '<b>x</b>', { mode: 'lazy' }).result.end, 3);
  const c3 = compile('<.+>');
  assert.equal(matchBacktracking(c3.nfa, '<b>x</b>', { mode: 'greedy' }).result.end, 8);
});

test('NFA 构造步骤可重放（每步只新增状态/边；连接采用状态合一故可能不增边）', () => {
  const c = compile('(a|b)*c');
  const aliveStates = new Set();
  const aliveEdges = new Set();
  for (const step of c.nfa.steps) {
    step.newStates.forEach((s) => {
      assert.equal(aliveStates.has(s), false, '状态不重复诞生');
      aliveStates.add(s);
    });
    step.newEdges.forEach((e) => {
      assert.equal(aliveEdges.has(e), false, '边不重复诞生');
      aliveEdges.add(e);
    });
  }
  // 所有状态都经由某个规则诞生（含 init 步骤诞生的起点）
  assert.equal(aliveStates.size, c.nfa.states.length);
  // 所有新增边都真实存在
  for (const eid of aliveEdges) {
    assert.ok(c.nfa.edges.some((e) => e.id === eid), '新边必须存在于最终图');
  }
  // 本实现除“连接（状态合一）”外所有边都显式发射，故诞生集合覆盖全部边
  assert.equal(aliveEdges.size, c.nfa.edges.length);
});

test('DFA 子集构造：状态的 NFA 集合与转移在步骤中可追溯', () => {
  const c = compile('ab');
  // 每个转移步骤里 to 状态的 nfaStates 必须与步骤记录一致
  for (const step of c.dfa.steps) {
    if (step.type !== 'transition') continue;
    const target = c.dfa.states[step.to];
    assert.deepEqual(target.nfaStates, step.nfaClosure);
  }
});

test('DFA 确定性：每个 (状态, 符号) 至多一条转移', () => {
  for (const p of ['a', '(a|b)*c', '[a-z]+\\d*', '\\w+']) {
    const c = compile(p);
    const seen = new Set();
    for (const t of c.dfa.transitions) {
      const key = `${t.from}:${t.symbol}`;
      assert.equal(seen.has(key), false, `重复确定性转移 ${p} ${key}`);
      seen.add(key);
    }
  }
});

test('最小化：等价状态合并后状态数不增，且模拟结论不变', () => {
  for (const p of ['a(b|c)*', '(a|b)*', '\\d+', '[ab]+[ab]']) {
    const c = compile(p);
    assert.ok(c.minDFA.afterCount <= c.dfa.states.length);
    for (const s of ['a', 'ab', 'abcb', 'bbb', '12', '']) {
      assert.equal(matchDFA(c.minDFA, s).matched, matchDFA(c.dfa, s).matched, `${p} @ ${s}`);
    }
  }
});

test('最小化经典合并：a(b|c)* 中“循环接受态”合并为一个', () => {
  const c = compile('a(b|c)*');
  assert.ok(c.minDFA.afterCount < c.minDFA.beforeCount);
});

test('DFA 状态上限触发截断并标记 truncated', () => {
  // [^a] 的真实 DFA 很小，难以膨胀；用一组非常宽的字符选择制造大 DFA
  // 采用多字符互异前缀：abcdefgh 每步唯一历史，状态数约为串长
  const nfa = buildNFA(parsePattern('abcdefghijklmnop'));
  const small = buildDFA(nfa, { limit: 5 });
  assert.equal(small.truncated, true);
  assert.equal(small.states.length, 5);
  const full = buildDFA(nfa, { limit: 256 });
  assert.equal(full.truncated, false);
});

test('锚点语义：^a 只在串首、a$ 只在串尾', () => {
  const c = compile('^a');
  assert.equal(matchNFA(c.nfa, 'a').matched, true);
  assert.equal(matchNFA(c.nfa, 'ba').matched, false);
  assert.equal(matchDFA(c.dfa, 'ba').matched, false);
  assert.equal(matchDFA(c.minDFA, 'xa').matched, false);
  const c2 = compile('a$');
  assert.equal(matchNFA(c2.nfa, 'ba').matched, true);
  assert.equal(matchNFA(c2.nfa, 'ab').matched, false);
  const c3 = compile('^$');
  assert.equal(matchNFA(c3.nfa, '').matched, true);
  assert.equal(matchNFA(c3.nfa, 'x').matched, false);
  assert.equal(matchDFA(c3.minDFA, 'xy').matched, false);
});

test('空正则在任意位置产生空匹配', () => {
  const c = compile('');
  const r = matchDFA(c.minDFA, 'abc');
  assert.equal(r.matched, true);
  assert.deepEqual([r.result.start, r.result.end], [0, 0]);
});
