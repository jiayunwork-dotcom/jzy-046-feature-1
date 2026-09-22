// api.js —— 前端与后端引擎的唯一通信层。前端展示的每一步都来自这些
// 接口返回的确定结果，不做任何本地引擎推导。

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, error: { message: '响应解析失败' } }));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error?.message || `请求失败：${res.status}`);
    err.payload = data.error || {};
    throw err;
  }
  return data;
}

async function get(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error?.message || `请求失败：${res.status}`);
  return data;
}

export const api = {
  parse: (pattern) => post('/api/parse', { pattern }),
  compile: (pattern, { dfaLimit, verifyStrings } = {}) =>
    post('/api/compile', { pattern, dfaLimit, verifyStrings }),
  match: (pattern, input, engine, mode) =>
    post('/api/match', { pattern, input, engine, mode }),
  compareModes: (pattern, input) => post('/api/compare-modes', { pattern, input }),
  analyze: (pattern) => post('/api/analyze', { pattern }),
  examples: () => get('/api/examples'),
  example: (id) => get(`/api/examples/${id}`),
};
