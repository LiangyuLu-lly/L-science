import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// UI 包走 bundler 解析（Vite），相对导入不带扩展名，与后端包的 NodeNext 惯例不同。
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
