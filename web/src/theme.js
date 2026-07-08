// 全站配色与主题 token 的唯一来源(明暗双主题)。
// 设计语言:专业金融终端 —— 深蓝石墨底、克制的钢蓝交互色、数据密度优先、
// 颜色只编码数据(参考 IBKR / Robinhood 一类专业交易面板)。
// 美股市场惯例:绿涨红跌(绿=涨/利好/买入/盈利,红=跌/利空/卖出/亏损)。
// 盈亏着色一律引用这里的 getPnl(mode) / COLOR_UP / COLOR_DOWN 或 .up/.down 工具类,
// 不要在组件里散写色值。
// 维护注:styles.css 的 --up/--down/--muted 等 CSS 变量与本文件的盈亏色须保持同步,
// 本文件为权威定义。

import { theme as antdTheme } from 'antd';

// ---- 金融终端双调色板(蓝灰阶) ----
export const DARK = Object.freeze({
  black: '#0B0F17', // 页面底色:深蓝石墨,比纯黑更接近交易终端
  surface: '#111726',
  surfaceRaised: '#1A2233',
  border: '#1E2635',
  borderVisible: '#2C3850',
  textDisabled: '#5B6478',
  textSecondary: '#949DB2',
  textPrimary: '#E6EAF2',
  textDisplay: '#F7F9FC',
});

export const LIGHT = Object.freeze({
  black: '#F4F6FA', // 浅色模式下的"页面底色"
  surface: '#FFFFFF',
  surfaceRaised: '#EEF1F6',
  border: '#E4E8F0',
  borderVisible: '#C9D0DD',
  textDisabled: '#9AA3B5',
  textSecondary: '#5D6677',
  textPrimary: '#1C2333',
  textDisplay: '#0A0F1C',
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
// 交互主色:克制的钢蓝,只用于交互件(按钮/链接/选中态),绝不编码涨跌数据。
export const ACCENT_PRIMARY = Object.freeze({ dark: '#5B8DEF', light: '#1F5AE0' });
// 警示用去饱和琥珀 + 边框,绝不复用盈亏红(避免与"红=跌"冲突)。
export const ALERT = Object.freeze({ dark: '#D4A843', light: '#B7791F' });

// ---- 图表主题色(recharts 与 lightweight-charts 共用,按模式)----
export function getChart(mode) {
  if (mode === 'light') {
    return {
      grid: '#EAEDF3',
      axis: '#8A93A6',
      reference: '#B9C1D0',
      benchmark: '#8A93A6',
      benchmarkGold: '#C29B26',
      tooltipBg: '#FFFFFF',
      tooltipBorder: '#C9D0DD',
      tooltipShadow: 'none', // 阴影禁用,统一 1px 边框
      markerStroke: '#FFFFFF',
    };
  }
  return {
    grid: '#1B2231',
    axis: '#778095',
    reference: '#2C3850',
    benchmark: '#949DB2',
    benchmarkGold: '#D4A843',
    tooltipBg: '#1A2233',
    tooltipBorder: '#2C3850',
    tooltipShadow: 'none',
    markerStroke: '#0B0F17',
  };
}

// 兼容旧导出:默认深色图表色板。
export const CHART = getChart('dark');

// ---- 资产配置/多系列调色板:蓝灰阶梯(权重是序数,亮度阶梯比彩虹更诚实)----
const PIE_DARK = [
  '#E6EAF2', '#C3CBDC', '#9FA9C0', '#7E89A4', '#636E88',
  '#4D586F', '#3C465A', '#2E3749', '#232B3A',
];
const PIE_LIGHT = [
  '#1C2333', '#333D52', '#4C5870', '#65738E', '#8290AA',
  '#9FACC4', '#B9C4D8', '#D0D9E8', '#E2E8F2',
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
    "'Inter Variable', 'Inter', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";
  const monoFont = "'IBM Plex Mono', 'SF Mono', 'JetBrains Mono', monospace";

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
      borderRadius: 8,
      fontSize: 14,
      fontFamily: bodyFont,
      fontFamilyCode: monoFont,
      // 专业终端不用漂浮阴影:全部抹平,层级靠边框与底色
      boxShadow: 'none',
      boxShadowSecondary: 'none',
      boxShadowTertiary: 'none',
      wireframe: false,
    },
    components: {
      Card: {
        boxShadowTertiary: 'none',
        colorBgContainer: p.surface,
        borderRadiusLG: 10,
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
        borderRadiusSM: 4,
        colorBorder: p.borderVisible,
      },
      Tabs: {
        inkBarColor: primary,
        itemColor: p.textSecondary,
        itemSelectedColor: p.textDisplay,
        itemHoverColor: p.textPrimary,
        horizontalItemGutter: 24,
      },
      Segmented: {
        itemSelectedBg: p.surfaceRaised,
        itemSelectedColor: p.textDisplay,
        itemColor: p.textSecondary,
        trackBg: isDark ? '#0E131E' : '#E9EDF4',
        borderRadius: 6,
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
