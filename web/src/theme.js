// 全站配色的唯一来源。
// 美股市场惯例:绿涨红跌(绿=涨/利好/买入/盈利,红=跌/利空/卖出/亏损)。
// 盈亏着色一律引用这里的常量或 .up/.down 工具类,不要在组件里散写色值。
export const COLOR_UP = '#389e0d'; // antd green-7
export const COLOR_DOWN = '#cf1322'; // antd red-7

// Recharts 浅色主题用到的中性色
export const CHART = {
  grid: '#e8e8e8',
  axis: '#8c8c8c',
  reference: '#bfbfbf',
  benchmark: '#8c8c8c',
  tooltipBg: '#ffffff',
  tooltipBorder: '#d9d9d9',
  tooltipShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  markerStroke: '#ffffff',
};

// 资产配置饼图的切片色(浅色背景可读)
export const PIE_COLORS = [
  '#1677ff',
  '#389e0d',
  '#cf1322',
  '#d48806',
  '#722ed1',
  '#13c2c2',
  '#eb2f96',
  '#597ef7',
  '#8c8c8c',
];

// antd ConfigProvider 主题(默认浅色算法)
export const themeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 8,
    fontSize: 14,
  },
};
