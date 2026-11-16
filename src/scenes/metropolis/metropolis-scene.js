/**
 * Metropolis —— 公园北侧的 3D 微缩大都会（阶段五）。
 * 建筑三级 LOD；车辆/行人/路灯全部 InstancedMesh；交通只做标量采样。
 */
import * as THREE from 'three';
import { CITY } from './city-layout.js';
import { buildCityBase } from './city-street.js';
import { buildCityBuildings } from './city-buildings.js';
import { CityTraffic } from './city-traffic.js';
import { CityCrowd } from './city-crowd.js';

export class Metropolis {
  constructor({ root }) {
    this.root = root;
    this.group = new THREE.Group();
    this.group.name = 'Lobby/metropolis';
    this.owned = { geometries: [], materials: [], textures: [] };
    this.night = 0;
    this.nightTarget = 0;
    this.visible = true;
    this.stats = { towers: 0, detailTriangles: 0 };
    this.ready = false;
    this._build();
  }

  _build() {
    const g = this.group;
    this.root.add(g);
    this.base = buildCityBase({ group: g, owned: this.owned });
    this.buildings = buildCityBuildings({ group: g, owned: this.owned });
    this.traffic = new CityTraffic({ group: g, owned: this.owned });
    this.crowd = new CityCrowd({ group: g, owned: this.owned });
    this.traffic.onBusStop = () => {
      this.crowd.activateAlighters();
      this.lastBusStopAt = performance.now();
    };
    this.stats.towers = this.buildings.stats.towers;
    // 统计近景 LOD 面数，便于测试/报告
    const near = g.getObjectByName('City/LOD')?.levels?.[0]?.object;
    near?.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const n = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
      this.stats.detailTriangles += n;
    });
    this.base.setNight(0);
    this.buildings.setNight(0);
    this.ready = true;
    g.userData.metropolis = this;
    console.info(
      `[Metropolis] 建成 | 塔楼=${this.stats.towers} 近景三角形=${Math.round(this.stats.detailTriangles)} | ` +
      `车辆=28+4 公交=1 行人=24 | 路灯实例=${this.base.polePos.length} | draw≈${this._countDraws()}`
    );
  }

  _countDraws() {
    let n = 0;
    this.group.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isLine) n++; });
    return n;
  }

  setNightMode(mode) {
    this.nightTarget = mode === 'night' ? 1 : mode === 'sunset' ? 0.55 : 0;
  }

  update(dt, camera) {
    if (!this.ready) return;
    // 背向剔除：站在公园朝南看时整座城市在身后，直接整组隐藏，省下所有 draw。
    if (camera) {
      const dir = camera.getWorldDirection(this._dir || (this._dir = new THREE.Vector3()));
      const inParkSouth = camera.position.z < 92;
      const facingAway = dir.z < -0.15;
      this.visible = !(inParkSouth && facingAway);
      this.group.visible = this.visible;
    }
    if (!this.visible) return;
    this.night += (this.nightTarget - this.night) * (1 - Math.exp(-3.2 * dt));
    this.base.setNight(this.night);
    this.buildings.setNight(this.night);
    this.base.setSignal(this.traffic.getSignalPhase());
    this.traffic.update(dt);
    this.crowd.update(dt);
  }

  activateAlighters() { this.crowd.activateAlighters(); }

  dispose() {
    this.group.traverse((o) => {
      if (o.isInstancedMesh && typeof o.dispose === 'function') {
        try { o.dispose(); } catch { /* 已释放则忽略 */ }
      }
    });
    for (const geo of this.owned.geometries) {
      try { geo.dispose(); } catch { /* noop */ }
    }
    for (const mat of this.owned.materials) {
      try { mat.dispose(); } catch { /* noop */ }
    }
    for (const tex of this.owned.textures) {
      try { tex.dispose(); } catch { /* noop */ }
    }
    this.owned.geometries.length = 0;
    this.owned.materials.length = 0;
    this.owned.textures.length = 0;
    this.root.remove(this.group);
    this.group.clear();
    this.ready = false;
  }
}
