import { EventEmitter } from 'node:events';

/** 进程内事件总线 + SSE 客户端管理:实现服务端 → 浏览器的秒级推送 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const clients = new Set();

export function clientCount() {
  return clients.size;
}

/** GET /api/stream 的 SSE 处理器 */
export function sseHandler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  clients.add(res);
  // 心跳防止代理(如 Render)断开空闲连接
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/** 向所有在线客户端推送事件 */
export function broadcast(event, data) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}
