// 全站配色与主题 token 的唯一来源(现为明暗双主题)。
// 设计语言:Nothing —— 单色为底、排版驱动、工业精密、颜色只编码数据。
// 美股市场惯例:绿涨红跌(绿=涨/利好/买入/盈利,红=跌/利空/卖出/亏损)。
// 盈亏着色一律引用这里的 getPnl(mode) / COLOR_UP / COLOR_DOWN 或 .up/.down 工具类,
// 不要在组件里散写色值。
// 维护注:styles.css 的 --up/--down/--muted 等 CSS 变量与本文件的盈亏色须保持同步,
// 本文件为权威定义。

import { theme as antdTheme } from 'antd';

// ---- Nothing 双调色板 ----
export const DARK = Object.freeze({
  black: '#000000',
  surface: '#111111',
  surfaceRaised: '#1A1A1A',
  border: '#222222',
  borderVisible: '#333333',
  textDisabled: '#666666',
  textSecondary: '#999999',
  textPrimary: '#E8E8E8',
  textDisplay: '#FFFFFF',
});

export const LIGHT = Object.freeze({
  black: '#F5F5F5', // 浅色模式下的"页面底色"
  surface: '#FFFFFF',
  surfaceRaised: '#F0F0F0',
  border: '#E8E8E8',
  borderVisible: '#CCCCCC',
  textDisabled: '#999999',
  textSecondary: '#666666',
  textPrimary: '#1A1A1A',
  textDisplay: '#000000',
});

// ---- 盈亏色(按背景分别调校以保证对比度)----
// 深色底用更亮更饱和的绿/红(antd green-7/red-7 在 #000 上会发灰);浅色沿用经典值。
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
// 主色单色化:深色用白、浅色用黑(不再用 antd 蓝)。
export const ACCENT_PRIMARY = Object.freeze({ dark: '#FFFFFF', light: '#000000' });
// 警示用去饱和琥珀 + 边框,绝不复用盈亏红(避免与"红=跌"冲突)。
export const ALERT = Object.freeze({ dark: '#D4A843', light: '#B7791F' });

// ---- Recharts 主题色(按模式)----
export function getChart(mode) {
  if (mode === 'light') {
    return {
      grid: '#e8e8e8',
      axis: '#8c8c8c',
      reference: '#bfbfbf',
      benchmark: '#8c8c8c',
      benchmarkGold: '#d4a017',
      tooltipBg: '#ffffff',
      tooltipBorder: '#d9d9d9',
      tooltipShadow: 'none', // Nothing 禁用阴影,改用 1px 边框
      markerStroke: '#ffffff',
    };
  }
  return {
    grid: '#222222',
    axis: '#777777',
    reference: '#333333',
    benchmark: '#999999',
    benchmarkGold: '#d4a017',
    tooltipBg: '#1a1a1a',
    tooltipBorder: '#333333',
    tooltipShadow: 'none',
    markerStroke: '#000000', // 深色净值线上买卖点描边用黑色才能读出
  };
}

// 兼容旧导出:默认深色图表色板。
export const CHART = getChart('dark');

// ---- 资产配置/多系列调色板:单色阶梯灰度(权重是序数,亮度阶梯比彩虹更诚实)----
const PIE_DARK = [
  '#FFFFFF', '#D9D9D9', '#B0B0B0', '#8A8A8A', '#6E6E6E',
  '#565656', '#444444', '#373737', '#2C2C2C',
];
const PIE_LIGHT = [
  '#000000', '#333333', '#555555', '#777777', '#999999',
  '#B0B0B0', '#C4C4C4', '#D6D6D6', '#E2E2E2',
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
    "'Space Grotesk', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif";
  const monoFont = "'Space Mono', 'JetBrains Mono', 'SF Mono', monospace";

  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: primary,
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
      // Nothing 禁用阴影:全部抹平
      boxShadow: 'none',
      boxShadowSecondary: 'none',
      boxShadowTertiary: 'none',
      wireframe: false,
    },
    components: {
      Card: {
        boxShadowTertiary: 'none',
        colorBgContainer: p.surface,
        borderRadiusLG: 12,
      },
      Table: {
        headerBg: p.surfaceRaised,
        headerColor: p.textSecondary,
        borderColor: p.border,
        rowHoverBg: p.surfaceRaised,
        colorBgContainer: p.surface,
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
        trackBg: p.surface,
        borderRadius: 6,
      },
      Button: {
        // 主按钮:深色=白底黑字,浅色=黑底白字
        colorTextLightSolid: isDark ? p.black : '#FFFFFF',
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
