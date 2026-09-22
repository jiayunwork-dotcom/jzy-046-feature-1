// minimize.js
// 等价状态合并：基于“转移目标的等价类签名”反复细化划分，直到稳定。
// 接受状态与非接受状态天然不可等价（最终输出不同）。产出最小 DFA 与
// 合并过程的动画步骤（初始划分 → 每轮分裂 → 合并）。

export function minimizeDFA(dfa) {
  const n = dfa.states.length;
  const symCount = dfa.symbols.length;

  // 完整转移表（缺失视为去死状态；subset 已补齐，这里再兜底）
  const trans = Array.from({ length: n }, () => new Int32Array(symCount + 1).fill(-1));
  for (const t of dfa.transitions) {
    trans[t.from][t.symbol + 1] = t.to;
  }
  // 缺失转移目标：空集合状态或 -1（拒绝）
  const deadId = dfa.states.find((s) => s.dead)?.id ?? -1;
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k <= symCount; k += 1) {
      if (trans[i][k] === -1) trans[i][k] = deadId;
    }
  }

  // 初始划分：接受标记（四种位置条件分别不可混）/ 非接受 / 死状态
  const acceptCode = (acc) => {
    if (!acc) return 0;
    let code = 0;
    if (acc.plain) code |= 1;
    if (acc.startOnly) code |= 2;
    if (acc.endOnly) code |= 4;
    if (acc.both) code |= 8;
    return code;
  };
  const initialOf = (s) => {
    if (s === deadId) return 100; // 死状态独占
    return acceptCode(dfa.states[s].accept); // 0 = 非接受；>0 按接受条件细分
  };
  let cls = Array.from({ length: n }, (_, s) => initialOf(s));
  const steps = [];
  let stepId = 0;
  const snapshot = () => cls.map((c, s) => ({ state: s, cls: c }));
  const classSizes = (arr) => {
    const m = new Map();
    arr.forEach((c) => m.set(c, (m.get(c) || 0) + 1));
    return m;
  };

  steps.push({
    type: 'init',
    id: stepId++,
    partition: snapshot(),
    description: '初始划分：接受状态一类、非接受状态一类、死状态单独一类',
  });

  let round = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const newCls = new Array(n);
    const sigToCls = new Map();
    let nextClsId = 0;
    const splits = [];

    for (let s = 0; s < n; s += 1) {
      const sigParts = [cls[s]];
      for (let k = 0; k <= symCount; k += 1) {
        const target = trans[s][k];
        sigParts.push(target === -1 ? -1 : cls[target]);
      }
      const sig = sigParts.join('|');
      if (!sigToCls.has(sig)) {
        sigToCls.set(sig, nextClsId);
        nextClsId += 1;
      }
      newCls[s] = sigToCls.get(sig);
    }

    // 找出本轮从同一旧类分裂出去的组
    const oldByNew = new Map();
    for (let s = 0; s < n; s += 1) {
      const key = `${cls[s]}->${newCls[s]}`;
      if (!oldByNew.has(key)) oldByNew.set(key, []);
      oldByNew.get(key).push(s);
    }
    const grouped = new Map();
    oldByNew.forEach((members, key) => {
      const old = Number(key.split('->')[0]);
      if (!grouped.has(old)) grouped.set(old, []);
      grouped.get(old).push(members);
    });
    grouped.forEach((groups) => {
      if (groups.length > 1) {
        splits.push(groups.map((g) => [...g].sort((a, b) => a - b)));
      }
    });

    if (classSizes(cls).size !== classSizes(newCls).size) changed = true;
    cls = newCls;
    round += 1;
    steps.push({
      type: 'split',
      id: stepId++,
      partition: snapshot(),
      round,
      splits: splits.sort((a, b) => a[0][0] - b[0][0]),
      description:
        splits.length > 0
          ? `第 ${round} 轮细化：按“在各符号下转移到哪个类”算出签名，${splits.length} 组状态签名不同，拆成等价子类`
          : `第 ${round} 轮细化：所有同组状态签名一致，没有新分裂`,
    });
  }

  // 重排类号，使起始状态所在类为 0
  const remap = new Map();
  let cursor = 0;
  const startOld = cls[dfa.start];
  const order = [startOld, ...new Set(cls.filter((c) => c !== startOld))];
  order.forEach((c) => {
    remap.set(c, cursor);
    cursor += 1;
  });
  cls = cls.map((c) => remap.get(c));

  // 构建最小 DFA
  const minCount = cursor;
  const membersOf = Array.from({ length: minCount }, () => []);
  cls.forEach((c, s) => membersOf[c].push(s));
  const minStates = membersOf.map((members, id) => {
    const acc = { plain: false, startOnly: false, endOnly: false, both: false };
    members.forEach((s) => {
      const a = dfa.states[s].accept;
      if (!a) return;
      acc.plain = acc.plain || !!a.plain;
      acc.startOnly = acc.startOnly || !!a.startOnly;
      acc.endOnly = acc.endOnly || !!a.endOnly;
      acc.both = acc.both || !!a.both;
    });
    const anyAccept = acc.plain || acc.startOnly || acc.endOnly || acc.both;
    return {
      id,
      nfaStates: [...new Set(members.flatMap((s) => dfa.states[s].nfaStates))].sort((a, b) => a - b),
      accept: anyAccept ? acc : null,
      accepting: anyAccept,
      initial: id === cls[dfa.start],
      dead: members.length === 1 && members[0] === deadId,
      mergedStates: [...members].sort((a, b) => a - b),
    };
  });

  const minTransitions = [];
  const seen = new Set();
  for (const t of dfa.transitions) {
    const from = cls[t.from];
    const to = cls[t.to];
    const key = `${from}:${t.symbol}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    minTransitions.push({ from, symbol: t.symbol, to });
  }
  // 与子集构造产物保持同样的查表结构
  const transitionMap = new Map();
  for (const t of minTransitions) {
    transitionMap.set(t.from * (dfa.symbols.length + 1) + t.symbol, t.to);
  }

  const mergeGroups = membersOf
    .filter((m) => m.length > 1)
    .map((m) => [...m].sort((a, b) => a - b));
  steps.push({
    type: 'merge',
    id: stepId++,
    groups: mergeGroups,
    mapping: cls.map((c, s) => ({ state: s, cls: c })),
    description:
      mergeGroups.length > 0
        ? `划分稳定：${mergeGroups.length} 组等价状态被各合并为一个，状态数 ${n} → ${minCount}`
        : `划分稳定：没有可合并的等价状态，状态数保持 ${n}`,
  });

  return {
    states: minStates,
    transitions: minTransitions,
    transitionMap,
    symbols: dfa.symbols,
    start: cls[dfa.start],
    searchStart: cls[dfa.searchStart ?? dfa.start],
    beforeCount: n,
    afterCount: minCount,
    steps,
  };
}
