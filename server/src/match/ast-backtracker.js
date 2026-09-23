// ast-backtracker.js
// 基于 AST 的递归下降回溯引擎（带捕获栈）。
//
// 为什么需要它：match/backtracker.js 在 Thompson NFA 上跑，只能处理正则
// 语言。反向引用要求“这一段和某组先前抓到的文本逐字符相同”，NFA 边没有
// 记忆，表达不了；本引擎直接在 AST 上做带捕获组状态的深度优先搜索：
//   - 捕获组在进入时记起点、闭合时提交 [start,end)，沿回溯路径回滚；
//   - 反向引用节点查当前捕获栈，逐码点比对；组在当前路径里没抓到
//     （如选择分支另一头没走过）按“本次比对失败”处理并在帧中标注；
//   - 贪婪：所有接受位置都探索到，取最长；懒惰：首次接受即成功。
//
// 抽象机：显式栈的成功/失败双延续 CPS。
//   栈帧分两类：
//     成功延续 s/m/g：一次性、可变（记录“接下来还剩哪些子项”），只在
//       成功传播时被向下消费；
//     决策点 b（选择分支）/q（量词）：保存创建时其【下方整条延续栈】的
//       独立快照 below，以及当时的输入位置与捕获 Map。某条备选失败时，
//       丢弃它上方堆积的一切并用 below 重放另一条备选——这保证“量词
//       结束 / 分支另一头”之后的成功延续不会被先前的路径提前消费掉。
//   决策点的首选成功后，它在栈上转为哨兵（sentinel=true）：成功传播
//   穿过它继续处理 below；失败传播则在它这里恢复 below 尝试备选。

import { } from '../charset.js';

export const AST_BACKTRACK_STEP_CAP = 200000;
export const AST_BACKTRACK_FRAME_CAP = 14000;

const FAIL = Symbol('fail');

function isLazyNode(node, globalLazy) {
  // 显式惰性标记永远优先；未标惰性的量词在对比模式下跟随全局模式
  if (node.greedy === false) return true;
  return globalLazy;
}

/**
 * 深拷贝延续栈快照：AST 节点只读可共享；计数器、捕获 Map 必须独立。
 */
function cloneStack(stack) {
  return stack.map((f) => ({
    ...f,
    caps: f.caps instanceof Map ? new Map(f.caps) : f.caps,
    startCaps: f.startCaps instanceof Map ? new Map(f.startCaps) : f.startCaps,
    endCaps: f.endCaps instanceof Map ? new Map(f.endCaps) : f.endCaps,
    below: f.below ? cloneStack(f.below) : f.below,
  }));
}

export function matchASTBacktracking(ast, input, { mode = 'greedy', stepCap = AST_BACKTRACK_STEP_CAP } = {}) {
  const globalLazy = mode === 'lazy';
  const chars = Array.from(input);
  const len = chars.length;
  const frames = [];
  let transitions = 0; // 叶子（字符/类/锚点/反向引用）判定次数
  let edgeAttempts = 0; // 全部步骤数（含 ε 式的分叉/合流）
  let backtracks = 0;
  const visitedNodes = new Set();
  let capped = false;
  let abortReason = null;
  let result = null;

  const record = (frame) => {
    if (frames.length < AST_BACKTRACK_FRAME_CAP) frames.push({ index: frames.length, ...frame });
  };
  const snapshot = (caps) => {
    const out = [];
    caps.forEach((c, group) => {
      if (c.end === null) return;
      out.push({
        group,
        name: c.name ?? null,
        start: c.start,
        end: c.end,
        text: chars.slice(c.start, c.end).join(''),
      });
    });
    return out.sort((a, b) => a.group - b.group);
  };

  function attempt(startPos) {
    let goal = ast.body;
    let pos = startPos;
    let caps = new Map();
    const k = [];
    let best = null;

    record({
      kind: 'attempt',
      pos: startPos,
      nodeId: ast.id,
      caps: [],
      message: `从位置 ${startPos} 在 AST 上深度优先展开（${globalLazy ? '懒惰：量词优先“跳过”，首次接受即成功' : '贪婪：量词优先“再来一次”，全部路径取最长'}；捕获栈随路径复制、随回溯回滚）`,
    });

    /** 弹出连续的哨兵（首选已成功、当前只用于失败回溯的决策帧），返回被弹出的哨兵 */
    const popSentinels = () => {
      const popped = [];
      while (k.length && k[k.length - 1].sentinel) popped.push(k.pop());
      return popped;
    };

    while (true) {
      edgeAttempts += 1;
      if (edgeAttempts > stepCap) {
        capped = true;
        abortReason = `回溯步数超过上限 ${stepCap}，强制终止（含反向引用时每次比对都要重扫捕获文本，更容易出现灾难性回溯）`;
        record({ kind: 'abort', pos, nodeId: null, caps: snapshot(caps), message: abortReason });
        return false;
      }

      // ============ 失败传播 ============
      if (goal === FAIL) {
        let handled = false;
        while (k.length) {
          const top = k[k.length - 1];

          // 哨兵（首选已提交的决策点）：首选路径失败，取出 below 尝试备选
          if (top.sentinel) {
            k.pop();
            const below = top.below;
            if (top.t === 'b') {
              if (top.n < top.branches.length) {
                // 恢复 below，再压一个指向下一分支的新分叉帧
                k.length = 0;
                k.push(...below);
                const bi = top.n;
                const nb = {
                  ...top,
                  n: bi + 1,
                  sentinel: false,
                  below: cloneStack(below),
                };
                delete nb.sentinel;
                k.push(nb);
                pos = top.pos;
                caps = new Map(top.caps);
                goal = top.branches[bi];
                backtracks += 1;
                handled = true;
                record({
                  kind: 'backtrack', pos, nodeId: top.nodeId, caps: snapshot(caps),
                  message: `当前分支走不通，恢复分叉前的捕获栈与后续延续，改试第 ${bi + 1} 个分支`,
                });
                break;
              }
              // 分支穷尽：below 已恢复，失败继续向外抛
              continue;
            }
            if (top.t === 'q') {
              // 量词首选路径失败。首选是 continue（贪婪）还是 exit（懒惰）：
              if (!top.exitTried && top.canExit) {
                // 试“在此结束”
                top.exitTried = true;
                k.length = 0;
                k.push(...cloneStack(below));
                pos = top.endPos;
                caps = new Map(top.endCaps);
                goal = null;
                backtracks += 1;
                handled = true;
                record({
                  kind: 'backtrack', pos, nodeId: top.nodeId, caps: snapshot(caps),
                  message: `更长的重复走不通：量词在位置 ${pos} 结束（第 ${top.iterBefore + 1} 次重复），恢复该层闭合捕获后继续量词之后的匹配`,
                });
                break;
              }
              if (!top.continueTried && top.canContinue) {
                // 试“再来一个副本”（懒惰被迫扩张）
                top.continueTried = true;
                k.length = 0;
                k.push(...cloneStack(below));
                activateQuantLayer(top.node, top.endPos, top.endCaps, {
                  iterBefore: top.iterBefore + 1,
                  forced: true,
                  below: k.slice(),
                });
                backtracks += 1;
                handled = true;
                record({
                  kind: 'backtrack', pos: top.endPos, nodeId: top.nodeId, caps: snapshot(caps),
                  message: `量词在位置 ${top.endPos} 结束后后继走不通：懒惰被迫再消费一个副本`,
                });
                break;
              }
              // 结束与扩张都穷尽：below 已恢复，失败继续向外抛
              continue;
            }
            continue;
          }

          // 非哨兵决策点：其首选（第一分支 / 第一个重复体）本身失败
          if (top.t === 'b') {
            if (top.n < top.branches.length) {
              const bi = top.n;
              top.n += 1;
              pos = top.pos;
              caps = new Map(top.caps);
              goal = top.branches[bi];
              backtracks += 1;
              handled = true;
              record({
                kind: 'backtrack', pos, nodeId: top.nodeId, caps: snapshot(caps),
                message: `第 ${bi} 个分支走不通，改试第 ${bi + 1} 个分支（恢复分叉前快照）`,
              });
              break;
            }
            // 穷尽：恢复 below
            k.length = 0;
            k.push(...cloneStack(top.below));
            continue;
          }

          if (top.t === 'q') {
            // 重复体本身失败（尚未成功过）
            if (top.canExit) {
              // 普通可选层：零宽结束
              top.exitTried = true;
              top.sentinel = true; // 结束路径即“首选提交”，成功要穿过
              k.length = 0;
              k.push(...cloneStack(top.below));
              k.push(top);
              pos = top.startPos;
              caps = new Map(top.startCaps);
              goal = null;
              backtracks += 1;
              handled = true;
              record({
                kind: 'backtrack', pos, nodeId: top.nodeId, caps: snapshot(caps),
                message: `重复体在位置 ${pos} 走不通：量词在此零宽结束（不重复），继续量词之后的匹配`,
              });
              break;
            }
            // 强制/必选层不能零宽结束：恢复 below，失败上抛
            k.length = 0;
            k.push(...cloneStack(top.below));
            continue;
          }

          // 一次性成功延续（s/m/g）：失败直接丢弃
          k.pop();
        }

        if (!handled) {
          if (best) {
            result = {
              start: startPos,
              end: best.end,
              captures: finalizeCaps(best.caps, ast.groups || []),
            };
            record({
              kind: 'accept',
              pos: best.end, start: startPos, end: best.end, nodeId: ast.id,
              match: chars.slice(startPos, best.end).join(''),
              caps: snapshot(best.caps), captures: result.captures,
              message: `路径树探索完毕，取最长匹配：位置 ${startPos}..${best.end}（反向引用全部逐字符比对通过）`,
            });
            return true;
          }
          record({
            kind: 'attempt-fail', pos: startPos, nodeId: ast.id, caps: [],
            message: `从位置 ${startPos} 出发的所有路径都被拒绝`,
          });
          return false;
        }
        continue;
      }

      // ============ 成功传播 ============
      if (goal === null) {
        // 穿过所有哨兵（首选已成功的决策帧），找到栈顶真正的延续
        popSentinels();

        if (k.length === 0) {
          if (globalLazy) {
            result = {
              start: startPos, end: pos,
              captures: finalizeCaps(caps, ast.groups || []),
            };
            record({
              kind: 'accept', pos, start: startPos, end: pos, nodeId: ast.id,
              match: chars.slice(startPos, pos).join(''),
              caps: snapshot(caps), captures: result.captures,
              message: `懒惰匹配成功：首次到达模式结尾，位置 ${startPos}..${pos}`,
            });
            return true;
          }
          if (!best || pos > best.end) best = { end: pos, caps: new Map(caps) };
          record({
            kind: 'accept-here', pos, start: startPos, end: pos, nodeId: ast.id,
            caps: snapshot(caps),
            message: `位置 ${startPos}..${pos} 可接受；贪婪策略继续回溯搜索更长匹配`,
          });
          goal = FAIL;
          continue;
        }

        const f = k[k.length - 1];
        if (f.t === 's') {
          if (f.i < f.items.length) {
            goal = f.items[f.i];
            f.i += 1;
          } else k.pop();
        } else if (f.t === 'm') {
          f.i += 1;
          if (f.i < f.min) {
            goal = f.atom;
          } else {
            // 必选副本完成：在当前延续之上激活第一个量词决策点
            k.pop();
            activateQuantLayer(f.node, pos, caps, {
              iterBefore: f.node.min, forced: false, below: k.slice(),
            });
          }
        } else if (f.t === 'g') {
          k.pop();
          const next = new Map(caps);
          next.set(f.index, { start: f.start, end: pos, name: f.name });
          caps = next;
          record({
            kind: 'group-close', pos, nodeId: f.nodeId, group: f.index, name: f.name,
            caps: snapshot(caps),
            message: `捕获组 #${f.index}${f.name ? `（${f.name}）` : ''} 闭合：抓到 "${chars.slice(f.start, pos).join('')}" [${f.start},${pos})，压入捕获栈`,
          });
        } else if (f.t === 'b') {
          // 某分支成功：分叉转哨兵，成功继续向 below 传播
          f.sentinel = true;
          goal = null;
        } else if (f.t === 'q') {
          // 重复体成功，登记结束快照，按贪婪/懒惰安排首选
          const advanced = pos > f.startPos;
          f.endPos = pos;
          f.endCaps = new Map(caps);
          f.advanced = advanced;
          f.canContinue = advanced && (f.node.max === Infinity || f.iterBefore + 1 < f.node.max);
          const lazy = isLazyNode(f.node, globalLazy);
          goal = null;

          if (f.forced) {
            // 被迫消费的副本：成功后作为新的懒惰决策点——先结束
            f.forced = false;
            f.sentinel = true;
            f.exitTried = true; // “结束”即当前首选
            record({
              kind: 'quant-choice', pos, nodeId: f.nodeId, choice: 'exit', caps: snapshot(caps),
              message: `被迫消费成功：懒惰量词在位置 ${pos} 先结束（第 ${f.iterBefore + 1} 次重复），不行再继续`,
            });
          } else if (lazy) {
            // 懒惰首选“结束”：转哨兵，成功沿 below 继续；失败时再扩张
            f.sentinel = true;
            f.exitTried = true;
            record({
              kind: 'quant-choice', pos, nodeId: f.nodeId, choice: 'exit', caps: snapshot(caps),
              message: `懒惰量词在位置 ${pos} 先结束（已重复 ${f.iterBefore + 1} 次），跑后续；“再来一个副本”保留为回溯点`,
            });
          } else if (f.canContinue) {
            // 贪婪首选“继续扩张”：本层转哨兵（保留结束备选），上方压入
            // 下一层决策点
            f.sentinel = true;
            f.continueTried = true;
            activateQuantLayer(f.node, pos, caps, {
              iterBefore: f.iterBefore + 1, forced: false, below: [...f.below, f],
            });
          } else {
            // 贪婪但无法再扩张（有界到顶 / 零宽）：直接结束
            f.sentinel = true;
            f.exitTried = true;
            record({
              kind: 'quant-choice', pos, nodeId: f.nodeId, choice: 'exit', caps: snapshot(caps),
              message: `量词在位置 ${pos} 结束（已达重复上界或零宽）`,
            });
          }
        }
        continue;
      }

      // ============ 展开/求值当前目标 ============
      const node = goal;
      goal = null;
      visitedNodes.add(node.id);

      switch (node.type) {
        case 'char':
        case 'charClass': {
          transitions += 1;
          if (pos >= len) {
            record({ kind: 'char-eof', pos, nodeId: node.id, caps: snapshot(caps), message: '需要再消费一个字符，但输入已经结束，此路不通' });
            goal = FAIL;
            break;
          }
          const cp = chars[pos].codePointAt(0);
          const ok = node.set.length > 0 && node.set.some(([lo, hi]) => cp >= lo && cp < hi);
          record(ok
            ? { kind: 'char-match', pos, char: chars[pos], nodeId: node.id, caps: snapshot(caps), message: `字符 "${chars[pos]}" 匹配${node.type === 'charClass' ? '字符类' : '字面量'}，位置前进到 ${pos + 1}` }
            : { kind: 'char-fail', pos, char: chars[pos], nodeId: node.id, caps: snapshot(caps), message: `字符 "${chars[pos]}" 不匹配该字符类，此路不通，触发回溯` });
          if (ok) pos += 1;
          else goal = FAIL;
          break;
        }

        case 'anchor': {
          transitions += 1;
          const ok = node.dir === 'start' ? pos === 0 : pos === len;
          record(ok
            ? { kind: 'anchor-pass', pos, nodeId: node.id, caps: snapshot(caps), message: `锚点 ${node.dir === 'start' ? '^' : '$'} 在位置 ${pos} 成立，零宽通过` }
            : { kind: 'anchor-fail', pos, nodeId: node.id, caps: snapshot(caps), message: `锚点 ${node.dir === 'start' ? '^' : '$'} 在位置 ${pos} 不成立（${node.dir === 'start' ? '不是串首' : '不是串尾'}），此路不通` });
          if (!ok) goal = FAIL;
          break;
        }

        case 'backref': {
          transitions += 1;
          const cap = caps.get(node.group);
          const syntax = node.name ? `\\k<${node.name}>` : `\\${node.group}`;
          if (!cap || cap.end === null) {
            // 约定：被引用组在当前路径里尚未捕获（分支没走到 / 未闭合），
            // 本次比对按失败处理（PCRE 同惯例：未参与匹配的组反向引用必败）。
            // 组参与过匹配且抓到空串属于“已捕获”，空串比对成功。
            record({
              kind: 'backref-unmatched', pos, nodeId: node.id, group: node.group,
              name: node.name, syntax, caps: snapshot(caps),
              message: `反向引用 ${syntax}（第 ${node.group} 组）在当前路径的捕获栈里没有已闭合的内容（该组位于没走到的分支或尚未闭合）：按约定本次比对失败，触发回溯`,
            });
            goal = FAIL;
            break;
          }
          const wanted = chars.slice(cap.start, cap.end);
          const wlen = wanted.length;
          let mismatchAt = -1;
          if (pos + wlen > len) mismatchAt = len - pos;
          else {
            for (let j = 0; j < wlen; j += 1) {
              if (chars[pos + j] !== wanted[j]) { mismatchAt = j; break; }
            }
          }
          if (mismatchAt === -1) {
            record({
              kind: 'backref-compare', pos, nodeId: node.id, group: node.group,
              name: node.name, syntax, captured: wanted.join(''), length: wlen, caps: snapshot(caps),
              message: `从捕获栈取第 ${node.group} 组的内容 "${wanted.join('')}" 与位置 ${pos}..${pos + wlen} 逐字符比对：全部相同，位置前进到 ${pos + wlen}（这是“记忆比对”，不是字符类转移）`,
            });
            pos += wlen;
          } else {
            record({
              kind: 'backref-fail', pos, nodeId: node.id, group: node.group,
              name: node.name, syntax, captured: wanted.join(''),
              actual: chars.slice(pos, Math.min(len, pos + wlen)).join(''),
              mismatchOffset: mismatchAt, caps: snapshot(caps),
              message: `从捕获栈取第 ${node.group} 组的内容 "${wanted.join('')}" 逐字符比对：第 ${mismatchAt + 1} 个字符不同（要求 "${wanted[mismatchAt] ?? '∅'}"，实际 "${chars[pos + mismatchAt] ?? '∅'}"），此路不通，触发回溯`,
            });
            goal = FAIL;
          }
          break;
        }

        case 'epsilon':
          goal = null;
          break;

        case 'concat': {
          if (node.items.length === 0) { goal = null; break; }
          k.push({ t: 's', items: node.items, i: 1 });
          goal = node.items[0];
          break;
        }

        case 'alternation': {
          if (node.branches.length === 0) { goal = null; break; }
          const below = k.slice();
          k.push({
            t: 'b', node, nodeId: node.id,
            branches: node.branches, n: 1,
            pos, caps: new Map(caps),
            below, sentinel: false,
          });
          goal = node.branches[0];
          record({
            kind: 'alt-try', pos, nodeId: node.id, branch: 0, caps: snapshot(caps),
            message: `选择分支：先试第 1 / ${node.branches.length} 个分支（其余分支保留为回溯点，捕获栈与后续延续已存快照）`,
          });
          break;
        }

        case 'group': {
          if (!node.capture) { goal = node.body; break; }
          const next = new Map(caps);
          next.set(node.index, { start: pos, end: null, name: node.name ?? null });
          caps = next;
          k.push({ t: 'g', nodeId: node.id, index: node.index, name: node.name ?? null, start: pos });
          goal = node.body;
          record({
            kind: 'group-open', pos, nodeId: node.id, group: node.index, name: node.name, caps: snapshot(caps),
            message: `捕获组 #${node.index}${node.name ? `（${node.name}）` : ''} 开始，记录起点 ${pos}`,
          });
          break;
        }

        case 'repeat': {
          // min 个必选副本用 m 延续，完成后激活第一个量词决策点
          if (node.min > 0) {
            k.push({ t: 'm', node, atom: node.atom, i: 0, min: node.min });
            goal = node.atom;
          } else {
            activateQuantLayer(node, pos, caps, { iterBefore: 0, forced: false, below: k.slice() });
          }
          break;
        }

        default:
          throw new Error(`AST 回溯引擎遇到未知节点类型：${node.type}`);
      }
    }

    /**
     * 压入一个量词决策点：在 atPos 处“是否再消费一个重复体”。
     *   iterBefore : 进入前已确定的重复次数
     *   forced     : 懒惰被迫扩张的副本——不能零宽结束，必须消费成功
     *   below      : 该决策点下方的“量词之后延续栈”快照
     */
    function activateQuantLayer(node, atPos, atCaps, { iterBefore, forced, below }) {
      const lazy = isLazyNode(node, globalLazy);
      const canExit = !forced; // 强制层 / 必选层之外才允许零宽结束
      const frame = {
        t: 'q',
        node,
        nodeId: node.id,
        iterBefore,
        forced: !!forced,
        canExit,
        canContinue: false, // 重复体成功后按实际推进与上界重算
        startPos: atPos,
        startCaps: new Map(atCaps),
        endPos: atPos,
        endCaps: new Map(atCaps),
        exitTried: false,
        continueTried: false,
        sentinel: false,
        below: cloneStack(below),
      };
      k.push(frame);
      pos = atPos;
      caps = new Map(atCaps);
      if (forced) {
        goal = node.atom;
        record({
          kind: 'quant-choice', pos: atPos, nodeId: node.id, choice: 'continue', caps: snapshot(caps),
          message: `懒惰被迫消费第 ${iterBefore + 1} 个副本（本层没有零宽跳过备选）`,
        });
      } else if (lazy) {
        // 懒惰先零宽结束：直接把决策点转哨兵并跑 below
        frame.sentinel = true;
        frame.exitTried = true;
        goal = null;
        record({
          kind: 'quant-choice', pos: atPos, nodeId: node.id, choice: 'exit', caps: snapshot(caps),
          message: `懒惰量词在位置 ${atPos} 先试“结束”（已重复 ${iterBefore} 次），“再来一个副本”保留为回溯点`,
        });
      } else {
        // 贪婪先消费一个副本（除已达上界的情形，必选层 max≥min+? 由 m 保证）
        if (node.max === Infinity || iterBefore < node.max) {
          goal = node.atom;
          record({
            kind: 'quant-choice', pos: atPos, nodeId: node.id, choice: 'continue', caps: snapshot(caps),
            message: `贪婪量词在位置 ${atPos} 先试“再来一个副本”（第 ${iterBefore + 1} 次），“结束”保留为回溯点`,
          });
        } else {
          frame.sentinel = true;
          frame.exitTried = true;
          goal = null;
        }
      }
    }
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
      visitedStates: visitedNodes.size,
      frameCount: frames.length,
      inputLength: len,
      capped,
      abortReason,
    },
  };
}

function finalizeCaps(caps, groups) {
  const out = {};
  caps.forEach((c, group) => {
    if (c.end === null) return;
    out[group] = { start: c.start, end: c.end, name: c.name ?? groups[group - 1]?.name ?? null };
  });
  return out;
}
