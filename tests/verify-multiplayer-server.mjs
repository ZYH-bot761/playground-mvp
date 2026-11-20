/**
 * 联机房间核心自测（不依赖浏览器 / Netlify）：
 *   node tests/verify-multiplayer-server.mjs
 *
 * 直接调用 netlify/functions/_lib/room-core.mjs，用内存 store 验证
 * 登录校验、双人同步、一起回家信号、数据收敛、过期清理与房间隔离。
 * 线上 Netlify Function 与本地 /api/room 共用同一份核心，因此这份测试对两者都有效。
 */
import assert from 'node:assert/strict';
import { handleRoomApi, createMemoryStore } from '../netlify/functions/_lib/room-core.mjs';

const store = createMemoryStore();
let clock = 1_700_000_000_000;
const call = (body) => handleRoomApi({ store, body, now: clock });

/* ① 错误密码 */
const bad = await call({ action: 'login', room: 'test', user: 'player1', pass: 'nope' });
assert.equal(bad.status, 401);
assert.equal(bad.json.ok, false);
console.log('PASS ① 错误密码被拒绝');

/* ② 两个账号登录 */
const login1 = await call({ action: 'login', room: 'test', user: 'player1', pass: 'play1234' });
const login2 = await call({ action: 'login', room: 'test', user: 'player2', pass: 'play1234' });
assert.equal(login1.status, 200);
assert.equal(login2.status, 200);
assert.equal(login1.json.name, '小星');
assert.equal(login2.json.name, '小月');
assert.ok(login1.json.token && login2.json.token);
console.log('PASS ② 两个账号登录并拿到签名 token');

/* ③ 双向同步：A 上报后，B 的 sync 能看到 A 的位置 */
const sync1 = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 3.5, y: 0.1, z: 21.25, yaw: 0.75, speed: 4.2, zone: 'lobby', ready: true },
});
assert.equal(sync1.status, 200);
assert.equal(sync1.json.peers.length, 0, '只有自己时不应有队友');

const sync2 = await call({
  action: 'sync', room: 'test', token: login2.json.token,
  state: { x: -8, y: 0, z: 30, yaw: -1.2, speed: 0, zone: 'villa', ready: true },
});
const seen1 = sync2.json.peers.find((p) => p.id === 'player1');
assert.ok(seen1, 'player2 应看到 player1');
assert.equal(seen1.state.x, 3.5);
assert.equal(seen1.state.z, 21.25);
assert.equal(seen1.state.zone, 'lobby');
assert.equal(seen1.state.ready, true);
assert.ok(!('pass' in seen1), '快照不应携带密码');

const sync1b = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 3.5, y: 0.1, z: 21.25, yaw: 0.75, speed: 4.2, zone: 'lobby', ready: true },
});
const seen2 = sync1b.json.peers.find((p) => p.id === 'player2');
assert.ok(seen2, 'player1 应看到 player2');
assert.equal(seen2.state.zone, 'villa');
console.log('PASS ③ 位置 / 朝向 / 区域双向同步');

/* ④ 一起回家信号 */
const home = await call({ action: 'home', room: 'test', token: login2.json.token });
assert.equal(home.status, 200);
assert.ok(home.json.signal?.id);

const sync1c = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 0, y: 0, z: 24, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(sync1c.json.signal?.from?.id, 'player2');
assert.equal(sync1c.json.signal.from.name, '小月');

const sync2b = await call({
  action: 'sync', room: 'test', token: login2.json.token,
  state: { x: -8, y: 0, z: 30, yaw: -1.2, speed: 0, zone: 'villa', ready: true },
});
assert.equal(sync2b.json.signal, null, '发起者不应收到自己的回家信号');
console.log('PASS ④ 一起回家信号只送给队友');

/* ⑤ 重复 home 在冷却期内去重 */
const homeAgain = await call({ action: 'home', room: 'test', token: login2.json.token });
assert.equal(homeAgain.json.deduped, true);
console.log('PASS ⑤ 连续「一起回家」有冷却去重');

/* ⑥ 非法 token / 越界数据 */
const unauthorized = await call({
  action: 'sync', room: 'test', token: 'forged.token',
  state: { x: 0, y: 0, z: 0 },
});
assert.equal(unauthorized.status, 401);

const clamped = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 1e9, y: -1e9, z: Number.NaN, yaw: 999, speed: 999, zone: 'hack', ready: 'yes' },
});
assert.equal(clamped.status, 200);
const selfState = clamped.json.peers.find((p) => p.id === 'player2');
assert.ok(selfState);
assert.equal(selfState.state.zone, 'villa', '队友状态不应被自己的非法上报污染');

const roomState = await store.getJSON('multiplayer/test/state');
const clampedSelf = roomState.players.player1.state;
assert.equal(clampedSelf.zone, 'lobby');
assert.equal(clampedSelf.ready, false);
assert.equal(clampedSelf.x, 1000);
assert.equal(clampedSelf.y, -1000);
assert.ok(clampedSelf.speed <= 40);

const badRoom = await call({ action: 'login', room: 'bad room!', user: 'player1', pass: 'play1234' });
assert.equal(badRoom.status, 400);
console.log('PASS ⑥ 伪造 token / 越界数据 / 非法房间号被拒绝或收敛');

/* ⑦ 过期玩家自动清理 */
const isolated = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 1, y: 0, z: 1, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.ok(isolated.json.peers.some((p) => p.id === 'player2'));
clock += 20_000;
const afterExpire = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 1, y: 0, z: 1, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(afterExpire.json.peers.length, 0, '超过 15s 未上报的玩家应视为离线');
console.log('PASS ⑦ 过期玩家自动清理');

/* ⑧ 房间隔离：另一个 room 看不到 test 房间的人 */
const loginOther = await call({ action: 'login', room: 'other', user: 'player1', pass: 'play1234' });
const otherSync = await call({
  action: 'sync', room: 'other', token: loginOther.json.token,
  state: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(otherSync.json.peers.length, 0);
console.log('PASS ⑧ 不同房间互相隔离');

console.log('\n联机房间核心自测全部通过（8/8）');