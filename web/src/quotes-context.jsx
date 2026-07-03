import React, { createContext, useContext } from 'react';

// 实时报价上下文:App 持有 SSE quotes 事件的最新载荷(持仓 + 候选池 top 符号的
// 紧凑报价映射),候选池表格/个股弹窗等任意深度组件按需消费——避免为此
// 层层透传 props。quotes 以大写 symbol 为键,值含 effective_price /
// extended_price / extended_change_percent / change_percent / session。

const EMPTY = { quotes: {}, ts: null, session: null };
const QuotesContext = createContext(EMPTY);

export function QuotesProvider({ value, children }) {
  return <QuotesContext.Provider value={value || EMPTY}>{children}</QuotesContext.Provider>;
}

export function useLiveQuotes() {
  return useContext(QuotesContext);
}
