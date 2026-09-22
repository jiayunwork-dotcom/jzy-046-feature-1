// api.test.js
// 端到端 HTTP 接口测试：用 Express app 在随机端口起服务，走真实 fetch。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}
async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
}

test('GET /api/health 返回版本与上限', async () => {
  const { status, json } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(json.node, /^v20\./);
  assert.equal(json.limits.dfa, 256);
});

test('POST /api/parse 成功返回 AST', async () => {
  const { status, json } = await post('/api/parse', { pattern: 'a+' });
  assert.equal(status, 200);
  assert.equal(json.ast.type, 'pattern');
  assert.equal(json.ast.body.type, 'repeat');
});

test('POST /api/parse 语法错误带位置', async () => {
  const { status, json } = await post('/api/parse', { pattern: '(a' });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error.position, 0);
  assert.match(json.error.message, /闭合/);
});

test('POST /api/compile 返回三套图与一致性自检', async () => {
  const { json } = await post('/api/compile', { pattern: 'a(b|c)*', verifyStrings: ['a', 'ab'] });
  assert.equal(json.ok, true);
  assert.ok(json.nfa.states.length > 0);
  assert.ok(json.dfa.states.length > 0);
  assert.ok(json.minDFA.afterCount <= json.minDFA.beforeCount);
  assert.equal(json.verification.allConsistent, true);
});

test('POST /api/match 三种引擎结论一致', async () => {
  for (const engine of ['backtracking', 'nfa', 'dfa', 'minDFA']) {
    const { json } = await post('/api/match', { pattern: '\\d+', input: 'ab123cd', engine, mode: 'greedy' });
    assert.equal(json.ok, true);
    assert.equal(json.matched, true);
    assert.deepEqual([json.result.start, json.result.end], [2, 5]);
    assert.ok(json.frames.length > 0);
    assert.ok(json.metrics.transitions >= 0);
  }
});

test('POST /api/match 回溯引擎含回溯帧与指标', async () => {
  const { json } = await post('/api/match', { pattern: '(a+)+b', input: 'aaa!', engine: 'backtracking' });
  assert.equal(json.matched, false);
  assert.ok(json.metrics.backtracks > 0);
  assert.ok(json.frames.some((f) => f.kind === 'backtrack'));
});

test('POST /api/compare-modes 贪婪长、懒惰短', async () => {
  const { json } = await post('/api/compare-modes', { pattern: '<.+?>', input: '<b>x</b>' });
  assert.equal(json.greedy.result.end, 8);
  assert.equal(json.lazy.result.end, 3);
});

test('POST /api/analyze 报告 (a+)+ 危险', async () => {
  const { json } = await post('/api/analyze', { pattern: '(a+)+b' });
  assert.equal(json.analysis.dangerous, true);
  assert.ok(['exponential', 'quadratic-or-worse'].includes(json.analysis.classification));
});

test('GET /api/examples 与详情', async () => {
  const list = await get('/api/examples');
  assert.ok(list.json.examples.length >= 5);
  const ids = list.json.examples.map((e) => e.id);
  assert.ok(ids.includes('email') && ids.includes('catastrophic'));
  const one = await get('/api/examples/email');
  assert.equal(one.json.example.id, 'email');
  assert.ok(one.json.example.sections.length >= 2);
});

test('静态资源：根路径返回前端 HTML', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<div id="root">/);
  // SPA 回退
  const res2 = await fetch(`${base}/some/client/route`);
  assert.equal(res2.status, 200);
});
