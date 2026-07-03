import React, { createContext, useContext } from 'react';

// 实时报价上下文:App 持有 SSE quotes 事件的最新报价映射(持仓 + 候选池 top 符号),
// 候选池表格/个股弹窗等任意深度组件按需消费——避免为此层层透传 props。
// 值为 大写 symbol → { effective_price / extended_price / extended_change_percent /
// change_percent / session } 的普通对象;SSE 断线或管理重置时被清空(消费方回退拉取值)。

const QuotesContext = createContext({});

export function QuotesProvider({ value, children }) {
  return <QuotesContext.Provider value={value || {}}>{children}</QuotesContext.Provider>;
}

/** 返回 symbol → 实时报价 的映射(无数据时为空对象) */
export function useLiveQuotes() {
  return useContext(QuotesContext);
}
