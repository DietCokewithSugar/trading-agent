import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Divider, Modal, Skeleton, Space, Tag, Typography } from 'antd';
import NewsHeatmap, { etDateOf } from './NewsHeatmap.jsx';
import {
  api,
  fmtMoney,
  fmtNum,
  fmtPercent,
  fmtTime,
  TIER_LABELS,
  SESSION_LABELS,
  TRIGGER_LABELS,
} from '../api.js';

/** 股票详情弹层:报价(含盘前盘后)、持仓、相关新闻分析、交易历史 */
export default function SymbolModal({ symbol, open, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // 选中的热力图日期(null = 全部);拿到新数据后默认定位到最近有新闻的一天
  const [selectedDate, setSelectedDate] = useState(null);

  useEffect(() => {
    // Modal 常挂载,仅在拿到 symbol 时拉取
    if (!symbol) return;
    setData(null);
    setError(null);
    setSelectedDate(null);
    api.symbol(symbol).then(setData).catch((err) => setError(err.message));
  }, [symbol]);

  // 数据到位后默认选中最近有新闻的一天(把超长列表收成单日视图)
  useEffect(() => {
    if (!data?.analyses?.length) return;
    const latest = data.analyses.reduce((acc, a) => {
      const d = etDateOf(a.created_at);
      return d && (!acc || d > acc) ? d : acc;
    }, null);
    setSelectedDate(latest);
  }, [data]);

  const quote = data?.quote;
  const position = data?.position;
  const price = quote?.effective_price ?? quote?.price;

  // 按选中日过滤分析(null 时显示全部)
  const visibleAnalyses = useMemo(() => {
    const all = data?.analyses || [];
    if (!selectedDate) return all;
    return all.filter((a) => etDateOf(a.created_at) === selectedDate);
  }, [data, selectedDate]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      style={{ top: 40 }}
      title={
        <Space size={8} wrap>
          <span>{symbol}</span>
          {quote?.name && (
            <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
              {quote.name}
            </Typography.Text>
          )}
        </Space>
      }
    >
      {error && <Alert type="error" message={error} />}
      {!data && !error && <Skeleton active />}

      {data && (
        <>
          {quote ? (
            <Space size={12} wrap align="baseline">
              <Typography.Title level={3} style={{ margin: 0 }} className="num">
                {fmtMoney(price)}
              </Typography.Title>
              {quote.session && quote.session !== 'regular' && (
                <Tag color="orange">{SESSION_LABELS[quote.session]}</Tag>
              )}
              {(() => {
                // 上游字段名不稳定(changesPercentage/changePercentage),与服务端同样双字段兜底;
                // 缺失时不着色(undefined 比较会把占位符误染跌色)
                const chg = Number(quote.changesPercentage ?? quote.changePercentage);
                return (
                  <span className={`num ${Number.isFinite(chg) ? (chg >= 0 ? 'up' : 'down') : 'muted'}`}>
                    今日 {fmtPercent(Number.isFinite(chg) ? chg : null)}
                  </span>
                );
              })()}
              {quote.extended_price !== null && quote.extended_change_percent !== null && (
                <span className={`num ${quote.extended_change_percent >= 0 ? 'up' : 'down'}`}>
                  {SESSION_LABELS[quote.session] || '盘后'} {fmtPercent(quote.extended_change_percent)}
                </span>
              )}
            </Space>
          ) : (
            <Typography.Text type="secondary">暂无报价数据</Typography.Text>
          )}

          {position && (
            <>
              <Divider plain style={{ margin: '16px 0 12px' }}>当前持仓</Divider>
              <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
                <Descriptions.Item label="数量">
                  <span className="num">{fmtNum(position.quantity, 4)} 股</span>
                </Descriptions.Item>
                <Descriptions.Item label="平均成本">
                  <span className="num">{fmtMoney(position.avg_cost)}</span>
                </Descriptions.Item>
                <Descriptions.Item label="止损 / 止盈">
                  <span className="num">
                    {position.stop_loss ? fmtMoney(position.stop_loss) : '—'} /{' '}
                    {position.take_profit ? fmtMoney(position.take_profit) : '—'}
                  </span>
                </Descriptions.Item>
                {price && (
                  <Descriptions.Item label="浮动盈亏">
                    <span className={`num ${price >= position.avg_cost ? 'up' : 'down'}`}>
                      {fmtMoney((price - position.avg_cost) * position.quantity)}
                    </span>
                  </Descriptions.Item>
                )}
              </Descriptions>
            </>
          )}

          <Divider plain style={{ margin: '16px 0 12px' }}>
            相关新闻分析 ({data.analyses.length})
          </Divider>
          {!data.analyses.length ? (
            <Typography.Text type="secondary">暂无该股票的分析记录。</Typography.Text>
          ) : (
            <>
              <NewsHeatmap
                analyses={data.analyses}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
              />
              <Space size={8} style={{ margin: '10px 0 12px' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  {selectedDate
                    ? `${selectedDate} · 共 ${visibleAnalyses.length} 条`
                    : `全部 ${data.analyses.length} 条`}
                </Typography.Text>
                {selectedDate && (
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setSelectedDate(null)}>
                    显示全部
                  </Button>
                )}
              </Space>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {visibleAnalyses.map((a) => {
                // 后台已把同一底层事件的近似重复报道聚成一条;members[0] 为代表项,其余为重复报道
                const dupes = (a.members || []).filter((m) => m.id !== a.id);
                return (
                <div key={a.id}>
                  <Space size={8} wrap>
                    <Tag
                      color={
                        a.sentiment === 'bullish' ? 'green' : a.sentiment === 'bearish' ? 'red' : 'default'
                      }
                      style={{ marginRight: 0 }}
                    >
                      {a.sentiment === 'bullish' ? '利好' : a.sentiment === 'bearish' ? '利空' : '中性'}
                    </Tag>
                    {a.tier && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        {TIER_LABELS[a.tier]}
                      </Typography.Text>
                    )}
                    {a.article_count > 1 && (
                      <Tag style={{ marginRight: 0 }}>
                        共 {a.article_count} 篇报道
                        {a.sources?.length ? ` · ${a.sources.join('、')}` : ''}
                      </Tag>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      {fmtTime(a.created_at)}
                    </Typography.Text>
                  </Space>
                  {a.news_articles && (
                    <p className="small" style={{ margin: '4px 0 0' }}>
                      <a href={a.news_articles.url} target="_blank" rel="noreferrer">
                        {a.news_articles.title}
                      </a>
                    </p>
                  )}
                  {dupes.map((m) => (
                    <p key={m.id} className="small" style={{ margin: '2px 0 0', opacity: 0.65 }}>
                      <a href={m.news_articles?.url} target="_blank" rel="noreferrer">
                        {m.news_articles?.title}
                      </a>
                    </p>
                  ))}
                  {a.reasoning && (
                    <p className="reason">
                      <span className="reason-label">分析理由</span>
                      {a.reasoning}
                    </p>
                  )}
                </div>
                );
              })}
            </Space>
            </>
          )}

          <Divider plain style={{ margin: '16px 0 12px' }}>
            交易历史 ({data.trades.length})
          </Divider>
          {!data.trades.length ? (
            <Typography.Text type="secondary">暂无该股票的交易记录。</Typography.Text>
          ) : (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {data.trades.map((t) => (
                <div key={t.id}>
                  <Space size={8} wrap>
                    <Tag color={t.side === 'buy' ? 'green' : 'red'} style={{ marginRight: 0 }}>
                      {t.side === 'buy' ? '买入' : '卖出'}
                    </Tag>
                    {TRIGGER_LABELS[t.trigger] && (
                      <Tag color="orange" style={{ marginRight: 0 }}>
                        {TRIGGER_LABELS[t.trigger]}
                      </Tag>
                    )}
                    <span className="num small">
                      {fmtNum(t.quantity, 4)} 股 @ {fmtMoney(t.price)}
                    </span>
                    {t.realized_pnl !== null && (
                      <span className={`num small ${Number(t.realized_pnl) >= 0 ? 'up' : 'down'}`}>
                        盈亏 {fmtMoney(t.realized_pnl)}
                      </span>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      {fmtTime(t.created_at)}
                    </Typography.Text>
                  </Space>
                  {t.reason && (
                    <p className="reason">
                      <span className="reason-label">决策依据</span>
                      {t.reason}
                    </p>
                  )}
                </div>
              ))}
            </Space>
          )}
        </>
      )}
    </Modal>
  );
}
