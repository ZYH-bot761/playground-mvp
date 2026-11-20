/**
 * 联机房间核心自测：
 *   node tests/verify-multiplayer-server.mjs
 *
 * 覆盖：登录、双人同步、一起回家、同账号接管（SESSION_REPLACED）、
 *      退出释放（leave）、数据收敛、过期清理、房间隔离。
 */
import assert from 'node:assert/strict';
import { handleRoomApi, createMemoryStore } from '../netlify/functions/_lib/room-core.mjs';

const store = createMemoryStore();
let clock = 1_700_000_000_000;
const call = (body) => handleRoomApi({ store, body, now: clock });
const roomState = () => store.getJSON('multiplayer/test/state');

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
assert.ok(login1.json.token && login1.json.session);
assert.ok(login2.json.token && login2.json.session);
console.log('PASS ② 两个账号登录并拿到 session token');

/* ③ 双向同步 */
const sync1 = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 3.5, y: 0.1, z: 21.25, yaw: 0.75, speed: 4.2, zone: 'lobby', ready: true },
});
assert.equal(sync1.status, 200);
assert.ok(sync1.json.peers.some((p) => p.id === 'player2'), '登录后应能在房间里看到另一个账号');

const sync2 = await call({
  action: 'sync', room: 'test', token: login2.json.token,
  state: { x: -8, y: 0, z: 30, yaw: -1.2, speed: 0, zone: 'villa', ready: true },
});
const seen1 = sync2.json.peers.find((p) => p.id === 'player1');
assert.ok(seen1);
assert.equal(seen1.state.x, 3.5);
assert.equal(seen1.state.z, 21.25);
assert.equal(seen1.state.zone, 'lobby');
assert.equal(seen1.state.ready, true);
assert.ok(!('pass' in seen1), '快照不应携带密码');
assert.ok(!('session' in seen1), '快照不应携带 session');

const sync1b = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 3.5, y: 0.1, z: 21.25, yaw: 0.75, speed: 4.2, zone: 'lobby', ready: true },
});
const seen2 = sync1b.json.peers.find((p) => p.id === 'player2');
assert.ok(seen2);
assert.equal(seen2.state.zone, 'villa');
console.log('PASS ③ 位置 / 朝向 / 区域双向同步');

/* ④ 一起回家 */
const home = await call({ action: 'home', room: 'test', token: login2.json.token });
assert.equal(home.status, 200);
assert.ok(home.json.signal?.id);

const sync1c = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 0, y: 0, z: 24, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(sync1c.json.signal?.from?.id, 'player2');

const sync2b = await call({
  action: 'sync', room: 'test', token: login2.json.token,
  state: { x: -8, y: 0, z: 30, yaw: -1.2, speed: 0, zone: 'villa', ready: true },
});
assert.equal(sync2b.json.signal, null, '发起者不应收到自己的回家信号');
console.log('PASS ④ 一起回家信号只送给队友');

/* ⑤ 冷却去重 */
const homeAgain = await call({ action: 'home', room: 'test', token: login2.json.token });
assert.equal(homeAgain.json.deduped, true);
console.log('PASS ⑤ 连续「一起回家」有冷却去重');

/* ⑥ 非法 token / 越界数据 / 非法房间 */
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
const state = await roomState();
const clampedSelf = state.players.player1.state;
assert.equal(clampedSelf.zone, 'lobby');
assert.equal(clampedSelf.ready, false);
assert.equal(clampedSelf.x, 1000);
assert.equal(clampedSelf.y, -1000);
assert.ok(clampedSelf.speed <= 40);

const badRoom = await call({ action: 'login', room: 'bad room!', user: 'player1', pass: 'play1234' });
assert.equal(badRoom.status, 400);
console.log('PASS ⑥ 伪造 token / 越界数据 / 非法房间号被拒绝或收敛');

/* ⑦ 过期清理 */
clock += 20_000;
const afterExpire = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 1, y: 0, z: 1, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(afterExpire.json.peers.length, 0, '超过 15s 未上报的玩家应视为离线');
console.log('PASS ⑦ 过期玩家自动清理');

/* ⑧ 房间隔离 */
const loginOther = await call({ action: 'login', room: 'other', user: 'player1', pass: 'play1234' });
const otherSync = await call({
  action: 'sync', room: 'other', token: loginOther.json.token,
  state: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(otherSync.json.peers.length, 0);
console.log('PASS ⑧ 不同房间互相隔离');

/* ⑨ 同账号后打开的设备接管：旧 session 下一次 sync 收到 409 */
clock += 1_000;
const takeover = await call({ action: 'login', room: 'test', user: 'player1', pass: 'play1234' });
assert.equal(takeover.status, 200);
assert.notEqual(takeover.json.session, login1.json.session);

const oldSync = await call({
  action: 'sync', room: 'test', token: login1.json.token,
  state: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(oldSync.status, 409);
assert.equal(oldSync.json.code, 'SESSION_REPLACED');

const newSync = await call({
  action: 'sync', room: 'test', token: takeover.json.token,
  state: { x: 2, y: 0, z: 2, yaw: 0, speed: 0, zone: 'lobby', ready: true },
});
assert.equal(newSync.status, 200);
const takenState = await roomState();
assert.equal(takenState.players.player1.session, takeover.json.session);
console.log('PASS ⑨ 同账号新设备接管，旧 session 被 409 停止');

/* ⑩ 退出释放：leave 后账号立即从房间移除，旧 session 不能删除新会话 */
const oldLeave = await call({ action: 'leave', room: 'test', token: login1.json.token });
assert.equal(oldLeave.status, 200);
const stillThere = await roomState();
assert.ok(stillThere.players.player1, '旧 session leave 不应删除新会话');

const leave = await call({ action: 'leave', room: 'test', token: takeover.json.token });
assert.equal(leave.status, 200);
const afterLeave = await roomState();
assert.ok(!afterLeave.players.player1, '当前 session leave 后账号应立即释放');
console.log('PASS ⑩ 退出页面立即释放账号，旧 session 不能误删');

console.log('\n联机房间核心自测全部通过（10/10）');