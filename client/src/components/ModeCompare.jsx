// ModeCompare.jsx
// 贪婪 vs 懒惰并排对比：同一条正则、同一个测试串，左右同步播放两套回溯轨迹。

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../state/api.js';
import MatchPlayer from './MatchPlayer.jsx';

export default function ModeCompare({ pattern, input, nfaGreedy, nfaLazy, blocked }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErr(null);
    api
      .compareModes(pattern, input)
      .then((res) => { if (!cancel) setData(res); })
      .catch((e) => { if (!cancel) setErr(e.message); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [pattern, input]);

  if (loading) return <div className="panel-empty">计算贪婪 / 懒惰两条轨迹…</div>;
  if (err) return <div className="panel-empty warn">{err}</div>;
  if (!data) return null;

  const kind = blocked ? 'backtracking-ref' : 'backtracking';
  return (
    <div className="mode-compare">
      <div className="compare-col">
        <div className="compare-head greedy">贪婪（greedy）</div>
        <MatchPlayer
          graph={nfaGreedy}
          kind={kind}
          frames={data.greedy.frames}
          metrics={data.greedy.metrics}
          input={input}
          result={data.greedy.result}
          engineLabel={blocked ? '回溯引擎（AST 直接匹配）· 贪婪' : '回溯引擎 · 贪婪'}
          height={360}
        />
      </div>
      <div className="compare-col">
        <div className="compare-head lazy">懒惰（lazy）</div>
        <MatchPlayer
          graph={nfaLazy}
          kind={kind}
          frames={data.lazy.frames}
          metrics={data.lazy.metrics}
          input={input}
          result={data.lazy.result}
          engineLabel={blocked ? '回溯引擎（AST 直接匹配）· 懒惰' : '回溯引擎 · 懒惰'}
          height={360}
        />
      </div>
    </div>
  );
}
