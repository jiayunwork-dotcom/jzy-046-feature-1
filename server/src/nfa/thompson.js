// thompson.js
// Thompson 构造法：AST -> NFA。
// 设计要点：
//  - buildItem(node, in) 从给定入口状态构造片段，返回出口状态；
//    连接（concat）直接把前一个片段的出口作为后一个的入口，即 Thompson
//    “状态合一”，不产生多余 ε 边。
//  - 选择分支新增分叉/汇合状态；量词统一展开为“必选副本 + 可选副本 +
//    无界自循环”，贪婪/懒惰只体现在选择边的尝试顺序（preference）。
//  - 构造过程同时录制成 steps，供前端一条规则一条规则地播放。
//  - 坐标在构造完成后按最长路径分层 + 重心排序统一计算。

import { edgeLabel } from '../charset.js';
import { NonRegularPatternError, findBackrefs } from '../regularity.js';

export const NFA_STATE_LIMIT = 4000;

export class ThompsonBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThompsonBuildError';
  }
}

const RULE_TEXT = {
  init: '创建起始状态',
  char: '字符转移',
  charClass: '字符类转移',
  anchor: '锚点（零宽断言）',
  epsilon: '空片段 ε',
  concat: '连接（状态合一）',
  alternation: '选择分支（分叉 + 汇合）',
  repeatMandatory: '量词：必选副本',
  repeatOptional: '量词：可选副本（贪婪优先进入 / 懒惰优先跳过）',
  repeatLoop: '量词：无界自循环',
  groupCapture: '捕获组（标记进入 / 退出）',
  groupPlain: '非捕获组（透传）',
  finish: '收尾：出口接到接受状态',
};

export class ThompsonBuilder {
  constructor(ast, { mode = 'greedy' } = {}) {
    this.ast = ast;
    this.mode = mode === 'lazy' ? 'lazy' : 'greedy';
    this.states = [];
    this.edges = [];
    this.steps = [];
    this._sid = 0;
    this._eid = 0;
    this._stepId = 0;
  }

  isLazy(node) {
    // 显式标记优先；对比模式下未标记的量词跟随全局模式
    if (node.greedy === false) return true;
    if (node.greedy === true && this.mode === 'greedy') return false;
    return this.mode === 'lazy';
  }

  addState(astId, kind = 'normal') {
    if (this.states.length >= NFA_STATE_LIMIT) {
      throw new ThompsonBuildError(
        `NFA 状态数超过上限 ${NFA_STATE_LIMIT}：量词展开（如 {n,m}）过大，请缩短重复次数`
      );
    }
    const state = { id: this._sid++, astId, kind, x: 0, y: 0 };
    this.states.push(state);
    return state.id;
  }

  addEdge(edge) {
    const e = {
      id: this._eid++,
      preference: 0,
      marker: null,
      ...edge,
    };
    this.edges.push(e);
    return e.id;
  }

  emit(astId, rule, newStates, newEdges, extra = {}) {
    this.steps.push({
      id: this._stepId++,
      astId,
      rule,
      title: RULE_TEXT[rule] || rule,
      newStates: [...newStates],
      newEdges: [...newEdges],
      ...extra,
    });
  }

  build() {
    // 硬门：反向引用不是正则语言，Thompson 构造无法表达“与先前捕获相同”
    // 的相等约束；绝不能把它当普通节点悄悄构出语义错误的自动机。
    const refs = findBackrefs(this.ast);
    if (refs.length) throw new NonRegularPatternError(refs);

    const start = this.addState(this.ast.id, 'start');
    this.emit(this.ast.id, 'init', [start], [], {
      description: '创建唯一的起始状态（图最左侧），所有路径都从它出发',
    });
    const bodyOut = this.buildItem(this.ast.body, start);
    const accept = this.addState(this.ast.id, 'accept');
    const e = this.addEdge({ from: bodyOut, to: accept, type: 'epsilon', astId: this.ast.id });
    this.emit(this.ast.id, 'finish', [accept], [e], {
      description: '片段出口经 ε 接到唯一的接受状态（双圈）',
    });
    this.layout();
    return {
      start,
      accept,
      states: this.states,
      edges: this.edges,
      steps: this.steps,
    };
  }

  // ---- 各 AST 节点 ----

  buildItem(node, inState) {
    switch (node.type) {
      case 'char':
        return this.buildChar(node, inState);
      case 'charClass':
        return this.buildChar(node, inState);
      case 'anchor':
        return this.buildAnchor(node, inState);
      case 'epsilon':
        this.emit(node.id, 'epsilon', [], [], { description: '空分支，不消耗字符' });
        return inState;
      case 'concat':
        return this.buildConcat(node, inState);
      case 'alternation':
        return this.buildAlternation(node, inState);
      case 'repeat':
        return this.buildRepeat(node, inState);
      case 'group':
        return this.buildGroup(node, inState);
      default:
        throw new ThompsonBuildError(`未知 AST 节点类型：${node.type}`);
    }
  }

  buildChar(node, inState) {
    const out = this.addState(node.id);
    const label = node.type === 'charClass' && node.builtin ? `\\${node.negated ? node.builtin.toUpperCase() : node.builtin}` : null;
    const eid = this.addEdge({
      from: inState,
      to: out,
      type: 'char',
      set: node.set,
      labelText: edgeLabel(node.set, label),
      astId: node.id,
    });
    this.emit(node.id, node.type === 'char' ? 'char' : 'charClass', [out], [eid], {
      description:
        node.type === 'char'
          ? `读入字符 ${node.set.length ? edgeLabel(node.set) : ''} 后转移`
          : `读入属于字符类的任意一个字符后转移（${node.dot ? '.' : label || '区间/并集'}）`,
    });
    return out;
  }

  buildAnchor(node, inState) {
    const out = this.addState(node.id);
    const eid = this.addEdge({
      from: inState,
      to: out,
      type: 'anchor',
      dir: node.dir,
      labelText: node.dir === 'start' ? '^' : '$',
      astId: node.id,
    });
    this.emit(node.id, 'anchor', [out], [eid], {
      description: node.dir === 'start' ? '^ 不消耗字符，仅当位于串首时可通过' : '$ 不消耗字符，仅当位于串尾时可通过',
    });
    return out;
  }

  buildConcat(node, inState) {
    let cur = inState;
    const linkEdges = [];
    node.items.forEach((item, idx) => {
      const before = cur;
      cur = this.buildItem(item, cur);
      // Thompson 连接：前段出口即后段入口（状态合一），记录一条说明
      if (idx > 0) {
        this.emit(item.id, 'concat', [], [], {
          description: `把第 ${idx} 段的出口状态 S${before} 直接作为第 ${idx + 1} 段的入口（状态合一，无 ε 开销）`,
        });
        void linkEdges;
      }
    });
    return cur;
  }

  buildAlternation(node, inState) {
    const entries = [];
    const outs = [];
    const newStates = [];
    const inEdges = [];
    node.branches.forEach((branch) => {
      const entry = this.addState(node.id);
      entries.push(entry);
      newStates.push(entry);
      inEdges.push(this.addEdge({ from: inState, to: entry, type: 'epsilon', astId: node.id }));
    });
    entries.forEach((entry, idx) => {
      outs.push(this.buildItem(node.branches[idx], entry));
    });
    const merge = this.addState(node.id);
    newStates.push(merge);
    const outEdges = outs.map((o) => this.addEdge({ from: o, to: merge, type: 'epsilon', astId: node.id }));
    this.emit(node.id, 'alternation', newStates, [...inEdges, ...outEdges], {
      description: `入口经 ε 分叉到 ${node.branches.length} 个分支，各分支出口再经 ε 汇合`,
    });
    return merge;
  }

  buildGroup(node, inState) {
    if (!node.capture) {
      const out = this.buildItem(node.body, inState);
      this.emit(node.id, 'groupPlain', [], [], { description: '非捕获组 (?:...) 不产生额外状态，直接透传' });
      return out;
    }
    const gIn = this.addState(node.id);
    const openE = this.addEdge({
      from: inState,
      to: gIn,
      type: 'epsilon',
      marker: { group: node.index, kind: 'open' },
      labelText: `(?${node.index}`,
      astId: node.id,
    });
    const bodyOut = this.buildItem(node.body, gIn);
    const gOut = this.addState(node.id);
    const closeE = this.addEdge({
      from: bodyOut,
      to: gOut,
      type: 'epsilon',
      marker: { group: node.index, kind: 'close' },
      labelText: `)${node.index}`,
      astId: node.id,
    });
    this.emit(node.id, 'groupCapture', [gIn, gOut], [openE, closeE], {
      description: `捕获组 #${node.index}：进入与退出各加一条带标记的 ε 边，用于记录截取内容`,
    });
    return gOut;
  }

  /** 通用量词展开：min 个必选副本 + (max-min) 个可选副本 + 一个无界循环 */
  buildRepeat(node, inState) {
    let cur = inState;
    const { min, max } = node;
    const lazy = this.isLazy(node);

    for (let k = 0; k < min; k += 1) {
      cur = this.buildItem(node.atom, cur);
      if (max !== min || max === Infinity || k > 0) {
        this.emit(node.id, 'repeatMandatory', [], [], {
          description: `量词 {${this.rangeText(node)}}：第 ${k + 1} 个必选副本`,
          phase: { kind: 'mandatory', index: k },
        });
      }
    }

    const optionalCount = max === Infinity ? Infinity : max - min;
    let made = 0;
    if (optionalCount === Infinity) {
      // 无界循环（* / + / {n,}）
      const loop = this.addState(node.id);
      const toLoop = this.addEdge({ from: cur, to: loop, type: 'epsilon', astId: node.id });
      const bodyIn = this.addState(node.id);
      const enter = this.addEdge({
        from: loop,
        to: bodyIn,
        type: 'epsilon',
        astId: node.id,
        preference: 0,
        choice: 'continue', // 进入循环体
        choiceGroup: node.id,
      });
      const bodyOut = this.buildItem(node.atom, bodyIn);
      const back = this.addEdge({ from: bodyOut, to: loop, type: 'epsilon', astId: node.id });
      const exitState = this.addState(node.id);
      const exit = this.addEdge({
        from: loop,
        to: exitState,
        type: 'epsilon',
        astId: node.id,
        preference: 1,
        choice: 'exit', // 退出循环
        choiceGroup: node.id,
      });
      this.emit(node.id, 'repeatLoop', [loop, bodyIn, exitState], [toLoop, enter, back, exit], {
        description: lazy
          ? '懒惰模式：循环入口优先走“退出”边，被迫时才进入循环体'
          : '贪婪模式：循环入口优先进入循环体，回溯时才走“退出”边（红色虚线即回溯路径）',
        phase: { kind: 'loop', lazy },
      });
      cur = exitState;
    } else {
      while (made < optionalCount) {
        const bodyIn = this.addState(node.id);
        const enter = this.addEdge({
          from: cur,
          to: bodyIn,
          type: 'epsilon',
          astId: node.id,
          preference: 0,
          choice: 'continue', // 消费这一副本
          choiceGroup: node.id,
        });
        const bodyOut = this.buildItem(node.atom, bodyIn);
        const skipState = this.addState(node.id);
        const finish = this.addEdge({ from: bodyOut, to: skipState, type: 'epsilon', astId: node.id });
        const skip = this.addEdge({
          from: cur,
          to: skipState,
          type: 'epsilon',
          astId: node.id,
          preference: 1,
          choice: 'exit', // 跳过这一副本
          choiceGroup: node.id,
        });
        this.emit(node.id, 'repeatOptional', [bodyIn, skipState], [enter, finish, skip], {
          description: `可选副本 ${min + made + 1}：${lazy ? '懒惰优先跳过' : '贪婪优先进入'}，失败再换另一条 ε 边（回溯）`,
          phase: { kind: 'optional', index: made, lazy },
        });
        cur = skipState;
        made += 1;
      }
    }
    return cur;
  }

  rangeText(node) {
    const { min, max } = node;
    if (max === Infinity) return min === 0 ? '0,' : `${min},`;
    return min === max ? `${min}` : `${min},${max}`;
  }

  // ---- 层次布局：最长路径定 x 层，重心迭代定 y 序 ----

  layout() {
    const n = this.states.length;
    const adj = Array.from({ length: n }, () => []);
    const indeg = new Array(n).fill(0);
    this.edges.forEach((e) => {
      adj[e.from].push(e.to);
      indeg[e.to] += 1;
    });

    // 最长路径层数（拓扑序上松弛）
    const rank = new Array(n).fill(-1);
    const queue = [];
    const deg = [...indeg];
    for (let i = 0; i < n; i += 1) if (deg[i] === 0) queue.push(i);
    rank[0] = 0; // start 必为源
    const topo = [];
    while (queue.length) {
      const u = queue.shift();
      topo.push(u);
      adj[u].forEach((v) => {
        rank[v] = Math.max(rank[v], rank[u] + 1);
        deg[v] -= 1;
        if (deg[v] === 0) queue.push(v);
      });
    }
    // 兜底（理论无环）
    for (let i = 0; i < n; i += 1) if (rank[i] < 0) rank[i] = 0;

    const maxRank = Math.max(...rank);
    const layers = Array.from({ length: maxRank + 1 }, () => []);
    // 初始顺序：DFS 先序（沿 preference 小的边走，贴近匹配直觉）
    const prefOf = new Map();
    this.edges.forEach((e) => {
      const key = e.from * n + e.to;
      if (!prefOf.has(key)) prefOf.set(key, e.preference || 0);
    });
    const adjSorted = adj.map((vs, u) =>
      [...vs].sort((a, b) => (prefOf.get(u * n + a) || 0) - (prefOf.get(u * n + +b) || 0))
    );
    const seen = new Set();
    const dfs = (u) => {
      if (seen.has(u)) return;
      seen.add(u);
      layers[rank[u]].push(u);
      adjSorted[u].forEach(dfs);
    };
    dfs(0);
    this.states.forEach((s) => {
      if (!seen.has(s.id)) layers[rank[s.id]].push(s.id);
    });

    // 重心法迭代排序，减少交叉
    const posInLayer = new Array(n).fill(0);
    const refreshPos = () => {
      layers.forEach((layer) => layer.forEach((s, idx) => { posInLayer[s] = idx; }));
    };
    const neighborsByRank = (u, toOut) => {
      const res = [];
      this.edges.forEach((e) => {
        if (toOut && e.from === u) res.push({ r: rank[e.to], p: posInLayer[e.to] });
        if (!toOut && e.to === u) res.push({ r: rank[e.from], p: posInLayer[e.from] });
      });
      return res;
    };
    const medianOf = (u, toOut) => {
      const ns = neighborsByRank(u, toOut).sort((a, b) => a.p - b.p).map((x) => x.p);
      if (ns.length === 0) return null;
      return ns[ns.length >> 1];
    };
    for (let sweep = 0; sweep < 8; sweep += 1) {
      refreshPos();
      const order = sweep % 2 === 0;
      for (let r = order ? 1 : maxRank - 1; order ? r <= maxRank : r >= 1; r += order ? 1 : -1) {
        const layer = layers[r];
        if (layer.length < 2) continue;
        const keys = new Map();
        layer.forEach((u) => {
          const m1 = medianOf(u, !order);
          const m2 = medianOf(u, order);
          keys.set(u, [m1 ?? m2 ?? posInLayer[u], m2 ?? m1 ?? posInLayer[u]]);
        });
        layer.sort((a, b) => {
          const ka = keys.get(a);
          const kb = keys.get(b);
          return ka[0] - kb[0] || ka[1] - kb[1];
        });
      }
    }

    // 落坐标：x 按层，y 按层内序，整列拉通为全局行号避免重叠
    refreshPos();
    const maxRows = Math.max(...layers.map((l) => l.length));
    layers.forEach((layer, r) => {
      layer.forEach((s, idx) => {
        const st = this.states[s];
        st.x = r;
        // 层内元素数不同：按比例居中
        st.y = idx + (maxRows - layer.length) / 2;
      });
    });
  }
}

export function buildNFA(ast, opts) {
  return new ThompsonBuilder(ast, opts).build();
}
