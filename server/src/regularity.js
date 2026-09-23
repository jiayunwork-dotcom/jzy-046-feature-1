// regularity.js
// 判定一条已解析的模式是否还落在“正则语言”范围内——即能否用有限状态机
// （NFA/DFA）表示。目前唯一的越界特性是反向引用：它要求后续文本与某个
// 捕获组先前抓到的文本逐字符相同，状态机没有记忆，无法表达这种相等约束，
// 只有带捕获栈的回溯引擎才能处理。

/** 深度优先遍历 AST */
export function walkAST(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  switch (node.type) {
    case 'pattern':
      walkAST(node.body, fn);
      break;
    case 'concat':
      node.items.forEach((c) => walkAST(c, fn));
      break;
    case 'alternation':
      node.branches.forEach((b) => walkAST(b, fn));
      break;
    case 'repeat':
      walkAST(node.atom, fn);
      break;
    case 'group':
      walkAST(node.body, fn);
      break;
    default:
      break;
  }
}

/** 收集模式中的全部反向引用节点 */
export function findBackrefs(ast) {
  const found = [];
  walkAST(ast, (n) => {
    if (n.type === 'backref') found.push(n);
  });
  return found;
}

export function hasBackrefs(ast) {
  return findBackrefs(ast).length > 0;
}

/** 含反向引用时尝试走有限自动机构造所抛的错误（界面据此展示“不可确定化”） */
export class NonRegularPatternError extends Error {
  constructor(backrefs, source = '') {
    const lead = backrefs[0];
    const label = lead.name ? `\\k<${lead.name}>` : `\\${lead.group}`;
    super(
      `该模式含有反向引用（位置 ${lead.pos}..${lead.end} 的 ${label} 指向第 ${lead.group} 个捕获组），` +
      '它要求后续文本与该组先前捕获的内容逐字符相同——这不是正则语言，有限状态机没有记忆，' +
      '无法构造等价的 NFA/DFA，只能使用带捕获栈的回溯引擎匹配。'
    );
    this.name = 'NonRegularPatternError';
    this.backrefs = backrefs.map((b) => ({
      pos: b.pos,
      end: b.end,
      group: b.group,
      name: b.name ?? null,
      source: source.slice(b.pos, b.end),
    }));
  }
}

/** 有限自动机构造前的硬门：含反向引用直接拒绝，绝不静默构造语义错误的图 */
export function assertFSMRepresentable(ast, source = '') {
  const refs = findBackrefs(ast);
  if (refs.length) throw new NonRegularPatternError(refs, source);
}

/** 生成给界面/接口用的说明结构 */
export function nonRegularInfo(ast, source = '') {
  const refs = findBackrefs(ast);
  const groups = ast.groups || [];
  return {
    nonRegular: true,
    reason: 'backreference',
    message:
      '该模式含有反向引用：它要求一段文本与某个捕获组先前抓到的内容完全相同。' +
      '相等约束依赖“先前抓到了什么”的记忆，而有限状态机只认当前状态、没有存储，' +
      '因此 NFA、子集构造 DFA、DFA 最小化均不适用，只能走带捕获栈的回溯引擎。',
    backrefs: refs.map((b) => {
      const g = groups[b.group - 1] || {};
      return {
        pos: b.pos,
        end: b.end,
        group: b.group,
        name: b.name ?? null,
        syntax: b.name ? `\\k<${b.name}>` : `\\${b.group}`,
        targetName: g.name ?? null,
      };
    }),
    source,
  };
}
