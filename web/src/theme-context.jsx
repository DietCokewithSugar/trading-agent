import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { buildThemeConfig } from './theme.js';

// 主题模式上下文:深色/浅色,默认深色,持久化到 localStorage。
// 不跟随系统 prefers-color-scheme —— 由用户显式切换。

const STORAGE_KEY = 'nt-theme';
const ThemeContext = createContext({ mode: 'dark', toggle: () => {} });

function readInitialMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage 不可用时回退默认值 */
  }
  return 'dark';
}

// 首屏渲染前同步设置 data-theme,避免浅色闪烁。
function applyDomTheme(mode) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

const INITIAL_MODE = readInitialMode();
applyDomTheme(INITIAL_MODE);

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(INITIAL_MODE);

  useEffect(() => {
    applyDomTheme(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 忽略持久化失败 */
    }
  }, [mode]);

  const value = useMemo(
    () => ({
      mode,
      toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')),
      setMode,
      themeConfig: buildThemeConfig(mode),
    }),
    [mode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeMode() {
  return useContext(ThemeContext);
}
