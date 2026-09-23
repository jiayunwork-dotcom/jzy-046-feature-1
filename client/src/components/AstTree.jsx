// AstTree.jsx
// 侧边栏：可展开的 AST 树。悬停节点时通过 onHover(pos,end) 通知正则输入框
// 高亮对应源码片段；叶子节点展示字符集/区间等细节。

import React, { useState } from 'react';

const TYPE_LABEL = {
  pattern: 'Pattern 正则',
  concat: 'Concat 连接',
  alternation: 'Alternation 选择 |',
  repeat: 'Repeat 量词',
  group: 'Group 分组',
  char: 'Char 字面字符',
  charClass: 'CharClass 字符类',
  anchor: 'Anchor 锚点',
  backref: 'Backref 反向引用',
  epsilon: 'ε 空',
};

function describeLeaf(node) {
  if (node.type === 'char') {
    return `"${String.fromCodePoint(node.cp > 0xffff ? node.cp : node.cp)}"`;
  }
  if (node.type === 'charClass') {
    if (node.dot) return '. 任意非换行';
    if (node.builtin) {
      const name = `\\${node.negated ? node.builtin.toUpperCase() : node.builtin}`;
      return `${name}${node.negated ? '（取反）' : ''}`;
    }
    return `[${node.negated ? '^' : ''}…] ${node.set.length} 段区间`;
  }
  if (node.type === 'anchor') return node.dir === 'start' ? '^ 行首' : '$ 行尾';
  if (node.type === 'backref') {
    return node.refType === 'name' ? `\\k<${node.refValue}>` : `\\${node.refValue}`;
  }
  if (node.type === 'epsilon') return '空分支';
  return null;
}

function quantifierText(node) {
  const { kind, min, max, greedy } = node;
  let sym;
  if (kind === '*') sym = '*';
  else if (kind === '+') sym = '+';
  else if (kind === '?') sym = '?';
  else sym = max === Infinity ? `{${min},}` : min === max ? `{${min}}` : `{${min},${max}}`;
  return `${sym} ${greedy ? '贪婪' : '懒惰'}`;
}

export default function AstTree({ ast, hoverId, setHoverId, onHoverSpan }) {
  if (!ast) return <div className="muted">解析成功后这里显示 AST</div>;
  return (
    <div className="ast-tree">
      <NodeView node={ast} depth={0} hoverId={hoverId} setHoverId={setHoverId} onHoverSpan={onHoverSpan} defaultOpen />
    </div>
  );
}

function NodeView({ node, depth, hoverId, setHoverId, onHoverSpan, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen || depth < 2);
  const children = childNodes(node);
  const hasChildren = children.length > 0;
  const hovered = hoverId === node.id;

  return (
    <div className="ast-node-wrap">
      <div
        className={`ast-node ${hovered ? 'hover' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onMouseEnter={() => { setHoverId(node.id); onHoverSpan?.({ pos: node.pos, end: node.end }); }}
        onMouseLeave={() => { setHoverId(null); onHoverSpan?.(null); }}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        <span className="twist">{hasChildren ? (open ? '▾' : '▸') : '·'}</span>
        <span className="ast-type">{TYPE_LABEL[node.type] || node.type}</span>
        {node.type === 'repeat' && <span className="ast-badge">{quantifierText(node)}</span>}
        {node.type === 'group' && (
          <span className="ast-badge">
            {node.capture ? `捕获 #${node.index}${node.name ? ` ${node.name}` : ''}` : '非捕获'}
          </span>
        )}
        {node.type === 'backref' && (
          <span className="ast-badge backref-badge">
            {node.refType === 'name' ? `→ 组 ${node.name ? `#${node.index} ` : ''}"${node.refValue}"` : `→ 组 #${node.index ?? '?'}`}
          </span>
        )}
        {node.type === 'alternation' && <span className="ast-badge">{node.branches.length} 分支</span>}
        {describeLeaf(node) && <span className="ast-leaf">{describeLeaf(node)}</span>}
        <span className="ast-pos">[{node.pos},{node.end})</span>
      </div>
      {hasChildren && open && (
        <div>
          {children.map((c) => (
            <NodeView
              key={c.id}
              node={c}
              depth={depth + 1}
              hoverId={hoverId}
              setHoverId={setHoverId}
              onHoverSpan={onHoverSpan}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function childNodes(node) {
  switch (node.type) {
    case 'pattern': return [node.body];
    case 'concat': return node.items;
    case 'alternation': return node.branches;
    case 'repeat': return [node.atom];
    case 'group': return [node.body];
    default: return [];
  }
}
