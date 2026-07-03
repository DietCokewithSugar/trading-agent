import React, { useEffect, useRef, useState } from 'react';

/**
 * 数值变动闪烁:升→绿染、降→红染,~0.8s 渐回原色(styles.css .flash-up/.flash-down)。
 * 只比较数值:首次挂载与 null/NaN 进出都不闪;key 换值强制重挂载 span,
 * 连续快速变动每次都完整重播动画。className 透传保住 .num 等宽排版。
 * 约束:所在列表需稳定 rowKey,组件实例才能跨推送 tick 保住上一数值。
 */
export default function FlashOnChange({ value, className = '', style, children }) {
  const prev = useRef(null);
  const [flash, setFlash] = useState(null); // { dir: 'up' | 'down', seq }

  useEffect(() => {
    const v = Number(value);
    if (!Number.isFinite(v)) {
      prev.current = null;
      return;
    }
    const p = prev.current;
    prev.current = v;
    if (p === null || v === p) return;
    setFlash((f) => ({ dir: v > p ? 'up' : 'down', seq: (f?.seq || 0) + 1 }));
  }, [value]);

  return (
    <span
      key={flash?.seq ?? 0}
      className={`${className} ${flash ? `flash-${flash.dir}` : ''}`.trim()}
      style={style}
    >
      {children ?? value}
    </span>
  );
}
