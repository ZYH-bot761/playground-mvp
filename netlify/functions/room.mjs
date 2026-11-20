/**
 * Netlify Functions v2：POST /api/room
 * 静态站点 + Functions + Blobs 即可完成“两台手机进同一房间互相看见”。
 * 本地开发不经过这个函数，由 server/local-room-api.mjs 提供同协议内存版。
 */
import { getStore } from '@netlify/blobs';
import { handleRoomApi } from './_lib/room-core.mjs';

const SECRET = process.env.MULTIPLAYER_SECRET || 'playground-online-demo-secret';

export const config = { path: '/api/room' };

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default async (request) => {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: '只支持 POST' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, error: '请求格式不合法' });
  }

  try {
    const store = getStore({ name: 'playground-multiplayer', consistency: 'strong' });
    const result = await handleRoomApi({ store, body, secret: SECRET });
    return json(result.status, result.json);
  } catch (err) {
    console.error('[联机] Netlify Function 处理失败：', err);
    return json(500, { ok: false, error: '联机服务暂时不可用' });
  }
};