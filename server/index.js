import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, assertConfig } from './config.js';
import apiRouter from './routes/api.js';
import adminRouter from './routes/admin.js';
import { startScheduler } from './scheduler.js';
import { loadTradingHalt } from './services/tradingHalt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Render 部署在单层反向代理之后:信任第一跳代理,req.ip 才是真实客户端 IP
//(鉴权失败限流按 IP 计数,不可信任伪造的 X-Forwarded-For 链);
// 无代理直连部署需 TRUST_PROXY=0,否则伪造 XFF 可绕过按 IP 的限流
app.set('trust proxy', config.trustProxy);
app.use(express.json());
app.use('/api/admin', adminRouter);
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
  // 人工交易暂停开关跨重启持久化,与调度是否启动无关;内部自行容错,绝不抛错
  loadTradingHalt().catch(() => {});
  if (missing.length === 0) {
    startScheduler();
  } else {
    console.warn('[server] 因缺少环境变量,定时任务未启动');
  }
});
