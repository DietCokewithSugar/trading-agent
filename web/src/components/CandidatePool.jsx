import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Space, Table, Tag } from 'antd';
import { api, fmtNum, fmtTime, CANDIDATE_STATUS_LABELS, TIER_LABELS } from '../api.js';
import { useLiveQuotes } from '../quotes-context.jsx';
import FlashOnChange from './FlashOnChange.jsx';
import SessionBadge from './SessionBadge.jsx';

const CANDIDATE_STATUS_COLORS = {
  pending: 'blue',
  capital_constrained: 'gold',
  macro_filtered: 'orange',
  conflict_hold: 'purple',
};

// status_reason 为空时(常见于刚入池的待分配候选)按状态给出默认说明,避免「说明」列空白
const STATUS_FALLBACK_NOTES = {
  pending: '等待资金分配器盘中按分数执行',
  capital_constrained: '资金暂不足,留池等待资金释放后复评',
  macro_filtered: '被当前宏观环境过滤,环境改善后自动复评',
  conflict_hold: '存在反向信号,冲突解除后自动复评',
};

/**
 * 入池价锚定的反事实区间条:现价落在 [入池价−止损%, 入池价+止盈%] 的什么位置。
 * 回答"系统若在入池瞬间买入,这笔仓位现在处于什么状态"——已越界的直接标注
 * 已止盈/已止损(候选池延迟的可视化,即 016 排队成本埋点的展示层)。
 */
function EntryBandBar({ price, entry, slPct, tpPct }) {
  const p = Number(price);
  const e = Number(entry);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(e) || e <= 0 || !(slPct > 0) || !(tpPct > 0)) {
    return '—';
  }
  const lo = e * (1 - slPct / 100);
  const hi = e * (1 + tpPct / 100);
  const drift = (p / e - 1) * 100;
  const driftText = `${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%`;
  if (p >= hi) {
    return <span className="up" style={{ fontSize: 12 }}>若入池即买已止盈({driftText})</span>;
  }
  if (p <= lo) {
    return <span className="down" style={{ fontSize: 12 }}>若入池即买已止损({driftText})</span>;
  }
  const ratio = Math.min(Math.max((p - lo) / (hi - lo), 0), 1);
  const entryTick = (slPct / (slPct + tpPct)) * 100; // 入池价在区间中的刻度位置
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ position: 'relative', height: 4, background: 'var(--border-visible)', borderRadius: 2, margin: '4px 0 2px' }}>
        <div style={{ position: 'absolute', left: `${entryTick}%`, top: -2, width: 1, height: 8, background: 'var(--text-secondary)' }} />
        <div style={{ position: 'absolute', left: `calc(${(ratio * 100).toFixed(1)}% - 1px)`, top: -3, width: 2, height: 10, background: 'currentColor' }} />
      </div>
      <div className="num" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        入池 ${e.toFixed(2)} · 漂移 <FlashOnChange value={drift}>{driftText}</FlashOnChange>
      </div>
    </div>
  );
}

/**
 * 买入候选池:通过准入门槛、等待资金分配器盘中统一执行的利好信号。
 * version 由 App 的 SSE macro 事件(含池数量变化)驱动自增,触发重新拉取;
 * 候选池不可用(未启用宏观层/014 迁移未执行)时整体隐藏。
 */
export default function CandidatePool({ version = 0, onSymbolClick }) {
  const [pool, setPool] = useState(null);
  const quotes = useLiveQuotes();

  useEffect(() => {
    let cancelled = false;
    api
      .pool()
      .then((data) => !cancelled && setPool(data?.pool ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);

  // 实时报价合并(SSE quotes 事件,每个推送 tick 覆盖):有 live 时时段/盘外字段
  // 整体取 live 快照,不与旧拉取值逐字段混用——盘外字段为 null 是"当前时段没有
  // 盘外价"的有效信息(如开盘瞬间),回退旧值会把昨晚的盘后涨跌挂到今天的时段上
  const rows = useMemo(
    () =>
      (pool?.top || []).map((c) => {
        const live = quotes[String(c.symbol).toUpperCase()];
        if (!live) return c;
        const price = Number(live.effective_price);
        return {
          ...c,
          current_price: Number.isFinite(price) && price > 0 ? price : c.current_price,
          session: live.session ?? null,
          extended_price: live.extended_price ?? null,
          extended_change_percent: live.extended_change_percent ?? null,
        };
      }),
    [pool, quotes]
  );

  if (!pool) return null;
  const counts = pool.counts || {};
  // 系统离场口径(服务端下发,未来改动态敞口时展示自动跟随)
  const slPct = Number(pool.reference?.stop_loss_percent) || 0;
  const tpPct = Number(pool.reference?.take_profit_percent) || 0;
  const bandLabel = slPct === tpPct ? `±${tpPct}%` : `−${slPct}%/+${tpPct}%`;
  const columns = [
    {
      title: '股票',
      dataIndex: 'symbol',
      width: 90,
      render: (v) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onSymbolClick?.(v)}>
          {v}
        </Button>
      ),
    },
    {
      title: '档位',
      dataIndex: 'tier',
      width: 160,
      ellipsis: true,
      render: (v) => (v ? TIER_LABELS[v] : '—'),
    },
    {
      title: '当前分',
      dataIndex: 'current_score',
      width: 90,
      align: 'right',
      render: (v) => <span className="num">{v === null || v === undefined ? '—' : fmtNum(v, 3)}</span>,
    },
    {
      // "若现在买入":锚点只能是现价(≈此刻自己下单的成交价)。
      // 入池价 ±N% 回答的是另一个问题(见下一列),两者可相差整个漂移幅度
      title: `若现在买入(系统口径 ${bandLabel})`,
      dataIndex: 'current_price',
      width: 200,
      render: (v, row) => {
        const p = Number(v);
        if (!Number.isFinite(p) || p <= 0 || !(slPct > 0) || !(tpPct > 0)) return '—';
        return (
          <div className="num" style={{ fontSize: 12, lineHeight: 1.6 }}>
            <Space size={4}>
              <FlashOnChange value={p}>现价 ${p.toFixed(2)}</FlashOnChange>
              <SessionBadge
                session={row.session}
                extendedPrice={row.extended_price}
                extendedChangePercent={row.extended_change_percent}
              />
            </Space>
            <div>
              止损 ${(p * (1 - slPct / 100)).toFixed(2)} · 止盈 ${(p * (1 + tpPct / 100)).toFixed(2)}
            </div>
          </div>
        );
      },
    },
    {
      title: '入池价反事实区间',
      dataIndex: 'entry_price',
      width: 180,
      render: (v, row) => (
        <EntryBandBar price={row.current_price} entry={v} slPct={slPct} tpPct={tpPct} />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v) => (
        <Tag color={CANDIDATE_STATUS_COLORS[v] || 'default'} style={{ marginRight: 0 }}>
          {CANDIDATE_STATUS_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: '说明',
      dataIndex: 'status_reason',
      ellipsis: true,
      render: (v, row) => v || STATUS_FALLBACK_NOTES[row.status] || '—',
    },
    { title: '入池时间', dataIndex: 'created_at', width: 110, render: (v) => fmtTime(v) },
  ];
  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space size={8} wrap>
          买入候选池
          {Object.entries(counts).map(([status, n]) => (
            <Tag key={status} color={CANDIDATE_STATUS_COLORS[status] || 'default'} style={{ marginRight: 0 }}>
              {CANDIDATE_STATUS_LABELS[status] || status} {n}
            </Tag>
          ))}
        </Space>
      }
    >
      {rows.length ? (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1080 }}
        />
      ) : (
        <Empty
          description="候选池为空。利好信号经准入门槛后入池,由资金分配器在盘中按分数统一执行。"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </Card>
  );
}
