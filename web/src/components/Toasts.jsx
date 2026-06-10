import React from 'react';

/** SSE 实时事件的右下角弹出提醒,由 App 管理 toasts 状态 */
export default function Toasts({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone || ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
