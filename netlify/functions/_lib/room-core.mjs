/**
 * ============================================================================
 * room-core.mjs —— 线上双人房间核心（Netlify Functions / 本地 Vite 共用）
 * ============================================================================
 * Netlify 静态托管不支持 WebSocket 长连接，因此线上联机走「短轮询」：
 *   客户端每 250ms 发一次 POST（上报自己的位置，同时取回队友位置与回家信号），
 *   服务端用 Netlify Blobs 保存房间状态。两台手机打开不同链接、同一房间即可
 *   互相看见并一起回家。
 *
 * 存储只要求两个方法：getJSON(key) / setJSON(key, value)。
 *   - Netlify 生产：netlify/functions/room.mjs 用 @netlify/blobs 适配；
 *   - 本地 dev / 测试：createMemoryStore() 进程内 Map。
 *
 * 协议（POST /api/room）：
 *   {action:'login', room, user, pass} → {ok, token, id, name, color, room}
 *   {action:'sync',  room, token, state} → {ok, now, peers, signal}
 *   {action:'home',  room, token} → {ok, signal}
 * ============================================================================
 */
import crypto from 'node:crypto';
import accountsConfig from './accounts.mjs';

const DEFAULT_ROOM = 'home';
const MAX_ROOM_LENGTH = 32;
const MAX_PLAYERS = 8;
const STATE_TTL_MS = 15000;
const SIGNAL_TTL_MS = 8000;
const HOME_COOLDOWN_MS = 2200;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_SECRET = 'playground-online-demo-secret';

const ACCOUNTS = (accountsConfig?.accounts || [])
  .filter((a) => a && typeof a.user === 'string' && a.user && typeof a.pass === 'string' && a.pass)
  .map((a) => ({
    user: a.user,
    pass: a.pass,
    name: String(a.name || a.user),
    color: /^#[0-9a-fA-F]{6}$/.test(a.color || '') ? a.color : '#8fd0ff',
  }));
const ACCOUNT_MAP = new Map(ACCOUNTS.map((a) => [a.user, a]));

const STATE_KEYS = new Set(['lobby', 'villa', 'facility']);

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    x: Number(clampNumber(s.x, -1000, 1000).toFixed(2)),
    y: Number(clampNumber(s.y, -1000, 1000).toFixed(2)),
    z: Number(clampNumber(s.z, -1000, 1000).toFixed(2)),
    yaw: Number(clampNumber(s.yaw, -20, 20).toFixed(3)),
    speed: Number(clampNumber(s.speed, 0, 40).toFixed(2)),
    zone: STATE_KEYS.has(s.zone) ? s.zone : 'lobby',
    ready: s.ready === true,
  };
}

export function normalizeRoom(room) {
  const value = String(room || DEFAULT_ROOM).trim();
  return new RegExp(`^[a-zA-Z0-9_-]{1,${MAX_ROOM_LENGTH}}$`).test(value) ? value : null;
}

export function createMemoryStore() {
  const data = new Map();
  return {
    async getJSON(key) {
      const value = data.get(key);
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    async setJSON(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    _dump() {
      return new Map(data);
    },
  };
}

function signToken(user, secret, now) {
  const payload = Buffer.from(`${user}.${now}`, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token, secret, now) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  let decoded = '';
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const split = decoded.lastIndexOf('.');
  if (split <= 0) return null;
  const user = decoded.slice(0, split);
  const issuedAt = Number(decoded.slice(split + 1));
  if (!ACCOUNT_MAP.has(user) || !Number.isFinite(issuedAt)) return null;
  if (now - issuedAt > TOKEN_TTL_MS || issuedAt > now + 60_000) return null;
  return user;
}

const stateKey = (room) => `multiplayer/${room}/state`;
const signalKey = (room) => `multiplayer/${room}/signal`;

function fail(status, error) {
  return { status, json: { ok: false, error } };
}

function createSignal(user, now) {
  return {
    id: crypto.randomUUID(),
    type: 'go_home',
    from: { id: user, name: ACCOUNT_MAP.get(user)?.name || user },
    at: now,
  };
}

/**
 * 处理一次房间请求。
 * @param {{store:{getJSON:Function,setJSON:Function}, body:object, secret?:string, now?:number}} input
 * @returns {Promise<{status:number, json:object}>}
 */
export async function handleRoomApi({ store, body, secret = DEFAULT_SECRET, now = Date.now() }) {
  if (!store || typeof store.getJSON !== 'function' || typeof store.setJSON !== 'function') {
    throw new Error('[联机] 缺少 store');
  }
  const msg = body && typeof body === 'object' ? body : {};
  const room = normalizeRoom(msg.room);
  if (!room) return fail(400, '房间号不合法');

  /* ---------------- 登录：只在这里校验密码，返回签名 token ---------------- */
  if (msg.action === 'login') {
    const user = String(msg.user || '').trim();
    const pass = String(msg.pass || '');
    const account = ACCOUNT_MAP.get(user);
    if (!account || account.pass !== pass) return fail(401, '账号或密码不正确');

    const current = await store.getJSON(stateKey(room));
    const players = current?.players && typeof current.players === 'object' ? current.players : {};
    const activeCount = Object.values(players).filter((p) => p && now - Number(p.updatedAt) <= STATE_TTL_MS).length;
    if (!players[user] && activeCount >= MAX_PLAYERS) return fail(429, '房间已满（最多 8 人）');

    return {
      status: 200,
      json: {
        ok: true,
        room,
        token: signToken(user, secret, now),
        id: user,
        name: account.name,
        color: account.color,
      },
    };
  }

  const user = verifyToken(msg.token, secret, now);
  if (!user) return fail(401, '登录已失效，请重新登录');
  const account = ACCOUNT_MAP.get(user);
  if (!account) return fail(401, '账号不存在');

  /* ---------------- 同步：写自己 + 读队友 + 读回家信号 ---------------- */
  if (msg.action === 'sync') {
    const current = await store.getJSON(stateKey(room));
    const players = current?.players && typeof current.players === 'object' ? current.players : {};

    players[user] = {
      id: user,
      name: account.name,
      color: account.color,
      state: normalizeState(msg.state),
      updatedAt: now,
    };
    for (const [id, player] of Object.entries(players)) {
      if (!player || now - Number(player.updatedAt) > STATE_TTL_MS) delete players[id];
    }

    await store.setJSON(stateKey(room), { players, updatedAt: now });

    const peers = Object.values(players)
      .filter((p) => p.id !== user)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        state: p.state,
        updatedAt: p.updatedAt,
      }));

    const signal = await store.getJSON(signalKey(room));
    const activeSignal = signal && signal.from?.id !== user && now - Number(signal.at) <= SIGNAL_TTL_MS
      ? signal
      : null;

    return { status: 200, json: { ok: true, room, now, peers, signal: activeSignal } };
  }

  /* ---------------- 一起回家：写一个短时信号，队友下次 sync 收到 ---------------- */
  if (msg.action === 'home') {
    const previous = await store.getJSON(signalKey(room));
    if (previous?.from?.id === user && now - Number(previous.at) < HOME_COOLDOWN_MS) {
      return { status: 200, json: { ok: true, signal: previous, deduped: true } };
    }
    const signal = createSignal(user, now);
    await store.setJSON(signalKey(room), signal);
    return { status: 200, json: { ok: true, signal } };
  }

  return fail(400, '未知操作');
}

export const ROOM_CONSTANTS = Object.freeze({
  DEFAULT_ROOM,
  MAX_PLAYERS,
  STATE_TTL_MS,
  SIGNAL_TTL_MS,
  HOME_COOLDOWN_MS,
  DEFAULT_SECRET,
});

export default handleRoomApi;