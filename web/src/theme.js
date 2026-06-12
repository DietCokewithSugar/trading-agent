// 全站视觉的唯一来源:「机构研究台账」风格(墨蓝桅头 + 纸面台账 + 石青主色 + 等宽数字)。
// 美股市场惯例:绿涨红跌(绿=涨/利好/买入/盈利,红=跌/利空/卖出/亏损)。
// 盈亏着色一律引用这里的常量或 .up/.down 工具类,不要在组件里散写色值。
export const COLOR_UP = '#0e7c3f'; // 深市绿(压低饱和度,避免糖果感)
export const COLOR_DOWN = '#bf2c3f'; // 深市红

// 主色:石青(偏青的深海军蓝),用于链接 / 按钮 / 选中态
export const COLOR_ACCENT = '#234c6a';

// Recharts 浅色主题用到的中性色
export const CHART = {
  grid: '#e9ece9',
  axis: '#98a1a8',
  reference: '#c3c9c3',
  benchmark: '#9aa3ad',
  benchmarkGold: '#b08a3e', // 黄金基准线(老金,区别于灰色的标普500)
  tooltipBg: '#ffffff',
  tooltipBorder: '#e7eae6',
  tooltipShadow: '0 4px 16px rgba(22, 38, 59, 0.1)',
  markerStroke: '#ffffff',
};

// 资产配置饼图切片:低饱和的台账色系(涨跌语义色刻意排后,避免误读为盈亏)
export const PIE_COLORS = [
  '#234c6a', // 石青
  '#b08a3e', // 老金
  '#3d7a82', // 黛青
  '#8c5b6e', // 绛紫
  '#5b7286', // 青灰
  '#0e7c3f', // 深市绿
  '#6b5b7a', // 鸢尾
  '#bf2c3f', // 深市红
  '#9aa3ad', // 中性灰
];

// antd ConfigProvider 主题(浅色算法 + 台账质感:细线、小圆角、收敛的语义色)
export const themeConfig = {
  token: {
    colorPrimary: COLOR_ACCENT,
    colorInfo: COLOR_ACCENT,
    colorLink: COLOR_ACCENT,
    colorSuccess: COLOR_UP,
    colorError: COLOR_DOWN,
    colorWarning: '#9a6700',
    colorTextBase: '#1f2a37',
    colorBgLayout: '#f3f4f2',
    colorBorderSecondary: '#e7eae6',
    borderRadius: 3,
    borderRadiusSM: 2,
    borderRadiusLG: 4,
    fontSize: 14,
  },
  components: {
    Card: {
      headerHeight: 46,
      headerHeightSM: 40,
    },
    Table: {
      headerBg: '#fafbf9',
      headerColor: 'rgba(31, 42, 55, 0.55)',
      headerSplitColor: 'transparent',
      rowHoverBg: '#f6f8f6',
    },
    Tabs: {
      titleFontSize: 14,
      horizontalItemGutter: 28,
      itemColor: 'rgba(31, 42, 55, 0.6)',
    },
    Statistic: {
      titleFontSize: 12,
    },
    Tag: {
      borderRadiusSM: 2,
    },
  },
};
