/**
 * Metropolis —— 公园北侧的 3D 微缩大都会（阶段五）。
 * 建筑三级 LOD；车辆/行人/路灯全部 InstancedMesh；交通只做标量采样。
 */
import * as THREE from 'three';
import { CITY, cityWalkColliders } from './city-layout.js';
import { buildCityBase } from './city-street.js';
import { buildCityLake } from './city-lake.js';
import { buildCityAir } from './city-air.js';
import { buildCityVilla } from './city-villa.js';
import { buildCityBuildings } from './city-buildings.js';
import { buildCityDetails } from './city-details.js';
import { buildCityExpansion } from './city-expansion.js';
import { CityTraffic } from './city-traffic.js';
import { CityCrowd } from './city-crowd.js';
import { CitySignals } from './city-signals.js';
import { ParkActors } from './park-actors.js';

export class Metropolis {
  constructor({ root, anchors = {} }) {
    this.root = root;
    this.anchors = anchors;
    this.group = new THREE.Group();
    this.group.name = 'Lobby/metropolis';
    this.owned = { geometries: [], materials: [], textures: [] };
    this.night = 0;
    this.nightTarget = 0;
    this.visible = true;
    this.stats = { towers: 0, detailTriangles: 0, residential: 0, skyline: 0, streetTrees: 0 };
    this.ready = false;
    this.walkColliders = cityWalkColliders();
    this._build();
  }

  _build() {
    const g = this.group;
    this.root.add(g);
    this.base = buildCityBase({ group: g, owned: this.owned });
    this.buildings = buildCityBuildings({ group: g, owned: this.owned });
    this.details = buildCityDetails({ group: g, owned: this.owned });
    this.expansion = buildCityExpansion({ group: g, owned: this.owned });
    this.lake = buildCityLake({ group: g, owned: this.owned });
    this.air = buildCityAir({ group: g, owned: this.owned });
    // 商场西侧空地的别墅门面（玩家走近门口按 E 进入室内 Villa 设施）
    this.villaDoor = buildCityVilla({ group: g, owned: this.owned });
    this.walkColliders.push(...this.villaDoor.colliders);
    this.signals = new CitySignals({ group: g, owned: this.owned });
    this.traffic = new CityTraffic({ group: g, owned: this.owned, signals: this.signals });
    this.crowd = new CityCrowd({ group: g, owned: this.owned, signals: this.signals });
    // 游乐园活动 NPC 永远可见，不跟城市背向剔除一起隐藏
    this.parkActors = new ParkActors({ root: this.root, anchors: this.anchors });
    this.traffic.onBusStop = () => {
      this.crowd.activateAlighters();
      this.lastBusStopAt = performance.now();
    };
    this.stats.towers = this.buildings.stats.towers;
    this.stats.blocks = this.buildings.stats.blocks;
    this.stats.buildings = this.buildings.stats.buildings;
    this.stats.residential = this.expansion.stats.residential;
    this.stats.skyline = this.expansion.stats.skylineTowers;
    this.stats.streetTrees = this.details.stats.trees;
    this.stats.lake = this.lake.stats;
    this.stats.air = this.air.stats;
    // 统计近景 LOD 面数，便于测试/报告
    const near = g.getObjectByName('City/LOD')?.levels?.[0]?.object;
    near?.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const n = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
      this.stats.detailTriangles += n;
    });
    this.base.setNight(0);
    this.buildings.setNight(0);
    this.details.setNight(0);
    this.expansion.setNight(0);
    this.ready = true;
    g.userData.metropolis = this;
    console.info(
      `[Metropolis] 第一阶段 | 街块=${this.stats.blocks} 建筑=${this.stats.buildings} 异形塔=${this.stats.towers} | ` +
      `车辆=${this.traffic.getStats().moving}+${this.traffic.getStats().parked} 行人=${this.crowd.getStats().total} | ` +
      `信号路口=${this.signals.stats.intersections} 灯头=${this.signals.stats.heads} | 路灯=${this.base.polePos.length} | draw≈${this._countDraws()}`
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
    this.night += (this.nightTarget - this.night) * (1 - Math.exp(-3.2 * dt));
    /* 城市模拟与“当前是否背向”解耦：背向只省 draw，不再冻结红绿灯、公交和
     * 行人。玩家从公园转回城市时看到的是延续的世界，而不是定格画面。 */
    this.signals.update(dt);
    this.base.setNight(this.night);
    this.buildings.setNight(this.night);
    this.details.setNight(this.night);
    this.expansion.setNight(this.night);
    this.lake?.setNight(this.night);
    this.air?.setNight(this.night);
    this.traffic.setNight(this.night);
    this.traffic.update(dt);
    this.lake.update(dt);
    this.air.update(dt);
    this.crowd.update(dt);
    this.parkActors.update(dt);
  }

  activateAlighters() { this.crowd.activateAlighters(); }

  dispose() {
    this.traffic?.dispose();
    this.parkActors?.dispose();
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
