import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Typography } from 'antd';
import { createChart, LineSeries, LineStyle, CrosshairMode } from 'lightweight-charts';
import { fmtPercent } from '../api.js';
import { getChart } from '../theme.js';
import { useThemeMode } from '../theme-context.jsx';
import { toShiftedSec, fmtShiftedTime, tickMarkFormatter } from './chartTime.js';

/**
 * 多组合净值对比图(lightweight-charts,与主页净值图同一套 UI 语言):
 * 每个组合一条相对收益(%)曲线;悬浮信息不进浮层——十字光标扫读时,
 * 图例芯片上的数值跟随光标更新,移开后回到各自最新值;点击图例可隐藏/显示该组合。
 *
 * props.series: [{ variant, name, color, dashed?, emphasis?, rows: [{ time(ms), pct }] }]
 */
export default function ComparisonChart({ series, height = 340 }) {
  const { mode } = useThemeMode();
  const CHART = getChart(mode);
  const containerRef = useRef(null);
  const handleRef = useRef(null); // { chart, apis: Map<variant, seriesApi>, zeroLineHost }
  const [hover, setHover] = useState(null); // { time, values: { variant: pct } }
  const [hiddenSet, setHiddenSet] = useState(() => new Set());

  // 各系列转平移秒、同秒去重、升序;记录各自末值用于图例默认读数
  const prepared = useMemo(
    () =>
      (series || [])
        .map((s) => {
          const bySec = new Map();
          for (const r of s.rows || []) {
            const t = toShiftedSec(r.time);
            if (Number.isFinite(t) && Number.isFinite(Number(r.pct))) bySec.set(t, Number(r.pct));
          }
          const rows = [...bySec.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([time, value]) => ({ time, value }));
          return { ...s, rows, last: rows.length ? rows[rows.length - 1].value : null };
        })
        .filter((s) => s.rows.length > 1),
    [series]
  );

  // 创建图表(挂载 + 主题切换重建)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: CHART.axis,
        fontSize: 11,
        fontFamily: "'Archivo Variable', 'Archivo', 'PingFang SC', system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: CHART.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.1 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: CHART.axis, width: 1, style: LineStyle.LargeDashed, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`,
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });

    const apis = new Map();
    chart.subscribeCrosshairMove((param) => {
      if (param.time === undefined) {
        setHover(null);
        return;
      }
      const values = {};
      for (const [variant, api] of apis) {
        const d = param.seriesData.get(api);
        if (d && Number.isFinite(d.value)) values[variant] = d.value;
      }
      setHover({ time: param.time, values });
    });

    handleRef.current = { chart, apis };
    return () => {
      handleRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // 数据应用:系列数量可变,先移除再按当前数据重建
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    const { chart, apis } = h;
    for (const api of apis.values()) chart.removeSeries(api);
    apis.clear();

    prepared.forEach((s, i) => {
      const api = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: s.emphasis ? 2.5 : 1.5,
        lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
        visible: !hiddenSet.has(s.variant),
      });
      api.setData(s.rows);
      if (i === 0) {
        // 0% 参考线挂在首个系列上(整图共用一个百分比轴)
        api.createPriceLine({
          price: 0,
          color: CHART.reference,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        });
      }
      apis.set(s.variant, api);
    });
    chart.timeScale().fitContent();
  }, [prepared, hiddenSet, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (variant) =>
    setHiddenSet((prev) => {
      const next = new Set(prev);
      if (next.has(variant)) next.delete(variant);
      else next.add(variant);
      return next;
    });

  const latestTime = prepared.reduce(
    (max, s) => Math.max(max, s.rows.length ? s.rows[s.rows.length - 1].time : 0),
    0
  );

  return (
    <div>
      <div className="cmp-head">
        <span className="muted num small">
          {hover ? fmtShiftedTime(hover.time) : latestTime ? `最新 ${fmtShiftedTime(latestTime)}` : ''}
        </span>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          扫过曲线看逐点数值 · 点图例隐藏/显示
        </Typography.Text>
      </div>
      <div className="cmp-legend">
        {prepared.map((s) => {
          const hidden = hiddenSet.has(s.variant);
          const value = hover ? hover.values[s.variant] : s.last;
          return (
            <button
              key={s.variant}
              type="button"
              className={`cmp-chip${hidden ? ' is-hidden' : ''}`}
              onClick={() => toggle(s.variant)}
              title={hidden ? '点击显示' : '点击隐藏'}
            >
              <span className="cmp-chip__dot" style={{ background: s.color }} />
              {s.name}
              <span className="cmp-chip__val num">
                {value === null || value === undefined ? '—' : fmtPercent(value)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="chart-canvas" style={{ height }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        {!prepared.length && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography.Text type="secondary">
              该时间范围内暂无足够的净值快照(影子组合每 10 分钟记一次净值,启用后会逐渐积累)。
            </Typography.Text>
          </div>
        )}
      </div>
    </div>
  );
}
