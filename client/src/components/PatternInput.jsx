// PatternInput.jsx
// 正则输入框：实时解析（防抖），出错在出错位置画定位标记并说明原因；
// 悬停 AST 节点时，输入框中对应源码片段反向高亮。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../state/api.js';

export default function PatternInput({
  pattern,
  setPattern,
  onAst,
  hoverSpan,
  setHoverAstId,
}) {
  const [error, setError] = useState(null);
  const [parsing, setParsing] = useState(false);
  const tick = useRef(null);

  useEffect(() => {
    clearTimeout(tick.current);
    tick.current = setTimeout(async () => {
      try {
        setParsing(true);
        const res = await api.parse(pattern);
        setError(null);
        onAst(res.ast, res.groupCount);
      } catch (err) {
        setError(err.payload?.position !== undefined ? {
          message: err.message,
          position: err.payload.position,
          length: err.payload.length || 1,
        } : { message: err.message, position: null, length: 1 });
        onAst(null);
      } finally {
        setParsing(false);
      }
    }, 160);
    return () => clearTimeout(tick.current);
  }, [pattern]); // eslint-disable-line react-hooks/exhaustive-deps

  const chars = useMemo(() => Array.from(pattern), [pattern]);
  const errPos = error?.position;

  return (
    <div className="pattern-input-area">
      <div className={`pattern-box ${error ? 'has-error' : ''}`}>
        <span className="prompt">/</span>
        <div className="pattern-track" ref={(el) => { el?.setAttribute('data-track', '1'); }}>
          {chars.map((c, i) => {
            let cls = 'pch';
            if (hoverSpan && i >= hoverSpan.pos && i < hoverSpan.end) cls += ' hover-span';
            if (errPos !== null && errPos !== undefined && i === errPos) cls += ' err-ch';
            return <span key={i} className={cls} onMouseEnter={() => {}}>{c}</span>;
          })}
          {errPos !== null && errPos !== undefined && errPos >= chars.length && <span className="err-caret">▏</span>}
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="hidden-input"
            aria-label="正则表达式输入"
          />
        </div>
        <span className="prompt">/g</span>
      </div>

      {/* 位置标尺 + 错误标记 */}
      <div className="ruler">
        {chars.map((_, i) => (
          <span key={i} className={`ruler-tick ${errPos === i ? 'err' : ''}`} />
        ))}
      </div>

      {error ? (
        <div className="error-pop" style={errPos !== null ? { '--err-pos': `${Math.min(errPos, chars.length)}ch` } : undefined}>
          <span className="err-marker" style={{ marginLeft: `calc(28px + ${Math.min(errPos ?? 0, chars.length)} * 8.4px)` }}>
            ▲
          </span>
          <div className="err-msg">
            <b>语法错误</b>（位置 {errPos ?? '?'}）：{error.message}
          </div>
        </div>
      ) : (
        <div className="parse-ok muted">{parsing ? '解析中…' : '语法正确 ✓ 已生成 AST'}</div>
      )}
    </div>
  );
}
