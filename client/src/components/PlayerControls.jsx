// PlayerControls.jsx —— 通用播放控制：播放/暂停/单步前进后退/进度条/倍速/跳到结尾

import React from 'react';

export default function PlayerControls({
  idx,
  total,
  playing,
  speed,
  onPlay,
  onPause,
  onStep,
  onSeek,
  onSpeed,
  onFinish,
}) {
  const atEnd = idx >= total - 1;
  return (
    <div className="player-controls">
      <button className="btn" onClick={() => onStep(-1)} disabled={idx === 0} title="单步后退">⏮</button>
      {playing ? (
        <button className="btn primary" onClick={onPause}>⏸ 暂停</button>
      ) : (
        <button className="btn primary" onClick={() => { if (atEnd) onSeek(0); onPlay(); }}>▶ 播放</button>
      )}
      <button className="btn" onClick={() => onStep(1)} disabled={atEnd} title="单步前进">⏭</button>
      <button className="btn" onClick={onFinish} title="直接构造完 / 跳到结尾">⏩</button>
      <input
        type="range"
        min={0}
        max={Math.max(0, total - 1)}
        value={idx}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="seek"
      />
      <span className="frame-count">{idx + 1}/{total}</span>
      <label className="speed-label">
        倍速
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
          <option value={8}>8×</option>
        </select>
      </label>
    </div>
  );
}
