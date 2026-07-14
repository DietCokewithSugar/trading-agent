import React, { useMemo } from 'react';
import { Tooltip } from 'antd';
import { REGIME_LABELS } from '../api.js';

// 与 NewsHeatmap 相同的周列网格约定:日期串按 UTC 零点解析,避免本地时区/夏令时影响对齐
function parseUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}
function fmtUTC(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 纯函数:某日的 regime/风险分 → 分歧色阶编码。
 * 好(risk_on/正分)= 绿,差(risk_off/shock/负分)= 红,0 分或无事件 = 中性灰;
 * 强度按 |risk_score| 对齐聚合阈值:≥0.30(进入阈)最深,≥0.15 中档,>0 浅档;
 * macro_shock 恒为最深红(硬风控锁定,不看分数)。
 */
export function cellEncoding({ regime, risk_score } = {}) {
  if (regime === 'macro_shock') return { tone: 'down', level: 3 };
  const score = Number(risk_score) || 0;
  if (score === 0) return { tone: null, level: 0 };
  const tone = score > 0 ? 'up' : 'down';
  const abs = Math.abs(score);
  const level = abs >= 0.3 ? 3 : abs >= 0.15 ? 2 : 1;
  return { tone, level };
}

/** 把逐日序列摆进 GitHub 风格周列网格(起点对齐周日,窗口外/未来为占位) */
function buildWeeks(days, todayEt) {
  if (!days?.length) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const firstD = parseUTC(days[0].date);
  const lastKey = days[days.length - 1].date;
  const lastD = parseUTC(todayEt > lastKey ? todayEt : lastKey);
  const start = addDays(firstD, -firstD.getUTCDay());
  const end = addDays(lastD, 6 - lastD.getUTCDay());

  const weeks = [];
  let prevMonth = null;
  for (let col = new Date(start); col <= end; col = addDays(col, 7)) {
    const cells = [];
    let monthLabel = null;
    for (let row = 0; row < 7; row += 1) {
      const cur = addDays(col, row);
      const ds = fmtUTC(cur);
      const day = byDate.get(ds);
      if (!day || ds > todayEt) {
        cells.push({ ds, placeholder: true });
        continue;
      }
      cells.push({ ds, day, placeholder: false });
      if (monthLabel === null) {
        const m = cur.getUTCMonth() + 1;
        if (m !== prevMonth) {
          monthLabel = `${m}月`;
          prevMonth = m;
        } else {
          monthLabel = '';
        }
      }
    }
    weeks.push({ key: fmtUTC(col), month: monthLabel || '', cells });
  }
  return weeks;
}

/**
 * 宏观环境日历热力图:每格 = 一个美东日的回溯 regime(绿=风险偏好,红=避险/冲击,
 * 灰=中性/无事件),点击选中该日联动整页;点已选中日或今日回到实时视图(null)。
 * live 为实时 regime 快照:今日格以它为准,不受服务端 10 分钟历史缓存滞后影响。
 */
export default function MacroHeatmap({ history, selectedDate, onSelect, todayEt, live }) {
  const weeks = useMemo(() => buildWeeks(history, todayEt), [history, todayEt]);
  if (!weeks.length) return null;

  return (
    <div>
      <div className="heatmap">
        <div className="heatmap__weekdays">
          {WEEKDAY_LABELS.map((d, i) => (
            <span key={i} className="heatmap__weekday">
              {i % 2 === 1 ? d : ''}
            </span>
          ))}
        </div>
        <div className="heatmap__grid">
          {weeks.map((col) => (
            <React.Fragment key={col.key}>
              <div className="heatmap__month">{col.month}</div>
              {col.cells.map((cell) => {
                if (cell.placeholder) {
                  return <div key={cell.ds} className="heatmap__cell heatmap__cell--placeholder" />;
                }
                const isToday = cell.ds === todayEt;
                const day = isToday && live ? { ...cell.day, ...live } : cell.day;
                const { tone, level } = cellEncoding(day);
                const score = Number(day.risk_score) || 0;
                const title = `${cell.ds} · ${REGIME_LABELS[day.regime] || day.regime} · 风险分 ${score.toFixed(2)} · ${day.events ?? 0} 条事件${isToday ? '(今日,实时)' : ''}`;
                return (
                  <Tooltip key={cell.ds} title={title}>
                    <button
                      type="button"
                      className={`heatmap__cell${selectedDate === cell.ds ? ' is-selected' : ''}`}
                      data-tone={tone || undefined}
                      data-level={level}
                      aria-label={title}
                      onClick={() =>
                        onSelect(selectedDate === cell.ds || isToday ? null : cell.ds)
                      }
                    />
                  </Tooltip>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="heatmap__legend">
        <span>避险</span>
        {[3, 2, 1].map((lv) => (
          <span key={`d${lv}`} className="heatmap__legend-cell heatmap__cell" data-tone="down" data-level={lv} />
        ))}
        <span className="heatmap__legend-cell heatmap__cell" data-level={0} />
        {[1, 2, 3].map((lv) => (
          <span key={`u${lv}`} className="heatmap__legend-cell heatmap__cell" data-tone="up" data-level={lv} />
        ))}
        <span>风险偏好</span>
      </div>
    </div>
  );
}
