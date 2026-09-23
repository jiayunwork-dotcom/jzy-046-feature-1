// ast-backtracker.js
// 直接在 AST 上做带回溯的递归匹配，支持 NFA 表达不了的反向引用。
// 语义与普通回溯引擎保持一致：
//   - 最左匹配：从串首开始逐位置尝试起点；
//   - 贪婪：单个起点上取所有可行路径里最长的接受位置；
//   - 懒惰：第一次到达终点即成功（最短）。
//
// 捕获组用【不可变 Map】沿递归参数透传：分组闭合时 new Map(prev) 写入新
// 文本并交给后续续体；某条路径失败/回溯时它的 Map 直接被丢弃，天然回到
// 旧捕获，不需要任何回滚记账。反向引用只从当前路径自己的 Map 里取值。
//
// 捕获状态分两种（与 ECMA-262/JS 一致，界面与文档会专门说明）：
//   - 未参与（unset）：分组在当前路径没走到的分支里、或还没执行过；
//     反向引用指向它 => 本次比对失败。
//   - 已参与但抓到空串（empty）：分组执行了且体匹配了空文本，典型如
//     可选量词 (x)? 跳过的那一次；反向引用要求“再来一段空串”，零宽通过。
// 即：未参与 => 失败；参与过（哪怕抓到空串）=> 按其文本（可能为 ε）比对。

export const AST_BACKTRACK_STEP_CAP = 200000;
export const AST_BACKTRACK_FRAME_CAP = 14000;

const charsOf = (input) => Array.from(input);
const setContains = (set, cp) => set.length > 0 && set.some(([lo, hi]) => cp >= lo && cp < hi);
const viewOf = (caps, nameOf) => {
  const view = [];
  caps.forEach((v, group) => {
    view.push({
      group,
      name: nameOf.get(group) || null,
      start: v.start,
      end: v.end,
      text: v.text,
      empty: !!v.empty,
    });
  });
  view.sort((a, b) => a.group - b.group);
  return view;
};

export function matchAstBacktracking(ast, input, {
  mode = 'greedy',
  stepCap = AST_BACKTRACK_STEP_CAP,
  source = '',
} = {}) {
  const lazy = mode === 'lazy';
  const chars = charsOf(input);
  const len = chars.length;
  const codePoints = chars.map((c) => c.codePointAt(0));
  const frames = [];
  let transitions = 0;
  let edgeAttempts = 0;
  let backtracks = 0;
  let stepsUsed = 0;
  let capped = false;
  let abortReason = null;
  let result = null;
  const matchedChars = new Set();

  const record = (frame) => {
    if (frames.length < AST_BACKTRACK_FRAME_CAP) frames.push({ index: frames.length, ...frame });
  };

  const groupNames = ast.groupNames || {};
  const nameOf = new Map(Object.entries(groupNames).map(([n, i]) => [i, n]));
  const groupLabel = (index) => {
    const nm = nameOf.get(index);
    return nm ? `#${index} "${nm}"` : `#${index}`;
  };
  const formatRef = (node) => (node.refType === 'name' ? `\\k<${node.refValue}>` : `\\${node.refValue}`);
  const resolveRefIndex = (node) =>
    node.refType === 'number' ? node.index : groupNames[node.refValue] ?? node.index;

  /**
   * 在位置 p、携带捕获 caps 的条件下匹配 node；成功调用 succeed(np, caps2)。
   * succeed 返回 true 表示上层已接受（懒惰命中），false 表示继续找别的可能。
   */
  function matchNode(node, p, caps, succeed) {
    stepsUsed += 1;
    if (stepsUsed > stepCap) {
      capped = true;
      abortReason = `回溯步数超过上限 ${stepCap}，强制终止`;
      return false;
    }
    switch (node.type) {
      case 'char':
      case 'charClass':
        return doChar(node, p, caps, succeed);
      case 'anchor':
        return doAnchor(node, p, caps, succeed);
      case 'epsilon':
        return succeed(p, caps);
      case 'concat':
        return doConcat(node, 0, p, caps, succeed);
      case 'alternation':
        return doAlternation(node, p, caps, succeed);
      case 'repeat':
        return doRepeat(node, p, 0, caps, succeed);
      case 'group':
        return doGroup(node, p, caps, succeed);
      case 'backref':
        return doBackref(node, p, caps, succeed);
      default:
        throw new Error(`AST 回溯：未知节点类型 ${node.type}`);
    }
  }

  function doChar(node, p, caps, succeed) {
    edgeAttempts += 1;
    transitions += 1;
    if (p >= len) {
      record({ kind: 'char-eof', pos: p, astId: node.id, segment: source.slice(node.pos, node.end),
        captures: viewOf(caps, nameOf), message: '需要再消费一个字符，但输入已经结束，此路不通' });
      return false;
    }
    const ok = setContains(node.set, codePoints[p]);
    if (ok) {
      matchedChars.add(chars[p]);
      record({
        kind: 'char-match', pos: p, char: chars[p], astId: node.id,
        segment: source.slice(node.pos, node.end), captures: viewOf(caps, nameOf),
        message: `字符 "${chars[p]}" 匹配 ${node.type === 'charClass' ? '字符类' : '字面量'}，前进到位置 ${p + 1}`,
      });
      return succeed(p + 1, caps);
    }
    record({
      kind: 'char-fail', pos: p, char: chars[p], astId: node.id,
      segment: source.slice(node.pos, node.end), captures: viewOf(caps, nameOf),
      message: `字符 "${chars[p]}" 不匹配 ${node.type === 'charClass' ? '该字符类' : '字面量'}，此路不通，触发回溯`,
    });
    return false;
  }

  function doAnchor(node, p, caps, succeed) {
    edgeAttempts += 1;
    const ok = node.dir === 'start' ? p === 0 : p === len;
    record({
      kind: ok ? 'anchor-pass' : 'anchor-fail', pos: p, astId: node.id, captures: viewOf(caps, nameOf),
      message: ok
        ? `锚点 ${node.dir === 'start' ? '^' : '$'} 在位置 ${p} 成立，零宽通过`
        : `锚点 ${node.dir === 'start' ? '^' : '$'} 在位置 ${p} 不成立，此路不通`,
    });
    return ok ? succeed(p, caps) : false;
  }

  function doConcat(node, idx, p, caps, succeed) {
    if (idx >= node.items.length) return succeed(p, caps);
    return matchNode(node.items[idx], p, caps, (np, caps2) =>
      doConcat(node, idx + 1, np, caps2, succeed));
  }

  function doAlternation(node, p, caps, succeed) {
    const tryBranch = (idx) => {
      if (idx >= node.branches.length) {
        record({ kind: 'alt-exhausted', pos: p, astId: node.id, captures: viewOf(caps, nameOf),
          message: '选择的所有分支都已失败' });
        return false;
      }
      record({ kind: 'alt-branch', pos: p, astId: node.id, branch: idx, captures: viewOf(caps, nameOf),
        message: `尝试选择的第 ${idx + 1}/${node.branches.length} 个分支` });
      // 分支收到的是同一份不可变 caps；失败直接丢弃分支内 new 出的 Map，无需回滚
      const ok = matchNode(node.branches[idx], p, caps, succeed);
      if (ok) return true;
      backtracks += 1;
      return tryBranch(idx + 1);
    };
    return tryBranch(0);
  }

  function doGroup(node, p, caps, succeed) {
    if (!node.capture) return matchNode(node.body, p, caps, succeed);
    const index = node.index;
    record({
      kind: 'group-open', pos: p, group: index, label: groupLabel(index), captures: viewOf(caps, nameOf),
      message: `捕获组 ${groupLabel(index)} 在位置 ${p} 开始记录`,
    });
    // 组体在“进入时的捕获状态”上展开。组一旦进入即标记为“已参与”，
    // 这样体匹配空文本（含被可选量词跳过的一轮）也会写入空串捕获，
    // 反向引用它时零宽通过；与“根本没走到的分支（未参与）”区分开。
    return matchNode(node.body, p, caps, (np, capsAfterBody) => {
      const text = chars.slice(p, np).join('');
      const caps2 = new Map(capsAfterBody);
      caps2.set(index, { start: p, end: np, text, participated: true });
      record({
        kind: 'group-close', pos: np, group: index, label: groupLabel(index),
        captured: text, captures: viewOf(caps2, nameOf),
        message: `捕获组 ${groupLabel(index)} 闭合：抓到 "${text}"（位置 ${p}..${np}，长度 ${text.length}）`,
      });
      return succeed(np, caps2);
    });
  }

  /**
   * 量词：min 个必选副本 + 可选副本 + 无界自循环。
   * 贪婪先继续、失败再退出；懒惰先退出。零宽副本直接走退出（防死循环）。
   */
  function doRepeat(node, p, count, caps, succeed) {
    const { min, max } = node;
    if (count < min) {
      return matchNode(node.atom, p, caps, (np, caps2) => {
        if (np === p) return zeroWidthDone(node, np, caps2, succeed);
        return doRepeat(node, np, count + 1, caps2, succeed);
      });
    }
    if (max !== Infinity && count >= max) return succeed(p, caps);

    // 退出量词时，把这一轮“可选而未执行”的捕获组标记为“已参与但抓到空串”
    // ——(x)? 跳过后 \1 匹配 ε（JS/PCRE 语义）；只处理直接构成该副本的组。
    const tryExit = () => succeed(p, markOptionalEmpty(node.atom, caps));
    const tryContinue = () => {
      // 零宽护栏：每个量词在同一输入位置只允许“再进一轮”一次
      let set = zeroGuard.get(node.id);
      if (!set) { set = new Set(); zeroGuard.set(node.id, set); }
      if (set.has(p)) {
        record({ kind: 'repeat-zero-skip', pos: p, astId: node.id, captures: viewOf(caps, nameOf),
          message: '循环体在当前位置零宽重复：跳过以避免死循环' });
        return false;
      }
      set.add(p);
      return matchNode(node.atom, p, caps, (np, caps2) => {
        if (np === p) return zeroWidthDone(node, np, caps2, succeed);
        return doRepeat(node, np, count + 1, caps2, succeed);
      });
    };

    if (lazy) return tryExit() || tryContinue();
    return tryContinue() || tryExit();
  }

  /**
   * 收集“量词原子可选地跳过时应当被记为空参与”的捕获组。
   * 规则：被该量词直接拥有（或仅隔着可选次数结构）的捕获组，在这一轮没
   * 执行时按空串参与；已参与过的组保留其捕获。
   */
  function optionalGroupsOf(atom) {
    const groups = [];
    const visit = (n, optional) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'group' && n.capture && optional) {
        groups.push(n.index);
        return; // 组内更深的组由组本身递归时自行处理
      }
      if (n.type === 'group' && n.capture) {
        visit(n.body, false);
        return;
      }
      if (n.type === 'group') { visit(n.body, optional); return; }
      if (n.type === 'repeat') {
        // 内层量词：其捕获组跳过与否由内层自己在退出时决定，这里不下放
        visit(n.atom, false);
        return;
      }
      if (n.type === 'concat') n.items.forEach((c) => visit(c, optional));
      if (n.type === 'alternation') n.branches.forEach((c) => visit(c, optional));
    };
    visit(atom, true);
    return groups;
  }

  function markOptionalEmpty(atom, caps) {
    const indices = optionalGroupsOf(atom);
    if (indices.length === 0) return caps;
    let next = caps;
    for (const index of indices) {
      if (next.has(index)) continue; // 本轮之前已参与过：保留既有捕获
      if (!next.has(index)) {
        if (next === caps) next = new Map(caps);
        next.set(index, { start: null, end: null, text: '', participated: true, empty: true });
      }
    }
    return next;
  }

  const zeroGuard = new Map();
  function zeroWidthDone(node, np, caps, succeed) {
    record({ kind: 'repeat-zero-skip', pos: np, astId: node.id, captures: viewOf(caps, nameOf),
      message: '量词副本没有消费任何字符：按退出处理，避免零宽死循环' });
    return succeed(np, caps);
  }

  function doBackref(node, p, caps, succeed) {
    edgeAttempts += 1;
    const index = resolveRefIndex(node);
    const cap = index === null ? null : caps.get(index) || null;
    const ref = formatRef(node);

    // 第一步：从当前路径的捕获栈取值（独立帧，区别于普通字符转移）
    if (!cap) {
      record({
        kind: 'backref-unset', pos: p, astId: node.id, ref, group: index, captures: viewOf(caps, nameOf),
        message: `反向引用 ${ref}：被引用的分组 ${index === null ? '' : groupLabel(index)}` +
          '在当前这条尝试路径上还【未参与】匹配（例如在没走到的另一选择分支里）' +
          '——按本工具约定（同 JS 惯例），未参与分组的反向引用按本次比对失败处理',
      });
      return false;
    }
    // 已参与但抓到空串（如 (x)? 跳过的一次）：反向引用匹配 ε，零宽通过
    if (cap.text.length === 0) {
      record({
        kind: 'backref-empty', pos: p, astId: node.id, ref, group: index,
        label: groupLabel(index), captures: viewOf(caps, nameOf),
        message: `反向引用 ${ref}：分组 ${groupLabel(index)} 已参与但抓到空串（典型于可选量词跳过），反向引用匹配零个字符，直接通过`,
      });
      return succeed(p, caps);
    }
    record({
      kind: 'backref-load', pos: p, astId: node.id, ref, group: index, label: groupLabel(index),
      value: cap.text, capturedRange: [cap.start, cap.end], captures: viewOf(caps, nameOf),
      message: `反向引用 ${ref}：从捕获栈取分组 ${groupLabel(index)} 已确定的文本 "${cap.text}"（位置 ${cap.start}..${cap.end}），开始逐字符比对`,
    });

    // 第二步：逐字符比对（每字符一帧，成功绿、失败红）
    const wanted = charsOf(cap.text);
    for (let k = 0; k < wanted.length; k += 1) {
      transitions += 1;
      stepsUsed += 1;
      if (stepsUsed > stepCap) {
        capped = true;
        abortReason = `回溯步数超过上限 ${stepCap}，强制终止`;
        return false;
      }
      const cur = p + k;
      if (cur >= len || codePoints[cur] !== wanted[k].codePointAt(0)) {
        record({
          kind: 'backref-fail', pos: cur >= len ? len : cur, astId: node.id, ref, group: index,
          value: cap.text, mismatchAt: k, char: cur < len ? chars[cur] : null, captures: viewOf(caps, nameOf),
          message: cur >= len
            ? `反向引用比对失败：还需 "${wanted.slice(k).join('')}"（${wanted.length - k} 个字符），但输入已经结束——此路不通，触发回溯`
            : `反向引用比对失败：第 ${k + 1} 个字符期望 "${wanted[k]}"，实际是 "${chars[cur]}"——必须与捕获文本逐字相同，此路不通，触发回溯`,
        });
        return false;
      }
      record({
        kind: 'backref-char', pos: cur, astId: node.id, ref, group: index, value: cap.text,
        char: wanted[k], offset: k, total: wanted.length, captures: viewOf(caps, nameOf),
        message: `反向引用比对（${k + 1}/${wanted.length}）：输入 "${chars[cur]}" 与捕获文本 "${cap.text}" 第 ${k + 1} 个字符相同`,
      });
    }

    record({
      kind: 'backref-pass', pos: p + wanted.length, astId: node.id, ref, group: index,
      value: cap.text, captures: viewOf(caps, nameOf),
      message: `反向引用 ${ref} 的 ${wanted.length} 个字符全部与捕获文本一致，前进到位置 ${p + wanted.length}`,
    });
    return succeed(p + wanted.length, caps);
  }

  // ---- 起点循环：最左匹配 ----

  function attemptAt(startPos) {
    record({
      kind: 'attempt', pos: startPos, captures: [],
      message: `从位置 ${startPos} 深度优先展开路径（${lazy ? '惰性：首次成功即最短匹配' : '贪婪：成功后继续探索更长匹配'}；反向引用会逐字比对捕获文本）`,
    });
    let localBest = null;
    const accept = (p, caps) => {
      const capsObj = {};
      caps.forEach((v, g) => {
        // 仅“可选跳过”产生的空参与不体现在最终捕获结果里（JS 中为 undefined），
        // 但它在内部 Map 中保留，供后续反向引用按 ε 处理
        if (v.empty && (v.start === null || v.start === undefined)) return;
        capsObj[g] = { start: v.start, end: v.end };
      });
      if (lazy) {
        localBest = { end: p, capsObj };
        record({
          kind: 'accept', pos: p, start: startPos, end: p,
          match: chars.slice(startPos, p).join(''), captures: viewOf(caps, nameOf),
          message: `惰性匹配成功：位置 ${startPos}..${p}，首次到达即停`,
        });
        return true;
      }
      if (!localBest || p > localBest.end) localBest = { end: p, capsObj };
      record({
        kind: 'accept-here', pos: p, start: startPos, end: p,
        match: chars.slice(startPos, p).join(''), captures: viewOf(caps, nameOf),
        message: `位置 ${startPos}..${p} 可匹配；贪婪策略继续回溯寻找更长`,
      });
      return false;
    };

    const committed = matchNode(ast.body, startPos, new Map(), accept);
    if (lazy && committed && localBest) {
      result = { start: startPos, end: localBest.end, captures: localBest.capsObj };
      return true;
    }
    if (!lazy && localBest) {
      result = { start: startPos, end: localBest.end, captures: localBest.capsObj };
      record({
        kind: 'accept', pos: localBest.end, start: startPos, end: localBest.end,
        match: chars.slice(startPos, localBest.end).join(''),
        message: `路径树探索完毕，取最长匹配：位置 ${startPos}..${localBest.end}`,
      });
      return true;
    }
    record({ kind: 'attempt-fail', pos: startPos, captures: [],
      message: `从位置 ${startPos} 出发的所有路径都被拒绝` });
    return false;
  }

  let matched = false;
  for (let p = 0; p <= len; p += 1) {
    zeroGuard.clear();
    if (attemptAt(p)) { matched = true; break; }
    if (capped) break;
  }
  if (capped && frames[frames.length - 1]?.kind !== 'abort') {
    record({ kind: 'abort', pos: len, message: abortReason });
  }

  return {
    engine: 'backtracking-ast',
    mode,
    input,
    matched,
    result,
    frames,
    metrics: {
      transitions,
      edgeAttempts,
      backtracks,
      visitedStates: matchedChars.size,
      frameCount: frames.length,
      inputLength: len,
      capped,
      abortReason,
    },
  };
}
