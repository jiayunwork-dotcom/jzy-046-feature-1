// app.js
// Express 应用：正则引擎全部接口 + 托管前端构建产物（单容器部署）。

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { parsePattern, RegexSyntaxError } from './parser/parser.js';
import { compile } from './compile.js';
import { buildNFA, NFA_STATE_LIMIT, ThompsonBuildError } from './nfa/thompson.js';
import { buildDFA, DEFAULT_DFA_LIMIT, SubsetBuildError } from './dfa/subset.js';
import { minimizeDFA } from './dfa/minimize.js';
import { matchBacktracking } from './match/backtracker.js';
import { matchAstBacktracking } from './match/ast-backtracker.js';
import { matchNFA } from './match/nfa-sim.js';
import { matchDFA } from './match/dfa-sim.js';
import { analyzePattern } from './analysis/catastrophic.js';
import { checkConsistency } from './consistency.js';
import { hasBackreferences } from './features.js';
import { EXAMPLES, listExamples, getExample } from './examples/index.js';

/** 引擎对当前模式不可用时抛出（例如拿 NFA 模拟含反向引用的模式） */
class EngineUnavailableError extends Error {
  constructor(message, { engine, reason }) {
    super(message);
    this.name = 'EngineUnavailableError';
    this.engine = engine;
    this.reason = reason;
    this.statusCode = 409;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(__dirname, '../public');

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const errorBody = (err) => ({
    ok: false,
    error: {
      message: err.message,
      position: err.position ?? null,
      length: err.length ?? 1,
      kind: err.name,
    },
  });

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof RegexSyntaxError || err instanceof ThompsonBuildError || err instanceof SubsetBuildError) {
        res.status(400).json(errorBody(err));
        return;
      }
      if (err instanceof EngineUnavailableError) {
        res.status(err.statusCode).json({
          ok: false,
          error: { message: err.message, kind: err.name, engine: err.engine, reason: err.reason },
        });
        return;
      }
      req.app.locals.logger?.(err);
      res.status(500).json({ ok: false, error: { message: err.message, kind: err.name } });
    }
  };

  // 健康检查
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, node: process.version, limits: { nfa: NFA_STATE_LIMIT, dfa: DEFAULT_DFA_LIMIT } });
  });

  // 仅解析：输入框实时调用
  app.post('/api/parse', wrap((req, res) => {
    const { pattern } = req.body;
    if (typeof pattern !== 'string') throw new RegexSyntaxError('pattern 必须是字符串', 0);
    const ast = parsePattern(pattern);
    res.json({ ok: true, ast, groupCount: ast.groupCount });
  }));

  // 全量编译：ast + nfa + dfa + minDFA + 一致性自检
  // 含反向引用时 nfa/dfa/minDFA 为 null，nonDeterminizable 说明原因
  app.post('/api/compile', wrap((req, res) => {
    const { pattern, dfaLimit = DEFAULT_DFA_LIMIT, verifyStrings } = req.body;
    if (typeof pattern !== 'string') throw new RegexSyntaxError('pattern 必须是字符串', 0);
    const compiled = compile(pattern, { dfaLimit: Math.min(Number(dfaLimit) || DEFAULT_DFA_LIMIT, 4096) });
    let verification = null;
    if (Array.isArray(verifyStrings)) {
      verification = checkConsistency(compiled, verifyStrings);
    }
    res.json({
      ok: true,
      ast: compiled.ast,
      nonDeterminizable: compiled.nonDeterminizable,
      backrefs: compiled.backrefs,
      nfa: compiled.nfa ? graphPayload('nfa', compiled.nfa) : null,
      dfa: compiled.dfa ? graphPayload('dfa', compiled.dfa) : null,
      minDFA: compiled.minDFA ? graphPayload('minDFA', compiled.minDFA) : null,
      dfaTruncated: compiled.dfa ? compiled.dfa.truncated : false,
      dfaTruncationDetail: compiled.dfa ? compiled.dfa.truncationDetail : null,
      minError: compiled.minError,
      verification,
    });
  }));

  // 匹配：engine = backtracking | nfa | dfa | minDFA
  // 含反向引用的模式只有 backtracking 可用，选择其余引擎返回 409 并说明原因
  app.post('/api/match', wrap((req, res) => {
    const { pattern, input = '', engine = 'nfa', mode = 'greedy' } = req.body;
    if (typeof pattern !== 'string') throw new RegexSyntaxError('pattern 必须是字符串', 0);
    const text = String(input);
    const ast = parsePattern(pattern);

    if (hasBackreferences(ast)) {
      if (engine !== 'backtracking') {
        throw new EngineUnavailableError(
          `引擎 ${engine} 对该正则不可用：模式含反向引用，反向引用不是正则语言，无法构造/模拟有限自动机，请改用回溯引擎`,
          {
            engine,
            reason: 'backreference-requires-memory',
          }
        );
      }
      const r = matchAstBacktracking(ast, text, { mode, source: pattern });
      res.json({ ok: true, ...stripFramesForTransport(r, 'backtracking') });
      return;
    }

    const { nfa, dfa, minDFA } = compile(pattern);
    let result;
    if (engine === 'backtracking') result = matchBacktracking(nfa, text, { mode });
    else if (engine === 'nfa') result = matchNFA(nfa, text);
    else if (engine === 'dfa') result = matchDFA(dfa, text);
    else if (engine === 'minDFA') {
      if (!minDFA) throw new Error('DFA 已截断，无法最小化');
      result = matchDFA(minDFA, text);
    } else throw new Error(`未知引擎：${engine}`);
    res.json({ ok: true, ...stripFramesForTransport(result, engine) });
  }));

  // 贪婪 vs 懒惰 并排对比（含反向引用时走 AST 回溯引擎）
  app.post('/api/compare-modes', wrap((req, res) => {
    const { pattern, input = '' } = req.body;
    if (typeof pattern !== 'string') throw new RegexSyntaxError('pattern 必须是字符串', 0);
    const text = String(input);
    const ast = parsePattern(pattern);
    let greedy;
    let lazy;
    if (hasBackreferences(ast)) {
      greedy = matchAstBacktracking(ast, text, { mode: 'greedy', source: pattern });
      lazy = matchAstBacktracking(ast, text, { mode: 'lazy', source: pattern });
    } else {
      const nfaGreedy = buildNFA(ast, { mode: 'greedy' });
      const nfaLazy = buildNFA(ast, { mode: 'lazy' });
      greedy = matchBacktracking(nfaGreedy, text, { mode: 'greedy' });
      lazy = matchBacktracking(nfaLazy, text, { mode: 'lazy' });
    }
    res.json({
      ok: true,
      nonDeterminizable: hasBackreferences(ast),
      greedy: stripFramesForTransport(greedy, 'backtracking'),
      lazy: stripFramesForTransport(lazy, 'backtracking'),
    });
  }));

  // 灾难性回溯分析
  app.post('/api/analyze', wrap((req, res) => {
    const { pattern } = req.body;
    if (typeof pattern !== 'string') throw new RegexSyntaxError('pattern 必须是字符串', 0);
    const ast = parsePattern(pattern);
    const analysis = analyzePattern(ast, pattern);
    res.json({ ok: true, analysis });
  }));

  // 教学案例
  app.get('/api/examples', (_req, res) => res.json({ ok: true, examples: listExamples() }));
  app.get('/api/examples/:id', (req, res) => {
    const ex = getExample(req.params.id);
    if (!ex) return res.status(404).json({ ok: false, error: { message: '案例不存在' } });
    return res.json({ ok: true, example: ex });
  });

  // 静态前端（生产单容器）
  if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  }

  return app;
}

function graphPayload(kind, graph) {
  if (kind === 'nfa') {
    return {
      kind,
      start: graph.start,
      accept: graph.accept,
      states: graph.states,
      edges: graph.edges,
      steps: graph.steps,
    };
  }
  return {
    kind,
    start: graph.start,
    searchStart: graph.searchStart,
    states: graph.states,
    transitions: graph.transitions,
    symbols: graph.symbols,
    steps: graph.steps,
    beforeCount: graph.beforeCount,
    afterCount: graph.afterCount,
    truncated: graph.truncated,
    truncationDetail: graph.truncationDetail,
  };
}

function stripFramesForTransport(result, engine) {
  // 帧数据直接透传（已做 cap）；只把引擎内部无关字段剔除
  return {
    engine,
    mode: result.mode,
    input: result.input,
    matched: result.matched,
    result: result.result,
    frames: result.frames,
    metrics: result.metrics,
  };
}

export function startServer(port = Number(process.env.PORT) || 3000) {
  const app = createApp();
  app.locals.logger = (err) => console.error('[engine error]', err);
  return app.listen(port, () => {
    console.log(`regex visualizer listening on http://0.0.0.0:${port}`);
  });
}

// 直接 `node src/server.js` 时启动
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}

export { EXAMPLES };
