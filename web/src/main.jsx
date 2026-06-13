import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App.jsx';
import { ThemeProvider, useThemeMode } from './theme-context.jsx';
import './fonts.css';
import './styles.css';

dayjs.locale('zh-cn');

// 读取当前主题模式并把对应的 antd 配置交给 ConfigProvider
function ThemedApp() {
  const { themeConfig } = useThemeMode();
  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      {/* AntApp 提供 message/notification 的上下文(主题与中文文案) */}
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  </React.StrictMode>
);
