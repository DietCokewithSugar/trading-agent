import React, { useMemo } from 'react';
import { Tooltip } from 'antd';

// 美东时区下的日期串(YYYY-MM-DD),与全站 ET 口径一致
export function etDateOf(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// 把日期串当作 UTC 零点处理,避免本地时区/夏令时影响周列对齐
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

// 当天条数 → 0~4 档色阶(相对当周期最大值分位)
function levelFor(count, max) {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const r = count / max;
  if (r <= 0.25) return 1;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 3;
  return 4;
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 纯函数:把分析列表按 ET 日期聚合成 GitHub 风格的周列网格。
 * 返回 { weeks, counts, maxCount, latestDate, totalDays }。
 */
export function buildHeatmap(analyses = []) {
  const counts = new Map();
  for (const a of analyses) {
    const d = etDateOf(a?.created_at);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const dates = [...counts.keys()].sort();
  if (!dates.length) {
    return { weeks: [], counts, maxCount: 0, latestDate: null, totalDays: 0 };
  }
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const firstDate = dates[0];
  const lastSeen = dates[dates.length - 1];
  const lastDate = todayET >= lastSeen ? todayET : lastSeen;
  const maxCount = Math.max(...counts.values());

  // 起点对齐到所在周的周日,终点对齐到所在周的周六
  const firstD = parseUTC(firstDate);
  const start = addDays(firstD, -firstD.getUTCDay());
  const lastD = parseUTC(lastDate);
  const end = addDays(lastD, 6 - lastD.getUTCDay());

  const weeks = [];
  let prevMonth = null;
  for (let col = new Date(start); col <= end; col = addDays(col, 7)) {
    const days = [];
    let monthLabel = null;
    for (let row = 0; row < 7; row += 1) {
      const cur = addDays(col, row);
      const ds = fmtUTC(cur);
      // 超过今天的未来日期不显示(占位)
      if (ds > todayET) {
        days.push({ ds, placeholder: true });
        continue;
      }
      const count = counts.get(ds) || 0;
      days.push({ ds, count, level: levelFor(count, maxCount), placeholder: false });
      // 该列首个真实日所在月份与上一列不同时,标月份
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
    weeks.push({ key: fmtUTC(col), month: monthLabel || '', days });
  }

  return { weeks, counts, maxCount, latestDate: lastSeen, totalDays: dates.length };
}

/**
 * 新闻日期热力图:方块颜色深浅按当天分析条数映射,点击某日回调 onSelect(dateStr)。
 * selectedDate 为当前选中日(null = 全部)。
 */
export default function NewsHeatmap({ analyses, selectedDate, onSelect }) {
  const { weeks, maxCount } = useMemo(() => buildHeatmap(analyses), [analyses]);
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
              {col.days.map((day) =>
                day.placeholder ? (
                  <div key={day.ds} className="heatmap__cell heatmap__cell--placeholder" />
                ) : day.count > 0 ? (
                  <Tooltip key={day.ds} title={`${day.ds} · ${day.count} 条`}>
                    <button
                      type="button"
                      className={`heatmap__cell${selectedDate === day.ds ? ' is-selected' : ''}`}
                      data-level={day.level}
                      aria-label={`${day.ds} ${day.count} 条`}
                      onClick={() => onSelect(selectedDate === day.ds ? null : day.ds)}
                    />
                  </Tooltip>
                ) : (
                  <div
                    key={day.ds}
                    className="heatmap__cell heatmap__cell--empty"
                    data-level={0}
                  />
                )
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="heatmap__legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((lv) => (
          <span key={lv} className="heatmap__legend-cell heatmap__cell" data-level={lv} />
        ))}
        <span>多</span>
        {maxCount > 0 && <span style={{ marginLeft: 8 }}>单日最多 {maxCount} 条</span>}
      </div>
    </div>
  );
}
