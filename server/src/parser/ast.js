// ast.js
// AST 节点结构。每个节点都带源码区间 [pos, end)，供前端悬停联动高亮。

let nextId = 0;
export function resetNodeIds() {
  nextId = 0;
}
function nid() {
  return nextId += 1;
}

export function makeNode(type, pos, end, extra = {}) {
  return { id: nid(), type, pos, end, ...extra };
}
