/**
 * ============================================================================
 * room-core.mjs —— 线上双人房间核心（Netlify Functions / 本地 Vite 共用）
 * ============================================================================
 * Netlify 静态托管不支持 WebSocket 长连接，因此线上联机走「短轮询」：
 *   客户端每 250ms 发一次 POST（上报自己的位置，同时取回队友位置与回家信号），
 *   服务端用 Netlify Blobs 保存房间状态。两台手机打开不同链接、同一房间即可
 *   互相看见并一起回家。
 *
 * 会话规则（解决同账号占用）：
 *   - 每次登录生成新的 session，写进房间状态；旧 session 的下一次 sync 会收到
 *     409 SESSION_REPLACED，客户端停止联机，不再互踢；
 *   - 退出页面时客户端 sendBeacon leave，立即释放账号；异常退出由 15s TTL 兜底；
 *   - 后打开的设备自然接管，前一台自动停止，因此同一账号可以在不同手机上反复使用。
 *
 * 存储只要求两个方法：getJSON(key) / setJSON(key, value)。
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
const DEFAULT_STATE = Object.freeze({
  x: 0, y: 1.65, z: 24, yaw: 0, speed: 0, zone: 'lobby', ready: false,
});

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

function signToken(user, session, secret, now) {
  const payload = Buffer.from(`${user}.${session}.${now}`, 'utf8').toString('base64url');
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
  const last = decoded.lastIndexOf('.');
  if (last <= 0) return null;
  const before = decoded.lastIndexOf('.', last - 1);
  if (before <= 0) return null;
  const user = decoded.slice(0, before);
  const session = decoded.slice(before + 1, last);
  const issuedAt = Number(decoded.slice(last + 1));
  if (!ACCOUNT_MAP.has(user) || !session || !Number.isFinite(issuedAt)) return null;
  if (now - issuedAt > TOKEN_TTL_MS || issuedAt > now + 60_000) return null;
  return { user, session };
}

const stateKey = (room) => `multiplayer/${room}/state`;
const signalKey = (room) => `multiplayer/${room}/signal`;

function fail(status, error, code) {
  return { status, json: { ok: false, error, ...(code ? { code } : {}) } };
}

function createSignal(user, now) {
  return {
    id: crypto.randomUUID(),
    type: 'go_home',
    from: { id: user, name: ACCOUNT_MAP.get(user)?.name || user },
    at: now,
  };
}

function readPlayers(current) {
  return current?.players && typeof current.players === 'object' ? current.players : {};
}

function dropExpired(players, now) {
  for (const [id, player] of Object.entries(players)) {
    if (!player || now - Number(player.updatedAt) > STATE_TTL_MS) delete players[id];
  }
}

function toPeer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    state: player.state,
    updatedAt: player.updatedAt,
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

  /* ---------------- 登录：校验密码，生成新 session 并立即接管该账号 ---------------- */
  if (msg.action === 'login') {
    const user = String(msg.user || '').trim();
    const pass = String(msg.pass || '');
    const account = ACCOUNT_MAP.get(user);
    if (!account || account.pass !== pass) return fail(401, '账号或密码不正确');

    const current = await store.getJSON(stateKey(room));
    const players = readPlayers(current);
    dropExpired(players, now);
    const activeCount = Object.values(players).length;
    if (!players[user] && activeCount >= MAX_PLAYERS) return fail(429, '房间已满（最多 8 人）');

    const session = crypto.randomUUID();
    players[user] = {
      id: user,
      name: account.name,
      color: account.color,
      state: normalizeState(players[user]?.state || DEFAULT_STATE),
      session,
      updatedAt: now,
    };
    await store.setJSON(stateKey(room), { players, updatedAt: now });

    return {
      status: 200,
      json: {
        ok: true,
        room,
        token: signToken(user, session, secret, now),
        session,
        id: user,
        name: account.name,
        color: account.color,
      },
    };
  }

  const auth = verifyToken(msg.token, secret, now);
  if (!auth) return fail(401, '登录已失效，请重新登录');
  const account = ACCOUNT_MAP.get(auth.user);
  if (!account) return fail(401, '账号不存在');

  /* ---------------- 同步：写自己 + 读队友 + 读回家信号 ---------------- */
  if (msg.action === 'sync') {
    const current = await store.getJSON(stateKey(room));
    const players = readPlayers(current);
    const existing = players[auth.user];
    if (existing?.session && existing.session !== auth.session) {
      return fail(409, '账号已在另一台设备打开', 'SESSION_REPLACED');
    }

    players[auth.user] = {
      id: auth.user,
      name: account.name,
      color: account.color,
      state: normalizeState(msg.state),
      session: auth.session,
      updatedAt: now,
    };
    dropExpired(players, now);
    await store.setJSON(stateKey(room), { players, updatedAt: now });

    const peers = Object.values(players)
      .filter((p) => p && p.id !== auth.user)
      .map(toPeer);

    const signal = await store.getJSON(signalKey(room));
    const activeSignal = signal && signal.from?.id !== auth.user && now - Number(signal.at) <= SIGNAL_TTL_MS
      ? signal
      : null;

    return { status: 200, json: { ok: true, room, now, peers, signal: activeSignal } };
  }

  /* ---------------- 一起回家：写一个短时信号，队友下次 sync 收到 ---------------- */
  if (msg.action === 'home') {
    const current = await store.getJSON(stateKey(room));
    const players = readPlayers(current);
    if (players[auth.user]?.session && players[auth.user].session !== auth.session) {
      return fail(409, '账号已在另一台设备打开', 'SESSION_REPLACED');
    }

    const previous = await store.getJSON(signalKey(room));
    if (previous?.from?.id === auth.user && now - Number(previous.at) < HOME_COOLDOWN_MS) {
      return { status: 200, json: { ok: true, signal: previous, deduped: true } };
    }
    const signal = createSignal(auth.user, now);
    await store.setJSON(signalKey(room), signal);
    return { status: 200, json: { ok: true, signal } };
  }

  /* ---------------- 退出：立即释放账号（页面关闭时 sendBeacon 调用） ---------------- */
  if (msg.action === 'leave') {
    const current = await store.getJSON(stateKey(room));
    const players = readPlayers(current);
    if (!players[auth.user] || !players[auth.user].session || players[auth.user].session === auth.session) {
      delete players[auth.user];
      await store.setJSON(stateKey(room), { players, updatedAt: now });
    }
    return { status: 200, json: { ok: true } };
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