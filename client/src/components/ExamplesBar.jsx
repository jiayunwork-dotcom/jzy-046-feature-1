// ExamplesBar.jsx —— 内置教学案例：载入正则/测试串，并展示分步讲解。

import React, { useEffect, useState } from 'react';
import { api } from '../state/api.js';

export default function ExamplesBar({ onLoad }) {
  const [examples, setExamples] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    api.examples().then((res) => setExamples(res.examples)).catch(() => {});
  }, []);

  const toggle = async (id) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    const res = await api.example(id);
    setDetail(res.example);
  };

  return (
    <div className="examples-bar">
      <div className="examples-title">教学案例</div>
      <div className="example-chips">
        {examples.map((ex) => (
          <button
            key={ex.id}
            className={`chip ${openId === ex.id ? 'active' : ''}`}
            onClick={() => toggle(ex.id)}
            title={ex.pattern}
          >
            {ex.name}
          </button>
        ))}
      </div>
      {detail && (
        <div className="example-detail">
          <div className="example-pattern"><code>{detail.pattern}</code></div>
          {detail.sections.map((sec, i) => (
            <div key={i} className="example-section">
              <div className="section-title">{sec.title}</div>
              <ul>
                {sec.bullets.map((b, j) => <li key={j}>{b}</li>)}
              </ul>
            </div>
          ))}
          <div className="example-actions">
            <button
              className="btn primary"
              onClick={() => onLoad({
                pattern: detail.pattern,
                test: detail.test,
                patternLazy: detail.patternLazy,
              })}
            >
              载入并演示
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
