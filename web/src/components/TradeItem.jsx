import React from 'react';
import { Button, Card, Space, Tag, Typography } from 'antd';
import {
  fmtMoney,
  fmtNum,
  fmtTime,
  TIER_LABELS,
  TRIGGER_LABELS,
  REGIME_LABELS,
  REGIME_TAG_COLORS,
} from '../api.js';

/**
 * 单条交易记录卡片(仪表盘「最近交易」与交易记录页共用)。
 * compact 模式省略信号与触发新闻,只保留核心成交信息与决策依据。
 */
export default function TradeItem({ trade: t, onSymbolClick, compact = false }) {
  const buy = t.side === 'buy';
  return (
    <Card size="small">
      <Space size={8} wrap>
        <Tag color={buy ? 'green' : 'red'} style={{ marginRight: 0 }}>
          {buy ? '买入' : '卖出'}
        </Tag>
        {TRIGGER_LABELS[t.trigger] && (
          <Tag color="orange" style={{ marginRight: 0 }}>
            {TRIGGER_LABELS[t.trigger]}
          </Tag>
        )}
        {t.macro_regime && REGIME_LABELS[t.macro_regime] && (
          <Tag color={REGIME_TAG_COLORS[t.macro_regime]} style={{ marginRight: 0 }}>
            {REGIME_LABELS[t.macro_regime]}
          </Tag>
        )}
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onSymbolClick(t.symbol)}>
          {t.symbol}
        </Button>
        <span className="num">
          {fmtNum(t.quantity, 4)} 股 × {fmtMoney(t.price)} = {fmtMoney(t.amount)}
        </span>
        {t.realized_pnl !== null && t.realized_pnl !== undefined && (
          <span className={`num ${Number(t.realized_pnl) >= 0 ? 'up' : 'down'}`}>
            已实现盈亏 {fmtMoney(t.realized_pnl)}
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

      {!compact && t.news_analyses && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
          信号:{t.news_analyses.sentiment === 'bullish' ? '利好' : '利空'}
          {t.news_analyses.tier ? ` · ${TIER_LABELS[t.news_analyses.tier]}` : ''}
        </Typography.Paragraph>
      )}

      {!compact && t.news_articles && (
        <Typography.Paragraph style={{ fontSize: 12.5, margin: '6px 0 0' }}>
          <Typography.Text type="secondary">触发新闻 </Typography.Text>
          <a href={t.news_articles.url} target="_blank" rel="noreferrer">
            {t.news_articles.title}
          </a>
        </Typography.Paragraph>
      )}
    </Card>
  );
}
