import React from 'react';
import PnlChart from './PnlChart.jsx';
import StatsCards from './StatsCards.jsx';
import { fmtMoney, fmtNum, fmtPercent, fmtTime, SESSION_LABELS, TRIGGER_LABELS } from '../api.js';

export default function Dashboard({ portfolio, snapshots, trades, stats, status, onSymbolClick }) {
  return (
    <div className="dashboard">
      <StatsCards stats={stats} portfolio={portfolio} />

      <section className="card">
        <h2>账户净值走势</h2>
        <PnlChart
          snapshots={snapshots}
          trades={trades}
          initialCapital={portfolio?.initial_capital}
        />
      </section>

      <section className="card">
        <h2>当前持仓 {portfolio?.positions?.length ? `(${portfolio.positions.length})` : ''}</h2>
        {!portfolio?.positions?.length ? (
          <p className="empty">暂无持仓。AI 会在出现高档位利好新闻时自动建仓。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>数量</th>
                  <th>平均成本</th>
                  <th>现价</th>
                  <th>今日涨跌</th>
                  <th>止损 / 止盈</th>
                  <th>市值</th>
                  <th>浮动盈亏</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>
                      <button className="symbol symbol-link" onClick={() => onSymbolClick(p.symbol)}>
                        {p.symbol}
                      </button>
                    </td>
                    <td>{fmtNum(p.quantity, 4)}</td>
                    <td>{fmtMoney(p.avg_cost)}</td>
                    <td>
                      {fmtMoney(p.current_price)}
                      {p.session && p.session !== 'regular' && p.extended_price !== null && (
                        <span className="badge badge-session cell-badge">
                          {SESSION_LABELS[p.session]}
                          {p.extended_change_percent !== null &&
                            ` ${fmtPercent(p.extended_change_percent)}`}
                        </span>
                      )}
                    </td>
                    <td className={p.change_percent >= 0 ? 'up' : 'down'}>
                      {fmtPercent(p.change_percent)}
                    </td>
                    <td className="muted">
                      {p.stop_loss ? fmtMoney(p.stop_loss) : '—'} / {p.take_profit ? fmtMoney(p.take_profit) : '—'}
                    </td>
                    <td>{fmtMoney(p.market_value)}</td>
                    <td className={p.unrealized_pnl >= 0 ? 'up' : 'down'}>
                      {fmtMoney(p.unrealized_pnl)} ({fmtPercent(p.unrealized_pnl_percent)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>最近交易</h2>
        {!trades?.length ? (
          <p className="empty">暂无交易记录。</p>
        ) : (
          <ul className="trade-list">
            {trades.slice(0, 5).map((t) => (
              <li key={t.id} className="trade-item">
                <span className={`badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}`}>
                  {t.side === 'buy' ? '买入' : '卖出'}
                </span>
                {TRIGGER_LABELS[t.trigger] && (
                  <span className="badge badge-trigger">{TRIGGER_LABELS[t.trigger]}</span>
                )}
                <button className="symbol symbol-link" onClick={() => onSymbolClick(t.symbol)}>
                  {t.symbol}
                </button>
                <span>
                  {fmtNum(t.quantity, 4)} 股 @ {fmtMoney(t.price)}
                </span>
                <span className="muted">{fmtTime(t.created_at)}</span>
                {t.reason && <p className="reason">💡 {t.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {status && (
        <section className="card">
          <h2>系统状态</h2>
          <div className="status-grid">
            <div>
              <span className="muted">运行节奏</span> 新闻每 {status.pollSeconds} 秒 · 报价推送每{' '}
              {status.quotePushSeconds} 秒 · 净值快照每 {status.snapshotSeconds} 秒 · 止损监控每{' '}
              {status.riskCheckSeconds} 秒
            </div>
            <div>
              <span className="muted">分析模型</span> {status.model}
            </div>
            <div>
              <span className="muted">上次运行</span> {fmtTime(status.lastRunAt)}
            </div>
            {status.lastResult && (
              <div>
                <span className="muted">上轮结果</span> 新增新闻 {status.lastResult.newArticles} ·
                分析 {status.lastResult.analyzed} · 信号 {status.lastResult.signals} · 成交{' '}
                {status.lastResult.trades}
              </div>
            )}
            {status.lastError && (
              <div className="down">
                <span className="muted">错误</span> {status.lastError}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
