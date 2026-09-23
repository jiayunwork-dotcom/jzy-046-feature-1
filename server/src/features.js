// features.js
// 对 AST 做整树扫描，回答一个关键问题：模式里有没有反向引用？
// 反向引用（\N / \k<name>）要求“接下来这段必须等于之前捕获的文本”，
// 这种“带记忆的相等比较”不是正则语言，NFA/DFA 无法表达；流水线据此
// 把自动机构造阶段标记为“不可确定化”，只允许回溯引擎执行。

export const CHILD_KEYS = {
  pattern: ['body'],
  concat: ['items'],
  alternation: ['branches'],
  repeat: ['atom'],
  group: ['body'],
  char: [],
  charClass: [],
  anchor: [],
  epsilon: [],
  backref: [],
};

/** 深度优先遍历 AST（先序），对每个节点调用 fn(node, parent) */
export function walkAst(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  fn(node, parent);
  for (const key of CHILD_KEYS[node.type] || []) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((c) => walkAst(c, fn, node));
    } else if (child) {
      walkAst(child, fn, node);
    }
  }
}

/** 收集全部反向引用节点（按源码位置排序） */
export function collectBackrefs(ast) {
  const refs = [];
  walkAst(ast, (node) => {
    if (node.type === 'backref') refs.push(node);
  });
  refs.sort((a, b) => a.pos - b.pos);
  return refs;
}

export function hasBackreferences(ast) {
  let found = false;
  walkAst(ast, (node) => {
    if (node.type === 'backref') found = true;
  });
  return found;
}

/** 反向引用的展示写法（用于错误与界面提示） */
export function formatBackref(node) {
  return node.refType === 'name' ? `\\k<${node.refValue}>` : `\\${node.refValue}`;
}
