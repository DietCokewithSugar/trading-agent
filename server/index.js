import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, assertConfig } from './config.js';
import apiRouter from './routes/api.js';
import { startScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

// 托管前端构建产物
const dist = path.join(__dirname, '../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res
      .status(200)
      .send('前端尚未构建。请运行 npm run build 后重启,或仅使用 /api/* 接口。');
  });
}

const missing = assertConfig();
app.listen(config.port, () => {
  console.log(`[server] 服务已启动: http://localhost:${config.port}`);
  if (missing.length === 0) {
    startScheduler();
  } else {
    console.warn('[server] 因缺少环境变量,定时任务未启动');
  }
});
