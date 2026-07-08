import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Typography } from 'antd';
import {
  createChart,
  createSeriesMarkers,
  BaselineSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
} from 'lightweight-charts';
import { api, fmtMoney, fmtNum, fmtPercent } from '../api.js';
import { getChart, getPnl } from '../theme.js';
import { useThemeMode } from '../theme-context.jsx';

const RANGES = [
  { key: '1d', label: '1天', hours: 24 },
  { key: '1w', label: '1周', hours: 24 * 7 },
  { key: '1m', label: '1月', hours: 24 * 30 },
  { key: 'all', label: '全部', hours: null },
];

// 图表库按 UTC 解读时间戳:整体平移到本地时区,坐标轴/刻度即显示本地钟点
const TZ_OFFSET_SEC = -new Date().getTimezoneOffset() * 60;

function hexToRgba(hex, alpha) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const pad = (n) => String(n).padStart(2, '0');

/** 平移后的秒级时间戳 → 本地钟点文本(平移后 UTC 读数即本地墙钟) */
function fmtShiftedTime(sec, { withTime = true } = {}) {
  const d = new Date(sec * 1000);
  const date = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 按数值跨度选轴刻度精度:窄幅波动时固定「$xx.xk」会让所有刻度同值 */
function makePriceFormatter(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return (v) => `$${(v / 1000).toFixed(1)}k`;
  const span = Math.max(Math.max(...finite) - Math.min(...finite), 1);
  if (span >= 20000) return (v) => `$${(v / 1000).toFixed(0)}k`;
  if (span >= 2000) return (v) => `$${(v / 1000).toFixed(1)}k`;
  if (span >= 100) return (v) => `$${Math.round(v).toLocaleString('en-US')}`;
  return (v) => `$${Number(v).toFixed(2)}`;
}

/**
 * 账户净值走势(TradingView lightweight-charts):
 * 基线分色面积(初始资金之上绿、之下红)+ 买卖点标记 + 基准虚线。
 * 悬浮信息不挤在浮层里:十字光标扫读时,图表头部的大号读数跟随更新
 * (净值 / 盈亏 / 时刻 / 当刻成交),移开后回到最新值。
 */
export default function NetWorthChart({ snapshots, trades, initialCapital, benchmarks }) {
  const { mode } = useThemeMode();
  const [rangeKey, setRangeKey] = useState('all');
  const [rangeData, setRangeData] = useState(null);
  const [hover, setHover] = useState(null);
  const containerRef = useRef(null);
  const handleRef = useRef(null); // { chart, baseline, markersApi, benchSeries, priceLine }
  const pointMapRef = useRef(new Map());

  const range = RANGES.find((r) => r.key === rangeKey);

  // 非"全部"范围时单独拉取对应时间段的采样数据;有新快照时跟着刷新。
  // 依赖末点时间戳而非长度:快照数组达到上限后是滑动窗口,长度恒定不再变化
  const lastSnapshotAt = snapshots.length ? snapshots[snapshots.length - 1].created_at : null;
  useEffect(() => {
    if (!range.hours) {
      setRangeData(null);
      return;
    }
    let cancelled = false;
    api
      .snapshots(range.hours)
      .then((rows) => !cancelled && setRangeData(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rangeKey, lastSnapshotAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = range.hours ? rangeData || [] : snapshots;

  // 快照 → 图表点位(平移秒、升序、同秒去重),交易挂到时间最近的点上
  const { points, markers } = useMemo(() => {
    const bySec = new Map();
    for (const s of rows) {
      const ms = new Date(s.created_at).getTime();
      if (!Number.isFinite(ms)) continue;
      const time = Math.floor(ms / 1000) + TZ_OFFSET_SEC;
      bySec.set(time, {
        time,
        value: Number(s.total_value),
        pnl: Number(s.pnl),
        pnlPercent: Number(s.pnl_percent),
        trades: [],
      });
    }
    const points = [...bySec.values()].sort((a, b) => a.time - b.time);
    if (!points.length) return { points, markers: [] };

    const minTime = points[0].time;
    const maxTime = points[points.length - 1].time;
    const markers = [];
    for (const t of trades || []) {
      const time = Math.floor(new Date(t.created_at).getTime() / 1000) + TZ_OFFSET_SEC;
      if (time < minTime || time > maxTime + 60) continue;
      let nearest = points[0];
      for (const p of points) {
        if (Math.abs(p.time - time) < Math.abs(nearest.time - time)) nearest = p;
      }
      nearest.trades.push(t);
      markers.push({ time: nearest.time, trade: t });
    }
    markers.sort((a, b) => a.time - b.time);
    return { points, markers };
  }, [rows, trades]);

  // 买入持有参考基线(标普500/黄金,日线):1 天视图下日线粒度太粗,不展示
  const benchmarkSeries = useMemo(() => {
    if (rangeKey === '1d' || !benchmarks?.length || !points.length) return [];
    const minTime = points[0].time - 24 * 3600;
    const maxTime = points[points.length - 1].time + 24 * 3600;
    return benchmarks
      .filter((b) => b?.series?.length)
      .map((b) => ({
        symbol: b.symbol,
        name: b.name || b.symbol,
        rows: b.series
          .map((p) => ({
            // 日线点定位到当日美股收盘附近(20:00 UTC)
            time: Math.floor(new Date(`${p.date}T20:00:00Z`).getTime() / 1000) + TZ_OFFSET_SEC,
            value: Number(p.value),
          }))
          .filter((p) => Number.isFinite(p.value) && p.time >= minTime && p.time <= maxTime)
          .sort((a, b) => a.time - b.time),
      }))
      .filter((b) => b.rows.length > 1);
  }, [benchmarks, points, rangeKey]);

  const base = Number(initialCapital) || points[0]?.value || 0;
  const CHART = getChart(mode);
  const PNL = getPnl(mode);

  // 创建图表(挂载时 + 主题切换时整体重建,保证配色一致)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: CHART.axis,
        fontSize: 11,
        fontFamily:
          "'Archivo Variable', 'Archivo', 'PingFang SC', system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: CHART.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time, tickMarkType) => {
          const d = new Date(time * 1000);
          // 平移后的 UTC 读数即本地墙钟;Year/Month/Day 档显示日期,更细档显示钟点
          if (tickMarkType <= 2) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
          return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: CHART.axis, width: 1, style: LineStyle.LargeDashed, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      localization: { locale: 'zh-CN' },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });

    const baseline = chart.addSeries(BaselineSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });
    const markersApi = createSeriesMarkers(baseline, []);

    // 十字光标扫读 → 头部读数跟随(浮层容不下的信息全部放进固定读数区)
    chart.subscribeCrosshairMove((param) => {
      const point = param.time !== undefined ? pointMapRef.current.get(param.time) : null;
      setHover(point || null);
    });

    handleRef.current = { chart, baseline, markersApi, benchSeries: [], priceLine: null };
    return () => {
      handleRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // 数据与配色应用(数据变化 + 主题重建后)
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    const { chart, baseline, markersApi } = h;

    pointMapRef.current = new Map(points.map((p) => [p.time, p]));

    const up = PNL.up;
    const down = PNL.down;
    baseline.applyOptions({
      baseValue: { type: 'price', price: base },
      topLineColor: up,
      topFillColor1: hexToRgba(up, 0.24),
      topFillColor2: hexToRgba(up, 0.02),
      bottomLineColor: down,
      bottomFillColor1: hexToRgba(down, 0.02),
      bottomFillColor2: hexToRgba(down, 0.24),
    });
    baseline.setData(points.map((p) => ({ time: p.time, value: p.value })));

    // 初始资金参考线
    if (h.priceLine) baseline.removePriceLine(h.priceLine);
    h.priceLine = base
      ? baseline.createPriceLine({
          price: base,
          color: CHART.reference,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        })
      : null;

    // 买卖点:买入▲(线下)绿、卖出▼(线上)红,详情随十字光标进头部读数
    markersApi.setMarkers(
      markers.map((m) => ({
        time: m.time,
        position: m.trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: m.trade.side === 'buy' ? up : down,
        shape: m.trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        size: 1,
      }))
    );

    // 基准虚线系列:数量可变,先移除再按当前基准重建
    for (const s of h.benchSeries) chart.removeSeries(s);
    h.benchSeries = benchmarkSeries.map((b) => {
      const s = chart.addSeries(LineSeries, {
        color: b.symbol === 'GLD' ? CHART.benchmarkGold : CHART.benchmark,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(b.rows);
      return s;
    });

    chart.applyOptions({
      localization: {
        locale: 'zh-CN',
        priceFormatter: makePriceFormatter([
          ...points.map((p) => p.value),
          ...benchmarkSeries.flatMap((b) => b.rows.map((r) => r.value)),
        ]),
      },
    });
    chart.timeScale().fitContent();
  }, [points, markers, benchmarkSeries, base, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = points.length ? points[points.length - 1] : null;
  const active = hover || latest;
  const activePnl = active ? (Number.isFinite(active.pnl) ? active.pnl : active.value - base) : null;
  const activePnlPercent = active
    ? Number.isFinite(active.pnlPercent)
      ? active.pnlPercent
      : base
        ? ((active.value - base) / base) * 100
        : null
    : null;

  return (
    <div>
      <div className="chart-head">
        <div>
          <div className="chart-head__value">{active ? fmtMoney(active.value) : '—'}</div>
          <div className="chart-head__meta">
            {active && (
              <span className={`num ${activePnl >= 0 ? 'up' : 'down'}`}>
                {fmtMoney(activePnl)} ({fmtPercent(activePnlPercent)})
              </span>
            )}
            <span className="muted num">
              {active ? (hover ? fmtShiftedTime(active.time) : `最新 ${fmtShiftedTime(active.time)}`) : ''}
            </span>
            {hover?.trades?.length ? (
              <span className="muted">
                {hover.trades
                  .map(
                    (t) =>
                      `${t.side === 'buy' ? '买入' : '卖出'} ${t.symbol} ${fmtNum(t.quantity, 4)} 股 @ ${fmtMoney(t.price)}`
                  )
                  .join(' · ')}
              </span>
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <Segmented
            size="small"
            options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
            value={rangeKey}
            onChange={setRangeKey}
          />
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            ▲ 买入 · ▼ 卖出 · 扫过曲线查看逐点详情
            {benchmarkSeries.length
              ? ` · ┄ ${benchmarkSeries.map((b) => b.name).join(' / ')} 基准`
              : ''}
          </Typography.Text>
        </div>
      </div>

      <div className="chart-canvas">
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        {!points.length && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography.Text type="secondary">该时间范围内暂无净值数据。</Typography.Text>
          </div>
        )}
      </div>
    </div>
  );
}
