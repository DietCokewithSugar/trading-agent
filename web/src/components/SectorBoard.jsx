import React, { useMemo } from 'react';
import { Card, Empty, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { SECTOR_LABELS, sectorToneLabel } from '../api.js';

/**
 * 板块情绪看板(034):按 SPDR 行业 ETF 口径汇总当前窗口内各板块的利好/利空。
 * 每行一个板块:发散条(中轴向右=利好权重,向左=利空权重,长度按全板块最大权重归一)
 * + 净情绪分 + 利好/利空/中性条数。点击行=按该板块筛选新闻(再点取消)。
 *
 * 权重口径由服务端给出(综合置信度 × 档位分),这里只做展示与长度归一。
 */

const fmtScore = (score) =>
  score === null || score === undefined ? '—' : `${score > 0 ? '+' : ''}${Number(score).toFixed(2)}`;

function toneClass(score) {
  if (score === null || score === undefined) return '';
  if (Number(score) > 0.05) return 'up';
  if (Number(score) < -0.05) return 'down';
  return '';
}

function SectorRow({ row, maxWeight, selected, onSelect }) {
  const label = SECTOR_LABELS[row.key] || row.label || row.key;
  const bullWidth = maxWeight > 0 ? (row.bullish_weight / maxWeight) * 100 : 0;
  const bearWidth = maxWeight > 0 ? (row.bearish_weight / maxWeight) * 100 : 0;
  const empty = !row.total;
  // 宏观层对该板块的乘数:>1 顺风、<1 逆风(来自宏观事件的受影响行业)
  const macro = row.macro_multiplier;
  // 未分类桶没有对应的筛选口径(服务端按板块别名过滤),渲染成静态行
  const clickable = row.key !== 'OTHER';

  return (
    <div
      className={`secrow${selected ? ' is-selected' : ''}${empty ? ' is-empty' : ''}${
        clickable ? '' : ' is-static'
      }`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onSelect(row.key) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(row.key);
              }
            }
          : undefined
      }
    >
      <div className="secrow__name">
        <span className="mono secrow__etf">{row.etf || row.key}</span>
        <span className="secrow__label">{label}</span>
      </div>

      <div className="secrow__bar">
        <div className="secbar">
          <div className="secbar__side secbar__side--down">
            <span className="secbar__fill" style={{ width: `${Math.min(bearWidth, 100)}%` }} />
          </div>
          <div className="secbar__axis" />
          <div className="secbar__side secbar__side--up">
            <span className="secbar__fill" style={{ width: `${Math.min(bullWidth, 100)}%` }} />
          </div>
        </div>
      </div>

      <div className={`secrow__score num ${toneClass(row.score)}`}>
        {fmtScore(row.score)}
        <span className="secrow__tone">{sectorToneLabel(row.score)}</span>
      </div>

      <div className="secrow__counts num">
        <span className="up">{row.bullish}</span>
        <span className="secrow__sep">/</span>
        <span className="down">{row.bearish}</span>
        <span className="secrow__sep">/</span>
        <span className="secrow__neutral">{row.neutral}</span>
      </div>

      <div className="secrow__meta">
        {macro !== null && macro !== undefined && (
          <Tooltip title="宏观层对该板块的乘数:>1 顺风,<1 逆风">
            <Tag
              color={macro > 1 ? 'green' : macro < 1 ? 'red' : 'default'}
              style={{ marginRight: 0, fontSize: 11.5 }}
            >
              宏观 ×{Number(macro).toFixed(2)}
            </Tag>
          </Tooltip>
        )}
        {row.symbols.slice(0, 3).map((s) => (
          <Tooltip key={s.symbol} title={`利好 ${s.bullish} · 利空 ${s.bearish} · 中性 ${s.neutral}`}>
            <span className={`mono secrow__sym ${toneClass(s.score)}`}>{s.symbol}</span>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

export default function SectorBoard({ board, loading, selected, onSelect, extra }) {
  const rows = useMemo(() => {
    if (!board?.sectors) return [];
    const list = [...board.sectors];
    if (board.unclassified?.total) list.push(board.unclassified);
    // 排序:被单边推动得最厉害的板块在前(净权重差),其次样本量;
    // 无信号板块垫底(仍然展示,看板行数稳定)
    const netWeight = (r) => Math.abs((r.bullish_weight || 0) - (r.bearish_weight || 0));
    return list.sort((a, b) => {
      if (Boolean(a.total) !== Boolean(b.total)) return a.total ? -1 : 1;
      return netWeight(b) - netWeight(a) || b.total - a.total;
    });
  }, [board]);

  const maxWeight = useMemo(
    () =>
      rows.reduce((max, r) => Math.max(max, r.bullish_weight || 0, r.bearish_weight || 0), 0),
    [rows]
  );

  const totals = board?.totals;

  return (
    <Card
      size="small"
      title="板块情绪"
      extra={extra}
      styles={{ body: { paddingTop: 8 } }}
      style={{ marginBottom: 16 }}
    >
      {loading && !board ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : !rows.length || !totals?.total ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="该窗口内没有已分析的新闻,暂无法给出板块情绪。"
        />
      ) : (
        <>
          <div className="secboard__head">
            <Space size={14} wrap>
              <span className="label-caps">全市场</span>
              <span className={`num ${toneClass(totals.score)}`}>
                净情绪 {fmtScore(totals.score)}
              </span>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                利好 {totals.bullish} · 利空 {totals.bearish} · 中性 {totals.neutral}
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              条形长度按板块信号权重(综合置信度 × 档位)归一,点击板块可筛选新闻
            </Typography.Text>
          </div>
          <div className="secboard">
            {rows.map((row) => (
              <SectorRow
                key={row.key}
                row={row}
                maxWeight={maxWeight}
                selected={selected === row.key}
                onSelect={onSelect}
              />
            ))}
          </div>
          {board.window?.truncated && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              该窗口分析条数超过采样上限,以上为部分样本。
            </Typography.Text>
          )}
        </>
      )}
    </Card>
  );
}
