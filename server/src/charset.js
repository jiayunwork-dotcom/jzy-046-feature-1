// charset.js
// 字符集合：用互不相交、已排序的区间表示 BMP（U+0000..U+FFFF）上的字符集。
// 区间采用半开 [lo, hi)，方便合并与取反。这是 NFA 转移标注、DFA 字母表
// （minterm 划分）和匹配判定的共同基础。

export const MIN_CP = 0x0000;
export const MAX_CP = 0xffff; // BMP 上界（半开）

// 预定义类对应的区间
const DIGIT = [[0x30, 0x3a]]; // 0-9
const WORD = [
  [0x30, 0x3a], // 0-9
  [0x41, 0x5b], // A-Z
  [0x5f, 0x60], // _
  [0x61, 0x7b], // a-z
];
const SPACE = [
  [0x09, 0x0e], // \t \n \v \f \r
  [0x20, 0x21], // space
  [0xa0, 0xa1], // NBSP
  [0x1680, 0x1681],
  [0x2000, 0x200b],
  [0x2028, 0x202a],
  [0x202f, 0x2030],
  [0x205f, 0x2060],
  [0x3000, 0x3001],
  [0xfeff, 0xff00],
];

/** 合并重叠/相邻区间 */
export function normalize(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter(([lo, hi]) => hi > lo)
    .map(([lo, hi]) => [Math.max(MIN_CP, lo), Math.min(MAX_CP, hi)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

export function fromRanges(intervals) {
  return normalize(intervals);
}

export function singleton(cp) {
  return [[cp, cp + 1]];
}

export function builtinSet(name) {
  if (name === 'd') return DIGIT.map((r) => [...r]);
  if (name === 'w') return WORD.map((r) => [...r]);
  if (name === 's') return SPACE.map((r) => [...r]);
  throw new Error(`unknown builtin class \\${name}`);
}

export function complement(intervals) {
  const set = normalize(intervals);
  const out = [];
  let cursor = MIN_CP;
  for (const [lo, hi] of set) {
    if (lo > cursor) out.push([cursor, lo]);
    cursor = hi;
  }
  if (cursor < MAX_CP) out.push([cursor, MAX_CP]);
  return out;
}

export function negate(intervals) {
  return complement(intervals);
}

export function union(a, b) {
  return normalize([...a, ...b]);
}

export function intersects(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][0] < b[j][1] && b[j][0] < a[i][1]) return true;
    if (a[i][1] <= b[j][1]) i += 1;
    else j += 1;
  }
  return false;
}

export function contains(intervals, cp) {
  // 区间有序，二分查找
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = intervals[mid];
    if (cp < a) hi = mid - 1;
    else if (cp >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

export function isEmpty(intervals) {
  return intervals.length === 0;
}

/** 在区间集中任取一个码点（minterm 代表元用） */
export function representative(intervals) {
  if (intervals.length === 0) return null;
  return intervals[0][0];
}

/**
 * 对若干字符集做布尔划分（minterm 划分）。
 * 返回每个原子区间以及它分别属于哪些输入集合的位掩码。
 */
export function partition(sets) {
  const points = new Set([MIN_CP, MAX_CP]);
  for (const set of sets) {
    for (const [lo, hi] of set) {
      points.add(lo);
      points.add(hi);
    }
  }
  const cuts = [...points].sort((a, b) => a - b);
  const atoms = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const lo = cuts[i];
    const hi = cuts[i + 1];
    if (lo === hi) continue;
    const cp = lo;
    let mask = 0;
    sets.forEach((set, idx) => {
      if (contains(set, cp)) mask |= 1 << idx;
    });
    atoms.push({ lo, hi, mask });
  }
  return atoms;
}

// ---------- 展示用 ----------

const SPECIAL_CHAR_LABELS = {
  0x09: '\\t',
  0x0a: '\\n',
  0x0d: '\\r',
  0x20: '␠',
};

export function formatCodePoint(cp) {
  if (cp in SPECIAL_CHAR_LABELS) return SPECIAL_CHAR_LABELS[cp];
  if (cp < 0x20 || cp === 0x7f) return `\\x${cp.toString(16).padStart(2, '0')}`;
  return String.fromCodePoint(cp);
}

function rangeLabel(lo, hi) {
  if (hi - lo === 1) return formatCodePoint(lo);
  return `${formatCodePoint(lo)}-${formatCodePoint(hi - 1)}`;
}

export function describe(intervals, { negate = false } = {}) {
  const prefix = negate ? '^' : '';
  const body = intervals.length === 0 ? '∅' : intervals.map(([lo, hi]) => rangeLabel(lo, hi)).join('');
  return `${prefix}${body}`;
}

/** 给转移边做短标注：单字符直接显示，否则显示区间或类名简写 */
export function edgeLabel(intervals, named = null) {
  if (named) return named;
  if (intervals.length === 1 && intervals[0][1] - intervals[0][0] === 1) {
    return formatCodePoint(intervals[0][0]);
  }
  const desc = describe(intervals);
  return desc.length > 8 ? `${desc.slice(0, 7)}…` : desc;
}
