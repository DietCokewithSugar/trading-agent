// 全站配色与主题 token 的唯一来源(明暗双主题)。
// 设计语言:Claude 风格的暖炭交易终端 —— 暖近黑底、陶土色(clay)交互点缀、
// 大圆角卡片、数据密度优先;颜色只编码数据,亮色点缀只给交互件。
// 美股市场惯例:绿涨红跌(绿=涨/利好/买入/盈利,红=跌/利空/卖出/亏损)。
// 盈亏着色一律引用这里的 getPnl(mode) / COLOR_UP / COLOR_DOWN 或 .up/.down 工具类,
// 不要在组件里散写色值。
// 维护注:styles.css 的 --up/--down/--muted 等 CSS 变量与本文件的盈亏色须保持同步,
// 本文件为权威定义。

import { theme as antdTheme } from 'antd';

// ---- 暖炭双调色板 ----
export const DARK = Object.freeze({
  black: '#141413', // 页面底色:暖近黑(非蓝调、非纯黑)
  surface: '#1C1C1A',
  surfaceRaised: '#262624',
  border: '#2A2A27',
  borderVisible: '#3B3B36',
  textDisabled: '#6B6862',
  textSecondary: '#A29F98',
  textPrimary: '#E8E6E1',
  textDisplay: '#F5F4F0',
});

export const LIGHT = Object.freeze({
  black: '#FAF9F5', // 浅色模式下的"页面底色":暖米白
  surface: '#FFFFFF',
  surfaceRaised: '#F0EEE7',
  border: '#E8E6DE',
  borderVisible: '#D1CEC3',
  textDisabled: '#A29F96',
  textSecondary: '#6E6B63',
  textPrimary: '#21201C',
  textDisplay: '#131210',
});

// ---- 盈亏色(按背景分别调校以保证对比度)----
// 深色底用更亮更饱和的绿/红;浅色沿用经典值。盈亏符号(+/-)始终随色值一起出现,
// 保证红绿色弱用户仍可通过符号读出方向。
export const PNL = Object.freeze({
  dark: { up: '#3DD68C', down: '#FF5C5C' },
  light: { up: '#389e0d', down: '#cf1322' },
});

export function getPnl(mode) {
  return PNL[mode] || PNL.dark;
}

// 兼容旧导出(默认深色)。AdminPage 等只取红色文字处仍可直接引用。
export const COLOR_UP = PNL.dark.up;
export const COLOR_DOWN = PNL.dark.down;

// ---- 交互主色与警示色 ----
// 交互主色:陶土色(clay),只用于交互件(按钮/链接/选中态),绝不编码涨跌数据
// (与盈亏红可区分:陶土偏橙、低饱和;数据红更冷更亮)。
export const ACCENT_PRIMARY = Object.freeze({ dark: '#D97757', light: '#C15F3C' });
// 警示用去饱和琥珀 + 边框,绝不复用盈亏红(避免与"红=跌"冲突)。
export const ALERT = Object.freeze({ dark: '#D4A843', light: '#B7791F' });

// ---- 图表主题色(recharts 与 lightweight-charts 共用,按模式)----
export function getChart(mode) {
  if (mode === 'light') {
    return {
      grid: '#ECEAE2',
      axis: '#94918A',
      reference: '#C4C1B6',
      benchmark: '#94918A',
      benchmarkGold: '#C29B26',
      tooltipBg: '#FFFFFF',
      tooltipBorder: '#D1CEC3',
      tooltipShadow: 'none', // 阴影禁用,统一 1px 边框
      markerStroke: '#FFFFFF',
    };
  }
  return {
    grid: '#242422',
    axis: '#84817A',
    reference: '#3B3B36',
    benchmark: '#A29F98',
    benchmarkGold: '#D4A843',
    tooltipBg: '#262624',
    tooltipBorder: '#3B3B36',
    tooltipShadow: 'none',
    markerStroke: '#141413',
  };
}

// 兼容旧导出:默认深色图表色板。
export const CHART = getChart('dark');

// ---- 资产配置/多系列调色板:暖灰阶梯(权重是序数,亮度阶梯比彩虹更诚实)----
const PIE_DARK = [
  '#E8E6E1', '#C9C6BF', '#ABA79F', '#8E8B83', '#737068',
  '#5C5952', '#48453F', '#37352F', '#2A2822',
];
const PIE_LIGHT = [
  '#21201C', '#3B3934', '#55524B', '#6E6B63', '#88857C',
  '#A29F96', '#BCB9AF', '#D3D0C6', '#E5E2D9',
];

export function getPieColors(mode) {
  return mode === 'light' ? PIE_LIGHT : PIE_DARK;
}

// 兼容旧导出。
export const PIE_COLORS = PIE_DARK;

// ---- antd ConfigProvider 主题(按模式构建)----
export function buildThemeConfig(mode) {
  const isDark = mode !== 'light';
  const p = isDark ? DARK : LIGHT;
  const primary = isDark ? ACCENT_PRIMARY.dark : ACCENT_PRIMARY.light;
  const bodyFont =
    "'Archivo Variable', 'Archivo', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";
  const monoFont = "'JetBrains Mono', 'SF Mono', 'Menlo', monospace";

  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorLink: primary,
      colorBgBase: p.black,
      colorBgLayout: p.black,
      colorBgContainer: p.surface,
      colorBgElevated: p.surfaceRaised,
      colorBorder: p.borderVisible,
      colorBorderSecondary: p.border,
      colorText: p.textPrimary,
      colorTextSecondary: p.textSecondary,
      colorTextTertiary: p.textDisabled,
      colorTextQuaternary: p.textDisabled,
      colorTextDescription: p.textSecondary,
      borderRadius: 10,
      fontSize: 14,
      fontFamily: bodyFont,
      fontFamilyCode: monoFont,
      // 终端质感不用漂浮阴影:全部抹平,层级靠边框与底色
      boxShadow: 'none',
      boxShadowSecondary: 'none',
      boxShadowTertiary: 'none',
      wireframe: false,
    },
    components: {
      Card: {
        boxShadowTertiary: 'none',
        colorBgContainer: p.surface,
        borderRadiusLG: 14,
        headerFontSize: 14,
      },
      Table: {
        headerBg: 'transparent',
        headerColor: p.textSecondary,
        headerSplitColor: 'transparent',
        borderColor: p.border,
        rowHoverBg: p.surfaceRaised,
        colorBgContainer: 'transparent',
        cellPaddingBlockSM: 10,
      },
      Tag: {
        // 边框等宽方角药丸:透明底 + 1px 边框
        defaultBg: 'transparent',
        defaultColor: p.textSecondary,
        borderRadiusSM: 5,
        colorBorder: p.borderVisible,
      },
      Tabs: {
        inkBarColor: primary,
        itemColor: p.textSecondary,
        itemSelectedColor: p.textDisplay,
        itemHoverColor: p.textPrimary,
        horizontalItemGutter: 22,
      },
      Segmented: {
        itemSelectedBg: isDark ? '#33332F' : '#FFFFFF',
        itemSelectedColor: p.textDisplay,
        itemColor: p.textSecondary,
        trackBg: isDark ? '#111110' : '#ECEAE2',
        borderRadius: 8,
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        borderColorDisabled: p.border,
      },
      Statistic: {
        contentFontSize: 20,
        colorText: p.textDisplay,
      },
      Modal: {
        contentBg: p.surface,
        headerBg: p.surface,
      },
      Input: {
        colorBgContainer: p.surface,
        activeBorderColor: primary,
        hoverBorderColor: p.textSecondary,
      },
      Select: {
        colorBgContainer: p.surface,
      },
      DatePicker: {
        colorBgContainer: p.surface,
      },
      Collapse: {
        headerBg: 'transparent',
        contentBg: 'transparent',
      },
      Badge: {
        colorBorderBg: p.surface,
      },
      Empty: {
        colorTextDescription: p.textDisabled,
      },
    },
  };
}

// 兼容旧导出:默认深色主题配置。
export const themeConfig = buildThemeConfig('dark');
