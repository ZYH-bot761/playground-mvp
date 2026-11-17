/**
 * 游乐园活动 NPC（第一阶段）：
 * - 2 名游客走到旋转木马，坐上木马随盘旋转；
 * - 1 名游客走到小火车站台，坐进往返的小火车；
 * - 1 名游客走到木马前拍照点，举臂拍照；
 * - 全部为 InstancedMesh，路径点为固定常量，热路径零 new。
 *
 * 木马/火车位置优先读取 Lobby 的真实运行时对象；若未注入则按同一公式推导。
 */
import * as THREE from 'three';

const CAROUSEL = Object.freeze({ x: 9, z: 7.5, radius: 3.31, board: { x: 9, z: 12.15 }, start: { x: 2.4, z: 4.2 } });
const TRAIN = Object.freeze({ x: -26, z: -2.36, board: { x: -26, z: -5.2 }, start: { x: -18.5, z: -1.4 } });
const PHOTO = Object.freeze({ spot: { x: 2.7, z: 9.4 }, start: { x: 1.2, z: 3.1 } });

export class ParkActors {
  constructor({ root, anchors = {} }) {
    this.root = root;
    this.anchors = anchors;
    this.group = new THREE.Group();
    this.group.name = 'Lobby/park-actors';
    this.root.add(this.group);
    this.time = 0;
    this.owned = { geometries: [], materials: [] };
    this.actors = [
      this._carouselActor(0, 1),
      this._carouselActor(1, 5),
      this._trainActor(),
      this._photoActor(),
    ];
    this._build();
  }

  _carouselActor(i, horse) {
    return {
      kind: 'carousel', horse, path: [CAROUSEL.start, CAROUSEL.board],
      x: CAROUSEL.start.x + i * 0.7, z: CAROUSEL.start.z, y: 0,
      state: 'walk', node: 1, timer: 0, ground: 0, yaw: 0,
    };
  }

  _trainActor() {
    return {
      kind: 'train', path: [TRAIN.start, TRAIN.board],
      x: TRAIN.start.x, z: TRAIN.start.z, y: 0,
      state: 'walk', node: 1, timer: 0, ground: 0, yaw: 0,
    };
  }

  _photoActor() {
    return {
      kind: 'photo', path: [PHOTO.start, PHOTO.spot],
      x: PHOTO.start.x, z: PHOTO.start.z, y: 0,
      state: 'walk', node: 1, timer: 0, ground: 0, yaw: 0,
    };
  }

  _build() {
    const bodyGeo = new THREE.CapsuleGeometry(0.22, 0.62, 1, 5);
    const headGeo = new THREE.SphereGeometry(0.17, 6, 4);
    const legGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.5, 4);
    const armGeo = new THREE.BoxGeometry(0.12, 0.52, 0.12);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.86 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd7a67e, roughness: 0.9 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2b323a, roughness: 0.95 });
    const armMat = new THREE.MeshStandardMaterial({ color: 0xd7a67e, roughness: 0.9 });
    const n = this.actors.length;
    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, n);
    this.head = new THREE.InstancedMesh(headGeo, skinMat, n);
    this.legs = new THREE.InstancedMesh(legGeo, legMat, n * 2);
    this.arms = new THREE.InstancedMesh(armGeo, armMat, n * 2);
    this.body.name = 'Lobby/park-actor-body';
    this.head.name = 'Lobby/park-actor-head';
    this.legs.name = 'Lobby/park-actor-legs';
    this.arms.name = 'Lobby/park-actor-arms';
    for (const m of [this.body, this.head, this.legs, this.arms]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      this.group.add(m);
    }
    const palette = [0x4e6b50, 0x8c4a42, 0x3f5b7a, 0xd0b06a];
    this.actors.forEach((a, i) => this.body.setColorAt(i, new THREE.Color(palette[i])));
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    this.owned.geometries.push(bodyGeo, headGeo, legGeo, armGeo);
    this.owned.materials.push(bodyMat, skinMat, legMat, armMat);
    this._dummy = new THREE.Object3D();
    this._world = new THREE.Vector3();
    this._write(0);
  }

  _walkTo(a, dt) {
    const target = a.path[a.node];
    const dx = target.x - a.x, dz = target.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.08) {
      if (a.kind === 'carousel') { a.state = 'ride'; a.timer = 18; }
      else if (a.kind === 'train') { a.state = 'ride'; a.timer = 20; }
      else { a.state = 'photo'; a.timer = 13; }
      return;
    }
    const sp = 1.15;
    a.x += (dx / d) * sp * dt;
    a.z += (dz / d) * sp * dt;
    a.yaw = Math.atan2(dx, dz);
  }

  _returnHome(a, dt) {
    const p = a.path[0];
    const dx = p.x - a.x, dz = p.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) {
      a.timer -= dt;
      if (a.timer <= 0) { a.state = 'walk'; a.node = 1; }
      return;
    }
    const sp = 1.05;
    a.x += (dx / d) * sp * dt;
    a.z += (dz / d) * sp * dt;
    a.yaw = Math.atan2(dx, dz);
  }

  _updateActor(a, dt) {
    if (a.state === 'walk') {
      this._walkTo(a, dt);
      a.ground = 0;
    } else if (a.state === 'ride') {
      a.timer -= dt;
      if (a.kind === 'carousel') {
        const spin = this.anchors.carousel?.rotation.y ?? this.time * 0.35;
        const angle = (a.horse / 8) * Math.PI * 2 + spin;
        a.x = CAROUSEL.x + Math.cos(angle) * CAROUSEL.radius;
        a.z = CAROUSEL.z + Math.sin(angle) * CAROUSEL.radius;
        a.yaw = -angle; // 面向切线方向，像随木马旋转
        a.ground = 1.88;
      } else {
        const train = this.anchors.train;
        if (train) {
          train.getWorldPosition(this._world);
          a.x = this._world.x;
          a.z = this._world.z + 0.05;
          a.yaw = train.rotation.y;
        } else {
          a.x = TRAIN.x;
          a.z = TRAIN.z + Math.sin(this.time * 0.45) * 1.62;
          a.yaw = 0;
        }
        a.ground = 1.58;
      }
      if (a.timer <= 0) { a.state = 'return'; a.timer = 3.5; }
    } else if (a.state === 'photo') {
      a.timer -= dt;
      a.yaw = Math.PI * 0.25;
      if (a.timer <= 0) { a.state = 'return'; a.timer = 3.5; }
    } else {
      this._returnHome(a, dt);
      a.ground = 0;
    }
  }

  _write(dt) {
    const d = this._dummy;
    this.actors.forEach((a, i) => {
      if (dt > 0) this._updateActor(a, dt);
      const bob = a.state === 'walk' || a.state === 'return' ? Math.abs(Math.sin(this.time * 7 + i)) * 0.035 : 0;
      const g = a.ground;
      // 照片动作：身体略后仰，右臂抬高
      const photo = a.kind === 'photo' && a.state === 'photo';
      d.position.set(a.x, g + 0.63 + bob, a.z);
      d.rotation.set(photo ? -0.12 : 0, a.yaw, 0);
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      this.body.setMatrixAt(i, d.matrix);
      d.position.set(a.x, g + 1.2 + bob, a.z);
      d.rotation.set(photo ? -0.18 : 0, a.yaw, 0);
      d.updateMatrix();
      this.head.setMatrixAt(i, d.matrix);
      for (let l = 0; l < 2; l++) {
        const swing = (a.state === 'walk' || a.state === 'return') ? Math.sin(this.time * 9 + l * Math.PI) * 0.18 : 0;
        d.position.set(a.x, g + 0.27, a.z);
        d.rotation.set(0, a.yaw, 0);
        d.translateZ(0.18);
        d.translateX(l ? 0.1 : -0.1);
        d.rotateX(swing);
        d.updateMatrix();
        this.legs.setMatrixAt(i * 2 + l, d.matrix);
      }
      // 双臂：拍照时右臂抬起；木马/火车坐姿时双臂扶握
      for (let s = 0; s < 2; s++) {
        const right = s === 1;
        const lift = photo && right ? -2.1 : 0.05;
        const spread = right ? 0.29 : -0.29;
        d.position.set(a.x, g + 1.06, a.z);
        d.rotation.set(lift, a.yaw, 0);
        d.translateX(spread);
        d.updateMatrix();
        this.arms.setMatrixAt(i * 2 + s, d.matrix);
      }
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.legs.instanceMatrix.needsUpdate = true;
    this.arms.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    this.time += Math.min(Math.max(dt, 0), 0.1);
    this._write(dt);
  }

  getStats() {
    return {
      total: this.actors.length,
      carouselRiders: this.actors.filter((a) => a.kind === 'carousel').length,
      trainRiders: this.actors.filter((a) => a.kind === 'train').length,
      photographers: this.actors.filter((a) => a.kind === 'photo').length,
      states: this.actors.map((a) => a.state),
    };
  }

  dispose() {
    this.root.remove(this.group);
    this.group.clear();
    for (const g of this.owned.geometries) { try { g.dispose(); } catch { /* noop */ } }
    for (const m of this.owned.materials) { try { m.dispose(); } catch { /* noop */ } }
    this.owned.geometries.length = 0;
    this.owned.materials.length = 0;
  }
}
