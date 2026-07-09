import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, DatePicker, Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  api,
  fmtTime,
  TIER_LABELS,
  CREDIBILITY_BANDS,
  credibilityBandOf,
  etDayOf,
  etToday,
} from '../api.js';

const PAGE_SIZE = 60;
// SSE 自动刷新合并时本地最多保留的条数,防止长期挂机内存无限增长
const MAX_ITEMS = 600;
const SEARCH_DEBOUNCE_MS = 400;

const SENTIMENT_FILTERS = [
  { value: 'analyzed', label: '已分析' },
  { value: 'bullish', label: '利好' },
  { value: 'bearish', label: '利空' },
  { value: 'neutral', label: '中性' },
  { value: 'all', label: '全部新闻' },
];

const TIER_FILTERS = [
  { value: 'all', label: '全部档位' },
  ...[1, 2, 3, 4].map((t) => ({ value: t, label: TIER_LABELS[t] })),
];

const BAND_FILTERS = [
  { value: 'all', label: '全部来源' },
  ...Object.entries(CREDIBILITY_BANDS).map(([value, b]) => ({ value, label: b.label })),
];

// 单词且形如股票代码 → 走服务端 symbol 精确筛选(分析主体口径,只命中已分析文章);
// 其他输入 → 标题/原始标签模糊搜索。已知边界:代码形状的普通单词(如 FED)会走代码路径,
// 多加一个词即切回标题搜索
const SYMBOL_QUERY_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

/** 来源可信度配色:高=绿,中=默认,低=橙(与信号质量页 0.85/0.65 同口径;与涨跌色无关) */
function credibilityColor(score) {
  const band = credibilityBandOf(score);
  if (band === 'high') return 'green';
  if (band === 'mid') return 'default';
  return 'orange';
}

/** 利好绿/利空红(美股惯例) */
function AnalysisBadge({ analysis, onSymbolClick }) {
  const symbolBtn = (
    <Button
      type="link"
      size="small"
      style={{ padding: 0, height: 'auto' }}
      onClick={() => onSymbolClick(analysis.symbol)}
    >
      {analysis.symbol}
    </Button>
  );
  if (analysis.sentiment === 'neutral' || !analysis.tier) {
    return (
      <Space size={4}>
        <Tag style={{ marginRight: 0 }}>中性</Tag>
        {symbolBtn}
      </Space>
    );
  }
  const bullish = analysis.sentiment === 'bullish';
  return (
    <Space size={4} wrap>
      <Tag color={bullish ? 'green' : 'red'} style={{ marginRight: 0 }}>
        {bullish ? '利好' : '利空'}
      </Tag>
      {symbolBtn}
      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
        {TIER_LABELS[analysis.tier]}
      </Typography.Text>
    </Space>
  );
}

/**
 * 新闻页:筛选/搜索/分页全部由服务端完成,本地只保留当前展示的数据。
 * 默认单日视图(今天,无数据回退到最近有新闻的一天;交易记录页同款交互):
 * 日期步进器 + 方向/档位/来源可信度筛选叠加;搜索时切换为跨日期模式。
 * version 变化(SSE 收到新新闻/新分析)时重拉第一页并与已加载内容去重合并。
 */
export default function NewsFeed({ version, onSymbolClick }) {
  const [sentimentFilter, setSentimentFilter] = useState('analyzed');
  const [tierFilter, setTierFilter] = useState('all');
  const [bandFilter, setBandFilter] = useState('all');
  const [selectedDate, setSelectedDate] = useState(null); // null = 自动(今天/最近有数据日)
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const queryKeyRef = useRef(null);

  // 搜索防抖,避免每敲一个字符都打一次接口
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const searching = Boolean(query);
  const isSymbolQuery = searching && SYMBOL_QUERY_RE.test(query);
  const selectedDayKey = selectedDate ? selectedDate.format('YYYY-MM-DD') : null;

  // 自动模式的活跃日:已加载最新一条的美东日历日(服务端按发布时间倒序,第一页即最新日前缀)
  const autoDayKey = useMemo(() => {
    const first = items.find((n) => n.published_at);
    return first ? etDayOf(first.published_at) : null;
  }, [items]);
  const activeDayKey = searching ? null : selectedDayKey || autoDayKey;

  // 单日视图只展示活跃日的行(自动模式第一页可能跨日,跨日部分是"该日已加载完"的信号)
  const displayItems = useMemo(() => {
    if (searching || !activeDayKey) return items;
    return items.filter((n) => etDayOf(n.published_at) === activeDayKey);
  }, [items, searching, activeDayKey]);

  const buildParams = () => ({
    filter: sentimentFilter,
    ...(tierFilter !== 'all' ? { tier: tierFilter } : {}),
    ...(bandFilter !== 'all' ? { band: bandFilter } : {}),
    ...(searching
      ? isSymbolQuery
        ? { symbol: query.toUpperCase() }
        : { q: query }
      : selectedDayKey
        ? { date: selectedDayKey }
        : {}),
  });

  useEffect(() => {
    const key = [selectedDayKey ?? '', sentimentFilter, tierFilter, bandFilter, query].join('|');
    const isNewQuery = key !== queryKeyRef.current;
    let cancelled = false;
    if (isNewQuery) setLoading(true);

    api
      .news({ limit: PAGE_SIZE, ...buildParams() })
      .then((rows) => {
        if (cancelled) return;
        queryKeyRef.current = key;
        if (isNewQuery) {
          setItems(rows);
          // 自动模式第一页已跨到前一日 = 最新日已完整加载
          const first = rows.find((r) => r.published_at);
          const crossedDay =
            !searching &&
            !selectedDayKey &&
            first &&
            rows.some((r) => r.published_at && etDayOf(r.published_at) !== etDayOf(first.published_at));
          setNoMore(crossedDay || rows.length < PAGE_SIZE);
        } else {
          // SSE 触发的刷新:新第一页与已加载的后续页去重合并,并限制总量
          setItems((prev) => {
            const seen = new Set(rows.map((r) => r.id));
            return [...rows, ...prev.filter((p) => !seen.has(p.id))].slice(0, MAX_ITEMS);
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sentimentFilter, tierFilter, bandFilter, selectedDayKey, query, version]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      // 游标分页:以已加载最旧一条的发布时间为界,SSE 推送的新文章不会让翻页漏行
      //(最旧一条缺发布时间的极少数情况退回 offset);单日视图内始终附带 date 边界
      const pool = searching ? items : displayItems.length ? displayItems : items;
      const oldest = pool[pool.length - 1]?.published_at;
      const next = await api.news({
        limit: PAGE_SIZE,
        ...(oldest ? { before: oldest } : { offset: items.length }),
        ...buildParams(),
        ...(!searching && activeDayKey ? { date: activeDayKey } : {}),
      });
      if (next.length < PAGE_SIZE) setNoMore(true);
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const merged = [...prev, ...next.filter((n) => !seen.has(n.id))];
        // 本地展示上限与 SSE 合并路径一致(防长会话内存膨胀);达到上限即不再翻页
        if (merged.length >= MAX_ITEMS) setNoMore(true);
        return merged;
      });
    } catch {
      /* 下次再试 */
    }
    setLoadingMore(false);
  };

  // 日期步进(把选中的日历日理解为美东交易日;交易记录页同款交互)
  const stepDay = (delta) => {
    const base = activeDayKey ? dayjs(activeDayKey) : dayjs(etToday());
    const next = base.add(delta, 'day');
    if (next.format('YYYY-MM-DD') > etToday()) return;
    setSelectedDate(next);
  };

  const fallbackToEarlierDay =
    !searching && !selectedDayKey && autoDayKey && autoDayKey !== etToday();

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        {!searching && (
          <Space.Compact size="small">
            <Button icon={<LeftOutlined />} onClick={() => stepDay(-1)} title="前一天" />
            <DatePicker
              size="small"
              value={activeDayKey ? dayjs(activeDayKey) : null}
              onChange={setSelectedDate}
              allowClear={Boolean(selectedDate)}
              disabledDate={(d) => d.format('YYYY-MM-DD') > etToday()}
              style={{ width: 130 }}
            />
            <Button
              icon={<RightOutlined />}
              onClick={() => stepDay(1)}
              disabled={!activeDayKey || activeDayKey >= etToday()}
              title="后一天"
            />
          </Space.Compact>
        )}
        <Select
          size="small"
          style={{ width: 110 }}
          options={SENTIMENT_FILTERS}
          value={sentimentFilter}
          onChange={setSentimentFilter}
        />
        <Select
          size="small"
          style={{ width: 130 }}
          options={TIER_FILTERS}
          value={tierFilter}
          onChange={setTierFilter}
          // 中性信号无档位(tier 为空),两者互斥
          disabled={sentimentFilter === 'neutral'}
        />
        <Select
          size="small"
          style={{ width: 140 }}
          options={BAND_FILTERS}
          value={bandFilter}
          onChange={setBandFilter}
        />
        <Input.Search
          allowClear
          size="small"
          placeholder="代码精确筛选,或输入关键词搜标题"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
      </Space>

      {fallbackToEarlierDay && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 12 }}>
          今日暂无符合条件的新闻,已显示最近有新闻的一天;用日期选择器可查看任意一天。
        </Typography.Paragraph>
      )}

      {loading && !displayItems.length ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : !displayItems.length ? (
        <Empty
          description={
            searching
              ? '没有匹配的新闻。'
              : '该日无符合条件的新闻,可用日期步进器或筛选器调整范围。'
          }
        />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {displayItems.map((n) => {
            // 标签优先用分析判定的代码(准确),未分析的新闻才回退原始来源标签(接口原始标签常含无关股票)
            const displaySymbols = n.news_analyses?.length
              ? [...new Set(n.news_analyses.map((a) => a.symbol).filter(Boolean))]
              : n.symbols || [];
            return (
            <Card size="small" key={n.id}>
              <a href={n.url} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
                {n.title}
              </a>
              <div style={{ marginTop: 6 }}>
                <Space size={8} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {n.publisher || '未知来源'}
                  </Typography.Text>
                  {typeof n.source_score === 'number' || typeof n.source_score === 'string' ? (
                    <Tag
                      color={credibilityColor(Number(n.source_score))}
                      style={{ marginRight: 0, fontSize: 12 }}
                    >
                      来源可信度 {(Number(n.source_score) * 100).toFixed(0)}%
                    </Tag>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {fmtTime(n.published_at)}
                  </Typography.Text>
                  {displaySymbols.map((s) => (
                    <Tag
                      key={s}
                      style={{ marginRight: 0, cursor: 'pointer' }}
                      onClick={() => onSymbolClick(s)}
                    >
                      {s}
                    </Tag>
                  ))}
                </Space>
              </div>
              {n.news_analyses?.map((a) => (
                <div key={a.id} style={{ marginTop: 8 }}>
                  <Space size={8} wrap>
                    <AnalysisBadge analysis={a} onSymbolClick={onSymbolClick} />
                    {typeof a.confidence === 'number' && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        置信度 {(a.confidence * 100).toFixed(0)}%
                      </Typography.Text>
                    )}
                    {a.final_confidence !== null && a.final_confidence !== undefined && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        综合置信度 {(Number(a.final_confidence) * 100).toFixed(0)}%
                      </Typography.Text>
                    )}
                  </Space>
                  {a.reasoning && (
                    <p className="reason">
                      <span className="reason-label">分析理由</span>
                      {a.reasoning}
                    </p>
                  )}
                </div>
              ))}
            </Card>
            );
          })}
        </Space>
      )}

      {!noMore && displayItems.length >= PAGE_SIZE && (
        <div className="load-more-row">
          <Button onClick={loadMore} loading={loadingMore}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
