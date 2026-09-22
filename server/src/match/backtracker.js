// backtracker.js
// 在 Thompson NFA 上做递归下降式深度优先匹配（与 PCRE/JS 正则引擎的回溯
// 模型一致），语义为最左匹配：
//   - 贪婪：单次起点的整棵路径树全部探索，取见到的最深接受位置（最长）；
//   - 惰性：第一次到达接受位置即成功（最短）。
// 量词在构图时产生两条 ε 选择边，preference 小的先尝试；惰性模式下把
// 选择边顺序翻转。每次回退录成 backtrack 帧，前端用红色虚线呈现。

export const BACKTRACK_STEP_CAP = 200000;
export const BACKTRACK_FRAME_CAP = 14000;

function buildOutgoing(nfa, lazy) {
  const out = new Map();
  nfa.edges.forEach((e) => {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e);
  });
  // Thompson 图里，量词分叉状态有两条带 choice 标记的 ε 边：
  //   continue = 进入循环体/消费副本，exit = 退出循环/跳过副本。
  // 贪婪先 continue 后 exit；惰性把二者交换。其它边（字符、锚点、普通 ε）
  // 不带 choice，保持构图时的原始相对顺序（稳定排序）。
  out.forEach((list) => {
    if (!list.some((e) => e.choice)) return;
    const rank = (e) => {
      if (!e.choice) return -1;
      if (!lazy) return e.choice === 'continue' ? 0 : 1;
      return e.choice === 'continue' ? 1 : 0;
    };
    const decorated = list.map((e, idx) => ({ e, idx, r: rank(e) }));
    decorated.sort((a, b) => (a.r === -1 || b.r === -1 ? a.idx - b.idx : a.r - b.r));
    list.splice(0, list.length, ...decorated.map((d) => d.e));
  });
  return out;
}

function finalizeCaptures(stack) {
  const groups = {};
  const openStack = [];
  for (const c of stack) {
    if (c.kind === 'open') openStack.push(c);
    else {
      for (let i = openStack.length - 1; i >= 0; i -= 1) {
        if (openStack[i].group === c.group) {
          const o = openStack.splice(i, 1)[0];
          groups[c.group] = { start: o.pos, end: c.pos };
          break;
        }
      }
    }
  }
  return groups;
}

export function matchBacktracking(nfa, input, { mode = 'greedy', stepCap = BACKTRACK_STEP_CAP } = {}) {
  const lazy = mode === 'lazy';
  const edgesAt = buildOutgoing(nfa, lazy);
  const chars = Array.from(input);
  const len = chars.length;
  const frames = [];
  let transitions = 0;
  let edgeAttempts = 0;
  let backtracks = 0;
  const visitedStates = new Set([nfa.start]);
  let capped = false;
  let abortReason = null;
  let result = null;

  const record = (frame) => {
    if (frames.length < BACKTRACK_FRAME_CAP) frames.push({ index: frames.length, ...frame });
  };

  function attempt(startPos) {
    const callStack = [{
      state: nfa.start,
      cursor: 0,
      pos: startPos,
      captures: [],
      path: [],
    }];
    let best = null; // 贪婪：最深接受点 { end, captures, path }
    record({
      kind: 'attempt',
      pos: startPos,
      activeStates: [nfa.start],
      message: `从位置 ${startPos} 深度优先展开路径（${lazy ? '惰性：选择边优先“跳过”，首次到达接受即成功' : '贪婪：优先“进入/继续”，整棵树取最长'}）`,
    });

    const activeStates = () => [...new Set(callStack.map((f) => f.state))];
    const hitCap = () => {
      if (edgeAttempts < stepCap) return false;
      capped = true;
      abortReason = `回溯步数超过上限 ${stepCap}，强制终止（这正是灾难性回溯的典型症状）`;
      record({ kind: 'abort', pos: callStack[callStack.length - 1]?.pos ?? startPos, message: abortReason });
      return true;
    };

    while (callStack.length) {
      if (hitCap()) return false;
      const top = callStack[callStack.length - 1];
      const { state, pos } = top;

      if (state === nfa.accept) {
        if (lazy) {
          result = { start: startPos, end: pos, captures: finalizeCaptures(top.captures) };
          record({
            kind: 'accept', pos, start: startPos, end: pos,
            match: chars.slice(startPos, pos).join(''),
            path: [...top.path], captures: result.captures, activeStates: activeStates(),
            message: `惰性匹配成功：首次到达接受状态，位置 ${startPos}..${pos}`,
          });
          return true;
        }
        if (!best || pos > best.end) {
          best = { end: pos, captures: [...top.captures], path: [...top.path] };
        }
        record({
          kind: 'accept-here', pos, start: startPos, end: pos,
          path: [...top.path], activeStates: activeStates(),
          message: `到达接受状态：位置 ${startPos}..${pos} 可匹配；贪婪策略继续搜索更长`,
        });
        callStack.pop();
        const backTo = callStack[callStack.length - 1];
        record({
          kind: 'return-from-accept', pos, state,
          backtrackToState: backTo ? backTo.state : null,
          activeStates: backTo ? activeStates() : [],
          message: '记录该候选后沿路径树回退，寻找更长匹配',
        });
        continue;
      }

      const edges = edgesAt.get(state) || [];
      if (top.cursor >= edges.length) {
        callStack.pop();
        backtracks += 1;
        const backTo = callStack[callStack.length - 1];
        record({
          kind: 'backtrack', pos, state,
          edgeId: top.path.length ? top.path[top.path.length - 1] : null,
          backtrackToState: backTo ? backTo.state : null,
          activeStates: backTo ? activeStates() : [],
          message: backTo
            ? `状态 S${state} 已穷尽所有选择，回退到 S${backTo.state} 尝试下一条边（红色虚线）`
            : `从位置 ${startPos} 出发的路径树探索完毕`,
        });
        continue;
      }

      const edge = edges[top.cursor];
      top.cursor += 1;
      edgeAttempts += 1;
      transitions += 1;
      visitedStates.add(edge.to);

      const push = (newPos, captures) => {
        callStack.push({ state: edge.to, cursor: 0, pos: newPos, captures, path: [...top.path, edge.id] });
      };
      const choiceNote = edge.preference
        ? lazy
          ? '（惰性：优先“跳过/退出”）'
          : '（贪婪：优先“进入/继续”）'
        : '';

      if (edge.type === 'epsilon') {
        const looping = callStack.some((f) => f.state === edge.to && f.pos === pos);
        record({
          kind: looping ? 'skip-epsilon' : 'epsilon',
          pos, state, edgeId: edge.id, toState: edge.to,
          choice: edge.preference ? 'quantifier-choice' : null,
          activeStates: activeStates(),
          message: looping
            ? '沿 ε 边会零宽成环，跳过以避免死循环'
            : `沿 ε 边 S${state} → S${edge.to}（不消耗字符）${choiceNote}${
                edge.marker ? `，捕获组 #${edge.marker.group} ${edge.marker.kind === 'open' ? '开始' : '结束'}` : ''
              }`,
        });
        if (looping) continue;
        push(pos, edge.marker ? [...top.captures, { ...edge.marker, pos }] : top.captures);
        continue;
      }

      if (edge.type === 'anchor') {
        const ok = edge.dir === 'start' ? pos === 0 : pos === len;
        record({
          kind: ok ? 'anchor-pass' : 'anchor-fail',
          pos, state, edgeId: edge.id, toState: edge.to, activeStates: activeStates(),
          message: ok
            ? `锚点 ${edge.dir === 'start' ? '^' : '$'} 在位置 ${pos} 成立，零宽通过`
            : `锚点 ${edge.dir === 'start' ? '^' : '$'} 在位置 ${pos} 不成立（${edge.dir === 'start' ? '不是串首' : '不是串尾'}），此路不通`,
        });
        if (!ok) continue;
        push(pos, top.captures);
        continue;
      }

      // char 边
      if (pos >= len) {
        record({ kind: 'char-eof', pos, state, edgeId: edge.id, activeStates: activeStates(), message: '需要再消费一个字符，但输入已经结束，此路不通' });
        continue;
      }
      const cp = chars[pos].codePointAt(0);
      const ok = edge.set.length > 0 && edge.set.some(([lo, hi]) => cp >= lo && cp < hi);
      record({
        kind: ok ? 'char-match' : 'char-fail',
        pos, char: chars[pos], state, edgeId: edge.id, toState: edge.to, activeStates: activeStates(),
        message: ok
          ? `字符 "${chars[pos]}" 匹配转移 S${state} → S${edge.to}，位置前进到 ${pos + 1}`
          : `字符 "${chars[pos]}" 不匹配该字符类，此路不通`,
      });
      if (!ok) continue;
      push(pos + 1, top.captures);
    }

    if (best) {
      result = { start: startPos, end: best.end, captures: finalizeCaptures(best.captures) };
      record({
        kind: 'accept', pos: best.end, start: startPos, end: best.end,
        match: chars.slice(startPos, best.end).join(''),
        path: best.path, captures: result.captures,
        message: `路径树探索完毕，取最长匹配：位置 ${startPos}..${best.end}`,
      });
      return true;
    }
    record({ kind: 'attempt-fail', pos: startPos, activeStates: [], message: `从位置 ${startPos} 出发的所有路径都被拒绝` });
    return false;
  }

  let matched = false;
  for (let p = 0; p <= len; p += 1) {
    if (attempt(p)) {
      matched = true;
      break;
    }
    if (capped) break;
  }

  return {
    engine: 'backtracking',
    mode,
    input,
    matched,
    result,
    frames,
    metrics: {
      transitions,
      edgeAttempts,
      backtracks,
      visitedStates: visitedStates.size,
      frameCount: frames.length,
      inputLength: len,
      capped,
      abortReason,
    },
  };
}
