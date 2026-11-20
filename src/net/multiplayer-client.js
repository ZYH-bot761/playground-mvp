/**
 * ============================================================================
 * MultiplayerClient —— 线上双人联机客户端（短轮询版，Netlify 可部署）
 * ============================================================================
 * Netlify 不支持 WebSocket 长连接，因此这里改为同源 HTTP 轮询：
 *   - 每 250ms POST /api/room：上报自己的位姿，同时取回队友与「回家」信号；
 *   - 页面切到后台自动降到 1s，减少手机流量与函数调用；
 *   - 远端角色仍挂在 SceneContext.worldRoot，只读相机、不抢相机；
 *   - 两台手机打开不同链接（?u=player1 / ?u=player2）即可互相看见。
 *
 * 协议见 netlify/functions/_lib/room-core.mjs：
 *   login → token；sync → peers + signal；home → 一起回家信号
 * ============================================================================
 */
import * as THREE from 'three';
import { buildCharacter, disposeCharacter } from '../utils/helpers/procedural-character.js';

const API_PATH = '/api/room';
const DEFAULT_ROOM = 'home';
const SYNC_INTERVAL_MS = 250;
const SYNC_INTERVAL_HIDDEN_MS = 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BODY = '';
const SPAWN_POSE = Object.freeze({ x: 0, y: 1.65, z: 24, yaw: 0 });
const EYE_HEIGHT = Object.freeze({ lobby: 1.65, villa: 1.6 });
const HUD_STYLE_ID = 'pg-mp-styles';
const ROOM_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function toColorInt(value, fallback = 0x8fd0ff) {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return Number.parseInt(value.slice(1), 16);
  }
  return fallback;
}

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 远端玩家头顶名字牌（CanvasTexture + Sprite，零外部字体/图片） */
function makeNameTag(name, color) {
  const width = 320;
  const height = 80;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const text = String(name || '玩家').slice(0, 12);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '700 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  const textWidth = Math.min(width - 48, ctx.measureText(text).width);
  const boxWidth = textWidth + 44;
  const x = (width - boxWidth) / 2;
  const y = 16;
  const h = 44;
  const radius = 14;

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + boxWidth, y, x + boxWidth, y + h, radius);
  ctx.arcTo(x + boxWidth, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + boxWidth, y, radius);
  ctx.closePath();
  ctx.fillStyle = 'rgba(8, 16, 28, 0.72)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.fillStyle = '#f2f8ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, y + h / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.45, 1);
  sprite.position.set(0, 2.05, 0);
  sprite.name = 'Multiplayer/name-tag';
  return {
    sprite,
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}

export class MultiplayerClient {
  constructor(options = {}) {
    this._options = { ...options };
    this.me = null;
    /** @type {Map<string, Object>} id → 远端玩家渲染状态 */
    this.peers = new Map();

    this._room = ROOM_RE.test(options.room || '') ? options.room : DEFAULT_ROOM;
    this._token = null;
    this._session = null;
    this._kicked = false;
    this._creds = null;
    this._connected = false;
    this._disposed = false;
    this._ready = false;
    this._syncing = false;
    this._failCount = 0;
    this._relogging = false;
    this._syncTimer = 0;
    this._lastSyncAt = 0;
    this._lastPoseAt = 0;
    this._lastSignalId = '';

    this._sceneReady = false;
    this._worldRoot = null;
    this._camera = null;
    this._remoteRoot = null;
    this._getZoneFn = () => 'lobby';
    this._isLocalControlActive = null;
    this._isDriving = null;
    this._canAutoEnter = null;
    this._enterHome = null;

    this._pose = { x: SPAWN_POSE.x, y: SPAWN_POSE.y, z: SPAWN_POSE.z, yaw: SPAWN_POSE.yaw, zone: 'lobby' };
    this._prev = { x: SPAWN_POSE.x, z: SPAWN_POSE.z };
    this._speed = 0;
    this._hudAcc = 0;
    this._time = 0;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    this._hud = null;
    this._hudParts = null;
    this._toastEl = null;
    this._toastTimer = 0;
    this._hudCache = '';
  }

  /* ====================================================================== */
  /* 生命周期                                                               */
  /* ====================================================================== */

  /**
   * 注入场景与业务钩子。可在登录前或登录后调用（幂等）。
   * @param {{worldRoot?: THREE.Object3D, camera?: THREE.Camera,
   *          getZone?: () => string, isLocalControlActive?: () => boolean,
   *          isDriving?: () => boolean, canAutoEnter?: () => boolean,
   *          enterHome?: () => (void|Promise), room?: string}} refs
   */
  configure(refs = {}) {
    if (refs.worldRoot) this._worldRoot = refs.worldRoot;
    if (refs.camera) this._camera = refs.camera;
    if (typeof refs.getZone === 'function') this._getZoneFn = refs.getZone;
    if (typeof refs.isLocalControlActive === 'function') this._isLocalControlActive = refs.isLocalControlActive;
    if (typeof refs.isDriving === 'function') this._isDriving = refs.isDriving;
    if (typeof refs.canAutoEnter === 'function') this._canAutoEnter = refs.canAutoEnter;
    if (typeof refs.enterHome === 'function') this._enterHome = refs.enterHome;
    if (typeof refs.room === 'string' && ROOM_RE.test(refs.room)) this._room = refs.room;

    if (this._worldRoot && !this._remoteRoot) {
      const root = new THREE.Group();
      root.name = 'Multiplayer/remoteRoot';
      root.userData.multiplayerRoot = true;
      this._worldRoot.add(root);
      this._remoteRoot = root;
      // 登录可能早于 bootstrap：把此前已创建的远端角色补挂到常驻根节点
      for (const peer of this.peers.values()) {
        if (peer.group && !peer.group.parent) root.add(peer.group);
      }
    }
    this._sceneReady = Boolean(this._worldRoot);
    return this;
  }

  /** 登录房间：只发一次密码，之后使用签名 token 轮询 */
  async login(user, pass) {
    this._creds = { user, pass };
    this._disposed = false;
    this._failCount = 0;
    const data = await this._post({
      action: 'login',
      room: this._room,
      user,
      pass,
    });
    this._token = data.token;
    this._session = data.session || null;
    this._kicked = false;
    this.me = { id: data.id, name: data.name, color: data.color };
    this._connected = true;
    this._ensureHud();
    this._updateHud(true);
    this._toast(`已进入联机房间 · ${this.me.name}`, 2200);
    this._startSync();
    return this.me;
  }

  setRoom(room) {
    if (ROOM_RE.test(String(room || ''))) this._room = String(room);
    return this;
  }

  setReady(ready) {
    this._ready = Boolean(ready);
    this._updateHud(true);
    return this;
  }

  get connected() { return this._connected; }
  get zone() { return this._currentZone(); }
  get room() { return this._room; }

  update(dt = 0) {
    if (this._disposed) return;
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    this._time += step;

    for (const peer of this.peers.values()) this._tickPeer(peer, step);

    this._hudAcc += step;
    if (this._hudAcc >= 0.25) {
      this._hudAcc = 0;
      this._updateHud();
    }
  }

  dispose() {
    this._disposed = true;
    this._connected = false;
    this._stopSync();
    this._sendLeave();
    this._token = null;
    this._session = null;
    this._syncing = false;

    for (const peer of this.peers.values()) this._removePeer(peer);
    this.peers.clear();

    if (this._remoteRoot) {
      this._remoteRoot.removeFromParent();
      this._remoteRoot = null;
    }
    clearTimeout(this._toastTimer);
    this._toastTimer = 0;
    this._hud?.remove();
    this._toastEl?.remove();
    this._hud = null;
    this._toastEl = null;
    this._hudParts = null;
    if (!document.querySelector('.mp-hud')) {
      document.getElementById(HUD_STYLE_ID)?.remove();
    }
    this._sceneReady = false;
  }

  /* ====================================================================== */
  /* 网络（HTTP 轮询）                                                      */
  /* ====================================================================== */

  async _post(payload, timeout = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { /* 非 JSON 响应交给下面的错误分支 */ }
      if (!res.ok || !data?.ok) {
        const error = new Error(data?.error || `联机服务返回 ${res.status}`);
        error.status = res.status;
        error.code = data?.code;
        throw error;
      }
      return data;
    } catch (err) {
      if (err?.name === 'AbortError') {
        const error = new Error('联机请求超时，请检查网络');
        error.timeout = true;
        throw error;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _startSync() {
    this._stopSync();
    this._lastPoseAt = performance.now();
    this._lastSyncAt = 0;
    this._syncNow();
    this._syncTimer = window.setInterval(() => this._syncNow(), SYNC_INTERVAL_MS);
  }

  _stopSync() {
    if (this._syncTimer) {
      window.clearInterval(this._syncTimer);
      this._syncTimer = 0;
    }
  }

  /** 立即同步一次（调试 / 验收脚本用；常规路径由 250ms 定时器触发） */
  syncNow() {
    return this._syncNow();
  }

  async _syncNow() {
    if (this._disposed || !this._token) return null;
    if (this._syncing) return null;

    const now = Date.now();
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // 未点「进入游乐场」或页面在后台时降到 1s，减少手机流量 / Netlify 函数调用
    const interval = (this._ready && !hidden) ? SYNC_INTERVAL_MS : SYNC_INTERVAL_HIDDEN_MS;
    if (now - this._lastSyncAt < interval - 40) return null;
    this._lastSyncAt = now;
    this._syncing = true;

    const poseNow = performance.now();
    const poseDt = Math.min(1.5, Math.max(0.05, (poseNow - (this._lastPoseAt || poseNow)) / 1000));
    this._lastPoseAt = poseNow;
    this._updateLocalPose(poseDt);

    const zone = this._pose.zone;
    const eye = EYE_HEIGHT[zone] ?? EYE_HEIGHT.lobby;
    const state = {
      x: Number(this._pose.x.toFixed(2)),
      y: Number((this._pose.y - eye).toFixed(2)),
      z: Number(this._pose.z.toFixed(2)),
      yaw: Number(this._pose.yaw.toFixed(3)),
      speed: Number(this._speed.toFixed(2)),
      zone,
      ready: this._ready,
    };

    try {
      const data = await this._post({
        action: 'sync',
        room: this._room,
        token: this._token,
        state,
      }, 8000);
      this._connected = true;
      this._failCount = 0;
      this._applyPeers(data.peers || []);
      this._handleSignal(data.signal);
      this._updateHud(true);
      return data;
    } catch (err) {
      if (err?.status === 409 || err?.code === 'SESSION_REPLACED') {
        this._kicked = true;
        this._connected = false;
        this._stopSync();
        this._toast('账号已在另一台设备打开，本页已停止联机', 6000);
        this._updateHud(true);
        return null;
      }
      if (err?.status === 401 || err?.status === 403) {
        this._relogin();
        return null;
      }
      this._failCount += 1;
      if (this._failCount >= 3 && this._connected) {
        this._connected = false;
        this._toast('联机连接不稳定，正在自动重试…', 4000);
        this._updateHud(true);
      }
      return null;
    } finally {
      this._syncing = false;
    }
  }

  _relogin() {
    if (this._kicked || this._relogging || this._disposed || !this._creds) return;
    this._relogging = true;
    this._post({
      action: 'login',
      room: this._room,
      user: this._creds.user,
      pass: this._creds.pass,
    }).then((data) => {
      this._token = data.token;
      this._session = data.session || null;
      this.me = { id: data.id, name: data.name, color: data.color };
      this._connected = true;
      this._updateHud(true);
    }).catch(() => {
      this._connected = false;
      this._updateHud(true);
      this._toast('登录状态已失效，请刷新页面重新登录', 5000);
    }).finally(() => {
      this._relogging = false;
    });
  }

  /** 页面卸载时释放账号：sendBeacon 比 fetch 更可靠，服务端按 session 校验归属 */
  _sendLeave() {
    if (!this._token || this._kicked) return;
    const payload = JSON.stringify({ action: 'leave', room: this._room, token: this._token });
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(API_PATH, new Blob([payload], { type: 'application/json' }));
        return;
      }
    } catch { /* 落到 fetch keepalive */ }
    try {
      fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch { /* 页面已卸载，尽力而为 */ }
  }

  _currentZone() {
    try {
      const zone = this._getZoneFn();
      return zone === 'villa' || zone === 'facility' ? zone : 'lobby';
    } catch {
      return 'lobby';
    }
  }

  /* ====================================================================== */
  /* 本地位姿                                                               */
  /* ====================================================================== */

  _updateLocalPose(dt) {
    const zone = this._currentZone();
    const cam = this._camera;
    const takeCamera = Boolean(cam) && (
      zone === 'villa'
      || (typeof this._isLocalControlActive === 'function' && this._isLocalControlActive())
      || (typeof this._isDriving === 'function' && this._isDriving())
    );

    if (takeCamera) {
      const x = cam.position.x;
      const y = cam.position.y;
      const z = cam.position.z;
      const dx = x - this._prev.x;
      const dz = z - this._prev.z;
      const instant = Math.hypot(dx, dz) / Math.max(dt, 1e-3);
      this._speed += (Math.min(instant, 20) - this._speed) * Math.min(1, dt * 7);
      this._pose.x = x;
      this._pose.y = y;
      this._pose.z = z;
      this._euler.setFromQuaternion(cam.quaternion, 'YXZ');
      this._pose.yaw = this._euler.y;
      this._prev.x = x;
      this._prev.z = z;
    } else if (zone !== this._pose.zone) {
      this._speed = 0;
    }

    this._pose.zone = zone;
  }

  /* ====================================================================== */
  /* 远端玩家                                                               */
  /* ====================================================================== */

  _applyPeers(peers) {
    const seen = new Set();
    for (const item of peers) {
      if (!item || item.id === this.me?.id) continue;
      seen.add(item.id);
      let peer = this.peers.get(item.id);
      if (!peer) {
        peer = this._createPeer(item);
        this.peers.set(item.id, peer);
        this._toast(`${peer.name} 进入了房间`, 2000);
      }
      this._syncPeer(peer, item);
    }
    for (const [id, peer] of [...this.peers]) {
      if (!seen.has(id)) {
        this._removePeer(peer);
        this.peers.delete(id);
        this._toast(`${peer.name} 离开了房间`, 2400);
      }
    }
    this._updateHud(true);
  }

  _createPeer(item) {
    const state = item.state || {};
    const colorInt = toColorInt(item.color);
    const group = buildCharacter({
      style: 'player',
      name: `Multiplayer/peer-${item.id}`,
      palette: {
        coat: colorInt,
        pants: 0x333d4c,
        accessory: 'scarf',
        hairStyle: 'short',
        sleeve: 'long',
      },
    });
    group.position.set(state.x || 0, state.y || 0, state.z || 0);
    group.rotation.y = (Number(state.yaw) || 0) + Math.PI;
    group.visible = false;

    const tag = makeNameTag(item.name, item.color);
    if (tag) group.add(tag.sprite);
    this._remoteRoot?.add(group);

    return {
      id: item.id,
      name: item.name || item.id,
      color: item.color,
      group,
      rig: group.userData.rig || null,
      tag,
      zone: state.zone || 'lobby',
      ready: state.ready === true,
      target: new THREE.Vector3(state.x || 0, state.y || 0, state.z || 0),
      targetYaw: Number(state.yaw) || 0,
      yaw: Number(state.yaw) || 0,
      speed: 0,
      targetSpeed: 0,
      walkPhase: 0,
      first: true,
    };
  }

  _syncPeer(peer, item) {
    const state = item.state || {};
    const zone = state.zone === 'villa' || state.zone === 'facility' ? state.zone : 'lobby';
    const zoneChanged = peer.zone !== zone;
    peer.zone = zone;
    peer.ready = state.ready === true;
    peer.target.set(state.x || 0, state.y || 0, state.z || 0);
    peer.targetYaw = Number.isFinite(state.yaw) ? state.yaw : peer.targetYaw;
    peer.targetSpeed = Math.min(20, Number(state.speed) || 0);

    if (peer.first || zoneChanged) {
      peer.group.position.copy(peer.target);
      peer.yaw = peer.targetYaw;
      peer.group.rotation.y = peer.yaw + Math.PI;
      peer.speed = 0;
      peer.targetSpeed = 0;
      peer.first = false;
    }
  }

  _tickPeer(peer, dt) {
    if (!peer.group) return;

    const follow = 1 - Math.exp(-13 * dt);
    peer.group.position.lerp(peer.target, follow);

    const turn = angleDelta(peer.yaw, peer.targetYaw);
    peer.yaw += turn * (1 - Math.exp(-15 * dt));
    peer.group.rotation.y = peer.yaw + Math.PI;

    peer.speed += (peer.targetSpeed - peer.speed) * Math.min(1, dt * 6);
    peer.walkPhase += dt * (2.2 + Math.min(9, peer.speed * 1.5)) * 2;

    const swing = Math.min(1, peer.speed / 4.2) * 0.58;
    const s = Math.sin(peer.walkPhase) * swing;
    const rig = peer.rig;
    if (rig) {
      rig.legL.rotation.x = s;
      rig.legR.rotation.x = -s;
      rig.armL.rotation.x = -s * 0.8;
      rig.armR.rotation.x = s * 0.8;
    }

    const myZone = this._currentZone();
    peer.group.visible = peer.zone === myZone && (myZone === 'lobby' || myZone === 'villa');
  }

  _removePeer(peer) {
    if (!peer) return;
    peer.group?.removeFromParent();
    peer.tag?.dispose();
    if (peer.group) {
      try { disposeCharacter(peer.group); } catch { /* noop */ }
    }
    peer.group = null;
    peer.rig = null;
    peer.tag = null;
  }

  /* ====================================================================== */
  /* 一起回家                                                               */
  /* ====================================================================== */

  goHome() {
    if (!this._connected || !this.me) {
      this._toast('联机尚未连接', 2200);
      return;
    }
    if (this._currentZone() === 'villa') {
      this._toast('你已经在家里了', 2000);
      return;
    }

    const payload = JSON.stringify({
      action: 'home',
      room: this._room,
      token: this._token,
    });
    let sent = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        sent = navigator.sendBeacon(API_PATH, new Blob([payload], { type: 'application/json' }));
      }
    } catch { /* 落到 fetch */ }
    if (!sent) {
      this._post({
        action: 'home',
        room: this._room,
        token: this._token,
      }, 20000).catch((err) => {
        console.warn('[联机] 发送回家信号失败：', err);
        this._toast('队友可能没收到回家邀请', 3000);
      });
    }

    this._enterVilla();
  }

  _enterVilla() {
    if (typeof this._enterHome !== 'function') {
      this._toast('别墅入口尚未就绪', 2400);
      return;
    }
    try {
      const ret = this._enterHome();
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          console.warn('[联机] 进入别墅失败：', err);
          this._toast('进入别墅失败，请稍后再试', 2600);
        });
      }
    } catch (err) {
      console.warn('[联机] 进入别墅失败：', err);
      this._toast('进入别墅失败，请稍后再试', 2600);
    }
  }

  _handleSignal(signal) {
    if (!signal || signal.type !== 'go_home') return;
    if (this._lastSignalId === signal.id) return;
    this._lastSignalId = signal.id;
    if (signal.from?.id === this.me?.id) return;
    this._onHomeInvite(signal.from);
  }

  _onHomeInvite(from) {
    if (!from?.name) return;
    if (this._currentZone() === 'villa') {
      this._toast(`队友「${from.name}」也到家了`, 2400);
      return;
    }
    let canAuto = true;
    try {
      canAuto = typeof this._canAutoEnter === 'function' ? Boolean(this._canAutoEnter()) : true;
    } catch {
      canAuto = false;
    }
    if (!canAuto) {
      this._toast(`队友「${from.name}」邀你回家：进入游戏后可跟随`, 3600);
      return;
    }
    this._toast(`队友「${from.name}」邀你一起回家，正在跟上…`, 3200);
    this._enterVilla();
  }

  /* ====================================================================== */
  /* HUD                                                                    */
  /* ====================================================================== */

  _ensureHud() {
    if (this._hud) return;
    if (!document.getElementById(HUD_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = HUD_STYLE_ID;
      style.textContent = `
.mp-hud {
  position: fixed;
  top: max(12px, env(safe-area-inset-top, 0px));
  left: 50%;
  z-index: 40;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: calc(100vw - 24px);
  padding: 8px 10px 8px 14px;
  font-family: var(--pg-ui-font, 'Microsoft YaHei', 'PingFang SC', sans-serif);
  font-size: 12px;
  line-height: 1.4;
  color: #dbe9fb;
  background: rgba(10, 18, 31, 0.74);
  border: 1px solid rgba(120, 178, 235, 0.24);
  border-radius: 999px;
  box-shadow: 0 10px 30px rgba(2, 7, 17, 0.42);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  pointer-events: none;
  user-select: none;
  box-sizing: border-box;
}
.mp-hud__dot {
  width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%;
  background: #63e6a8; box-shadow: 0 0 8px rgba(99, 230, 168, 0.8);
}
.mp-hud[data-connected="0"] .mp-hud__dot { background: #ffc46b; box-shadow: 0 0 8px rgba(255, 196, 107, 0.7); }
.mp-hud__me { font-weight: 700; color: #8fe3ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 9em; }
.mp-hud__sep { color: #5e7595; }
.mp-hud__peer { color: #a9bfdb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 15em; }
.mp-hud__home {
  flex: 0 0 auto;
  padding: 6px 13px;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  color: #06101f;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(118deg, #8fe3ff, #ffc98a);
  transition: filter 0.16s ease, transform 0.16s ease;
  -webkit-tap-highlight-color: transparent;
}
.mp-hud__home:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }
.mp-hud__home:active:not(:disabled) { transform: translateY(0) scale(0.98); }
.mp-hud__home:disabled { cursor: default; opacity: 0.5; color: #dbe9fb; background: rgba(60, 86, 120, 0.55); }
.mp-toast {
  position: fixed;
  top: calc(max(12px, env(safe-area-inset-top, 0px)) + 48px);
  left: 50%;
  z-index: 41;
  transform: translate(-50%, -6px);
  max-width: min(520px, calc(100vw - 32px));
  padding: 9px 16px;
  font-family: var(--pg-ui-font, 'Microsoft YaHei', 'PingFang SC', sans-serif);
  font-size: 12px;
  line-height: 1.5;
  color: #eaf5ff;
  text-align: center;
  background: rgba(10, 20, 34, 0.88);
  border: 1px solid rgba(120, 190, 255, 0.3);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(2, 7, 17, 0.45);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
}
.mp-toast[data-on="1"] { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
@media (max-width: 560px) {
  .mp-hud { font-size: 11px; gap: 7px; padding: 7px 8px 7px 11px; }
  .mp-hud__home { padding: 5px 10px; font-size: 11px; }
  .mp-hud__peer { max-width: 9em; }
}
      `;
      document.head.appendChild(style);
    }

    const hud = document.createElement('div');
    hud.className = 'mp-hud';
    hud.dataset.connected = '0';
    hud.innerHTML = `
      <span class="mp-hud__dot" aria-hidden="true"></span>
      <span class="mp-hud__me" data-role="me">联机</span>
      <span class="mp-hud__sep" aria-hidden="true">/</span>
      <span class="mp-hud__peer" data-role="peer">等待连接</span>
      <button class="mp-hud__home" type="button" data-role="home" disabled>一起回家</button>
    `;
    const toast = document.createElement('div');
    toast.className = 'mp-toast';
    toast.dataset.on = '0';
    toast.setAttribute('aria-live', 'polite');

    document.body.append(hud, toast);
    this._hud = hud;
    this._toastEl = toast;
    this._hudParts = {
      me: hud.querySelector('[data-role="me"]'),
      peer: hud.querySelector('[data-role="peer"]'),
      home: hud.querySelector('[data-role="home"]'),
    };
    this._hudParts.home.addEventListener('click', () => this.goHome());
  }

  _updateHud(force = false) {
    if (!this._hud || !this._hudParts) return;
    const peers = [...this.peers.values()];
    const peer = peers[0] || null;
    const myZone = this._currentZone();

    const meName = this.me?.name || '未登录';
    const peerText = this._kicked
      ? '账号已在其他设备打开'
      : !this._connected
        ? '重连中…'
        : peer
          ? `${peer.name} · ${peer.zone === 'villa' ? '在家' : peer.zone === 'facility' ? '在项目中' : '大厅'}${peer.ready ? '' : ' · 未进入'}`
          : '等待队友上线';

    let mode = 'home';
    let label = '一起回家';
    if (this._kicked) {
      mode = 'offline';
      label = '账号被接管';
    } else if (!this._connected) {
      mode = 'offline';
      label = '联机断开';
    } else if (!peer) {
      mode = 'offline';
      label = '等待队友';
    } else if (myZone === 'villa' && peer.zone === 'villa') {
      mode = 'athome';
      label = '已一起在家';
    } else if (myZone === 'villa') {
      mode = 'athome';
      label = '你已在家';
    } else if (peer.zone === 'facility') {
      mode = 'busy';
      label = '队友在项目中';
    }

    const signature = `${this._connected}|${meName}|${peerText}|${mode}|${label}`;
    if (!force && signature === this._hudCache) return;
    this._hudCache = signature;

    this._hud.dataset.connected = this._connected ? '1' : '0';
    this._hudParts.me.textContent = meName;
    this._hudParts.peer.textContent = peerText;
    this._hudParts.home.dataset.mode = mode;
    this._hudParts.home.textContent = label;
    this._hudParts.home.disabled = mode !== 'home';
  }

  _toast(text, duration = 2600) {
    if (!text) return;
    this._ensureHud();
    const el = this._toastEl;
    if (!el) return;
    el.textContent = text;
    el.dataset.on = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => {
      el.dataset.on = '0';
    }, duration);
  }
}

export default MultiplayerClient;