/**
 * ============================================================================
 * local-room-api.mjs —— 本地 dev / preview 的 /api/room 中间件
 * ============================================================================
 * 与 Netlify Functions 共用 netlify/functions/_lib/room-core.mjs 的协议与规则，
 * 只把存储换成进程内 Map。于是 `npm run dev` 就能在两台本机浏览器里验证联机，
 * 不需要装 Netlify CLI，也不会出现“线上是另一套逻辑”的割裂。
 * ============================================================================
 */
import { handleRoomApi, createMemoryStore } from '../netlify/functions/_lib/room-core.mjs';

const API_PATH = '/api/room';
const MAX_BODY_BYTES = 16 * 1024;
const memoryStore = createMemoryStore();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function attachLocalRoomApi(middlewares) {
  if (!middlewares || typeof middlewares.use !== 'function') return false;

  middlewares.use(async (req, res, next) => {
    const path = (req.url || '').split('?')[0];
    if (path !== API_PATH) {
      next();
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: '只支持 POST' });
      return;
    }

    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : null;
    } catch {
      send(res, 400, { ok: false, error: '请求格式不合法' });
      return;
    }

    try {
      const result = await handleRoomApi({ store: memoryStore, body });
      send(res, result.status, result.json);
    } catch (err) {
      console.error('[联机] 本地 API 处理失败：', err);
      send(res, 500, { ok: false, error: '联机服务暂时不可用' });
    }
  });

  console.info('[联机] 本地 /api/room 已挂载（内存房间；线上由 Netlify Functions + Blobs 提供）');
  return true;
}

export default attachLocalRoomApi;