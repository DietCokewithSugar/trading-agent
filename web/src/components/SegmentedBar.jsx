import React from 'react';

/**
 * Nothing 风格分段进度条:N 段定宽方块,填充表示比例。
 * 纯展示,配色全部走 styles.css 的 CSS 变量(.segbar*),不在此散写色值。
 *
 * props:
 *  - value: 数值(配合 max 计算填充比例)
 *  - max: 满量程(默认 100)
 *  - segments: 段数(默认 10)
 *  - tone: 'up' | 'down' | 'neutral'(默认 neutral)—— 决定填充色取盈亏色还是中性色
 *  - label: 顶部 ALL-CAPS 标签(可选)
 *  - valueText: 右侧数值文本(可选,等宽显示)
 */
export default function SegmentedBar({
  value,
  max = 100,
  segments = 10,
  tone = 'neutral',
  label,
  valueText,
}) {
  const ratio = Number.isFinite(value) && max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const filled = Math.round(ratio * segments);

  return (
    <div className={`segbar segbar--${tone}`}>
      {(label || valueText !== undefined) && (
        <div className="segbar__head">
          {label && <span className="label-caps">{label}</span>}
          {valueText !== undefined && <span className="num segbar__value">{valueText}</span>}
        </div>
      )}
      <div className="segbar__track" role="meter" aria-valuenow={value} aria-valuemax={max}>
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={`segbar__seg${i < filled ? ' is-filled' : ''}`} />
        ))}
      </div>
    </div>
  );
}
