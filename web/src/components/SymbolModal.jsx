import React, { useEffect, useState } from 'react';
import { Alert, Descriptions, Divider, Modal, Skeleton, Space, Tag, Typography } from 'antd';
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

  useEffect(() => {
    // Modal 常挂载,仅在拿到 symbol 时拉取
    if (!symbol) return;
    setData(null);
    setError(null);
    api.symbol(symbol).then(setData).catch((err) => setError(err.message));
  }, [symbol]);

  const quote = data?.quote;
  const position = data?.position;
  const price = quote?.effective_price ?? quote?.price;

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
              <span className={`num ${quote.changesPercentage >= 0 ? 'up' : 'down'}`}>
                今日 {fmtPercent(quote.changesPercentage)}
              </span>
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
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {data.analyses.map((a) => (
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
                  {a.reasoning && (
                    <p className="reason">
                      <span className="reason-label">分析理由</span>
                      {a.reasoning}
                    </p>
                  )}
                </div>
              ))}
            </Space>
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
