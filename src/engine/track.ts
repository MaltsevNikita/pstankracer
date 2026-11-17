import * as THREE from 'three';
import { Ps1Materials } from './ps1';
import { angleDiff, canvasTexture, clamp, mulberry32, wrap01, wrapDelta } from './util';

export const TRACK_HALF_WIDTH = 8.5;
const SAMPLE_COUNT = 720;
const ROAD_TILE_LENGTH = 26;
const UP = new THREE.Vector3(0, 1, 0);

export interface TrackHit {
  s: number;
  lateral: number;
  y: number;
  rightX: number;
  rightZ: number;
  tangentX: number;
  tangentZ: number;
  index: number;
}

export interface BoostPad {
  s: number;
  lateral: number;
}

export interface PickupSpot {
  s: number;
  lateral: number;
}

function trackRadius(theta: number): number {
  return (
    262 +
    54 * Math.sin(3 * theta + 0.7) +
    28 * Math.cos(2 * theta - 0.4) -
    52 * Math.exp(-Math.pow(angleDiff(theta, 2.3), 2) / 0.03) +
    22 * Math.exp(-Math.pow(angleDiff(theta, 5.2), 2) / 0.02)
  );
}

function elevationAt(t: number, length: number): number {
  const bumps = [
    { s: 0.17, sigma: 0.0095, h: 3.1 },
    { s: 0.58, sigma: 0.011, h: 3.7 },
  ];
  let y = 0;
  for (const bump of bumps) {
    const d = wrapDelta(t, bump.s) * length;
    y += bump.h * Math.exp(-(d * d) / (2 * Math.pow(bump.sigma * length, 2)));
  }
  return y;
}

interface InstanceEntry {
  position: THREE.Vector3;
  rotationY: number;
  scale: THREE.Vector3;
  color: number;
}

function buildInstances(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  entries: InstanceEntry[],
): THREE.InstancedMesh | null {
  if (entries.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const color = new THREE.Color();
  entries.forEach((entry, i) => {
    quat.setFromAxisAngle(UP, entry.rotationY);
    matrix.compose(entry.position, quat, entry.scale);
    mesh.setMatrixAt(i, matrix);
    color.setHex(entry.color);
    mesh.setColorAt(i, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

export class Track {
  readonly group = new THREE.Group();
  readonly points: THREE.Vector3[] = [];
  readonly tangents: THREE.Vector3[] = [];
  readonly rights: THREE.Vector3[] = [];
  readonly sampleCount = SAMPLE_COUNT;
  readonly halfWidth = TRACK_HALF_WIDTH;
  readonly length: number;
  readonly boostPads: BoostPad[] = [];
  readonly pickupSpots: PickupSpot[] = [];

  private readonly distances: number[] = [];
  private readonly materials: Ps1Materials;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(materials: Ps1Materials) {
    this.materials = materials;
    this.buildCenterline();
    this.length = this.distances[this.distances.length - 1];

    this.buildGround();
    this.buildRoad();
    this.buildTrackside();
    this.buildBoostPads();
    this.buildStartLine();
    this.buildGantry(0, true);
    this.buildGantry(0.33, false);
    this.buildGantry(0.71, false);
    this.buildScenery();

    this.boostPads.push(
      { s: 0.045, lateral: -3.2 },
      { s: 0.235, lateral: 3.2 },
      { s: 0.395, lateral: -2.6 },
      { s: 0.63, lateral: 2.8 },
      { s: 0.815, lateral: -2.4 },
    );
    this.pickupSpots.push(
      { s: 0.115, lateral: 4.2 },
      { s: 0.3, lateral: -4.2 },
      { s: 0.465, lateral: 3.6 },
      { s: 0.56, lateral: -4.2 },
      { s: 0.69, lateral: 4.2 },
      { s: 0.88, lateral: -3.8 },
    );

    for (const pad of this.boostPads) this.addBoostPadVisual(pad);
  }

  // --------------------------------------------------------------- sampling

  pointAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = wrap01(s) * SAMPLE_COUNT;
    const i = Math.floor(f);
    const t = f - i;
    const a = this.points[i];
    const b = this.points[(i + 1) % SAMPLE_COUNT];
    return out.copy(a).lerp(b, t);
  }

  rightAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = wrap01(s) * SAMPLE_COUNT;
    const i = Math.floor(f);
    const t = f - i;
    const a = this.rights[i];
    const b = this.rights[(i + 1) % SAMPLE_COUNT];
    return out.set(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t).normalize();
  }

  tangentAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = wrap01(s) * SAMPLE_COUNT;
    const i = Math.floor(f);
    const t = f - i;
    const a = this.tangents[i];
    const b = this.tangents[(i + 1) % SAMPLE_COUNT];
    return out.set(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t).normalize();
  }

  heightAt(s: number): number {
    const f = wrap01(s) * SAMPLE_COUNT;
    const i = Math.floor(f);
    const t = f - i;
    const a = this.points[i];
    const b = this.points[(i + 1) % SAMPLE_COUNT];
    return a.y + (b.y - a.y) * t;
  }

  slopeAt(s: number): number {
    const delta = 0.0016;
    return (this.heightAt(s + delta) - this.heightAt(s - delta)) / (delta * 2 * this.length);
  }

  nearest(x: number, z: number): TrackHit {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const p = this.points[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }

    const next = (best + 1) % SAMPLE_COUNT;
    const a = this.points[best];
    const b = this.points[next];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
    const px = a.x + abx * t;
    const pz = a.z + abz * t;

    const r0 = this.rights[best];
    const r1 = this.rights[next];
    let rx = r0.x + (r1.x - r0.x) * t;
    let rz = r0.z + (r1.z - r0.z) * t;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;

    const t0 = this.tangents[best];
    const t1 = this.tangents[next];
    let tx = t0.x + (t1.x - t0.x) * t;
    let tz = t0.z + (t1.z - t0.z) * t;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;

    return {
      s: (best + t) / SAMPLE_COUNT,
      lateral: (x - px) * rx + (z - pz) * rz,
      y: a.y + (b.y - a.y) * t,
      rightX: rx,
      rightZ: rz,
      tangentX: tx,
      tangentZ: tz,
      index: best,
    };
  }

  distanceToTrack(x: number, z: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SAMPLE_COUNT; i += 2) {
      const p = this.points[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const dist = dx * dx + dz * dz;
      if (dist < best) best = dist;
    }
    return Math.sqrt(best);
  }

  // ------------------------------------------------------------- centerline

  private buildCenterline(): void {
    const denseCount = 4000;
    const dense: THREE.Vector3[] = [];
    for (let i = 0; i < denseCount; i++) {
      const theta = (i / denseCount) * Math.PI * 2;
      const radius = trackRadius(theta);
      dense.push(new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius));
    }

    const denseDistances: number[] = [0];
    for (let i = 1; i <= denseCount; i++) {
      const a = dense[i - 1];
      const b = dense[i % denseCount];
      denseDistances.push(denseDistances[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const total = denseDistances[denseCount];

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const target = (i / SAMPLE_COUNT) * total;
      let lo = 0;
      let hi = denseCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (denseDistances[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const index = Math.max(1, lo);
      const d0 = denseDistances[index - 1];
      const d1 = denseDistances[index];
      const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
      const a = dense[(index - 1) % denseCount];
      const b = dense[index % denseCount];
      const point = new THREE.Vector3(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t);
      point.y = elevationAt(i / SAMPLE_COUNT, total);
      this.points.push(point);
      this.distances.push(target);
    }
    this.distances.push(total);

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const prev = this.points[(i - 1 + SAMPLE_COUNT) % SAMPLE_COUNT];
      const next = this.points[(i + 1) % SAMPLE_COUNT];
      const tangent = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z).normalize();
      this.tangents.push(tangent);
      this.rights.push(new THREE.Vector3().crossVectors(tangent, UP).normalize());
    }
  }

  // ------------------------------------------------------------------ meshes

  private ribbonGeometry(
    innerOffset: number,
    outerOffset: number,
    yOffset: number,
    uvLength: number,
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const n = SAMPLE_COUNT;

    // Ribbons on the left side are built from a negative offset, so keep the
    // vertex order left-to-right to preserve the same winding on both sides.
    if (innerOffset > outerOffset) {
      const swap = innerOffset;
      innerOffset = outerOffset;
      outerOffset = swap;
    }

    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const p = this.points[k];
      const r = this.rights[k];
      const v = this.distances[k] / uvLength;
      positions.push(p.x + r.x * innerOffset, p.y + yOffset, p.z + r.z * innerOffset);
      uvs.push(0, v);
      positions.push(p.x + r.x * outerOffset, p.y + yOffset, p.z + r.z * outerOffset);
      uvs.push(1, v);
      if (i < n) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private verticalRibbonGeometry(side: number, offset: number, height: number): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const n = SAMPLE_COUNT;

    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const p = this.points[k];
      const r = this.rights[k];
      const u = this.distances[k] / 12;
      const x = p.x + r.x * offset * side;
      const z = p.z + r.z * offset * side;
      positions.push(x, p.y, z);
      uvs.push(u, 0);
      positions.push(x, p.y + height, z);
      uvs.push(u, 1);
      if (i < n) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private buildGround(): void {
    const texture = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.fillStyle = '#4e4d3b';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.fillStyle = Math.random() < 0.5 ? '#464536' : '#5a5844';
        ctx.fillRect(x, y, 2, 2);
      }
    });
    texture.repeat.set(180, 180);
    const material = this.materials.lambert({ map: texture });
    // A single huge quad interpolates depth badly near the camera, which made
    // the terrain cover the track ribbons. Tessellate so each triangle stays
    // small on screen.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4200, 4200, 64, 64), material);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.45;
    this.group.add(ground);
  }

  private buildRoad(): void {
    const asphalt = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#46474b';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 1800; i++) {
        const x = Math.floor(Math.random() * w);
        const y = Math.floor(Math.random() * h);
        ctx.fillStyle = Math.random() < 0.5 ? '#3d3e42' : '#505155';
        ctx.fillRect(x, y, 2, 2);
      }
      ctx.fillStyle = '#c9c5b2';
      ctx.fillRect(6, 0, 4, h);
      ctx.fillRect(w - 10, 0, 4, h);
      ctx.fillStyle = '#d8d2b8';
      ctx.fillRect(w / 2 - 3, 6, 6, 36);
      ctx.fillRect(w / 2 - 3, 70, 6, 36);
    });

    const roadMaterial = this.materials.lambert({ map: asphalt });
    const road = new THREE.Mesh(
      this.ribbonGeometry(-TRACK_HALF_WIDTH, TRACK_HALF_WIDTH, 0.06, ROAD_TILE_LENGTH),
      roadMaterial,
    );
    road.frustumCulled = false;
    this.group.add(road);

    const dirtTexture = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.fillStyle = '#625a42';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 500; i++) {
        ctx.fillStyle = Math.random() < 0.5 ? '#574f3a' : '#6d6449';
        ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
      }
    });
    const dirtMaterial = this.materials.lambert({ map: dirtTexture });

    const runoffLeft = new THREE.Mesh(
      this.ribbonGeometry(-TRACK_HALF_WIDTH - 10, -TRACK_HALF_WIDTH, 0.03, 30),
      dirtMaterial,
    );
    const runoffRight = new THREE.Mesh(
      this.ribbonGeometry(TRACK_HALF_WIDTH, TRACK_HALF_WIDTH + 10, 0.03, 30),
      dirtMaterial,
    );
    runoffLeft.frustumCulled = false;
    runoffRight.frustumCulled = false;
    this.group.add(runoffLeft, runoffRight);

    const curbTexture = canvasTexture(8, 64, (ctx, w, h) => {
      ctx.fillStyle = '#b23a2e';
      ctx.fillRect(0, 0, w, h / 2);
      ctx.fillStyle = '#d8d0b8';
      ctx.fillRect(0, h / 2, w, h / 2);
    });
    const curbMaterial = this.materials.lambert({ map: curbTexture });

    for (const side of [-1, 1]) {
      const inner = side * (TRACK_HALF_WIDTH - 0.15);
      const outer = side * (TRACK_HALF_WIDTH + 1.0);
      const curb = new THREE.Mesh(this.ribbonGeometry(inner, outer, 0.09, 8), curbMaterial);
      curb.frustumCulled = false;
      this.group.add(curb);
    }
  }

  private buildTrackside(): void {
    const barrierTexture = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.fillStyle = '#6f7168';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#55574f';
      ctx.fillRect(0, 22, w, 6);
      ctx.fillStyle = '#8a8c80';
      for (let x = 6; x < w; x += 16) {
        ctx.fillRect(x, 8, 2, 2);
        ctx.fillRect(x, 44, 2, 2);
      }
    });
    const barrierMaterial = this.materials.lambert({ map: barrierTexture, side: THREE.DoubleSide });

    for (const side of [-1, 1]) {
      const barrier = new THREE.Mesh(
        this.verticalRibbonGeometry(side, TRACK_HALF_WIDTH + 1.25, 1.35),
        barrierMaterial,
      );
      barrier.frustumCulled = false;
      this.group.add(barrier);
    }
  }

  private buildBoostPads(): void {
    // Visuals are added after the pad list is filled.
  }

  private addBoostPadVisual(pad: BoostPad): void {
    const texture = canvasTexture(64, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(20, 44, 44, 0.4)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(95, 227, 208, 0.95)';
      for (let i = 0; i < 3; i++) {
        const y = 16 + i * 34;
        ctx.beginPath();
        ctx.moveTo(8, y + 22);
        ctx.lineTo(w / 2, y);
        ctx.lineTo(w - 8, y + 22);
        ctx.lineTo(w - 8, y + 32);
        ctx.lineTo(w / 2, y + 10);
        ctx.lineTo(8, y + 32);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(232, 255, 58, 0.7)';
      ctx.lineWidth = 3;
      ctx.strokeRect(2, 2, w - 4, h - 4);
    });
    const material = this.materials.basic({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.PlaneGeometry(4.6, 7.4);
    geometry.rotateX(-Math.PI / 2);
    const padMesh = new THREE.Mesh(geometry, material);
    const point = this.pointAt(pad.s, this.tmpA);
    const right = this.rightAt(pad.s, this.tmpB);
    const tangent = this.tangentAt(pad.s, new THREE.Vector3());
    padMesh.position.set(
      point.x + right.x * pad.lateral,
      this.heightAt(pad.s) + 0.13,
      point.z + right.z * pad.lateral,
    );
    padMesh.rotation.y = Math.atan2(tangent.x, tangent.z);
    padMesh.frustumCulled = false;
    this.group.add(padMesh);
  }

  private buildStartLine(): void {
    const checker = canvasTexture(64, 64, (ctx, w, h) => {
      const size = 8;
      for (let y = 0; y < h; y += size) {
        for (let x = 0; x < w; x += size) {
          ctx.fillStyle = (x / size + y / size) % 2 === 0 ? '#e8e4d2' : '#1c1d1a';
          ctx.fillRect(x, y, size, size);
        }
      }
    });
    checker.repeat.set(5, 1);

    const geometry = new THREE.PlaneGeometry(TRACK_HALF_WIDTH * 2, 4.2);
    geometry.rotateX(-Math.PI / 2);
    const material = this.materials.lambert({ map: checker });
    const line = new THREE.Mesh(geometry, material);
    const p = this.pointAt(0, this.tmpA);
    const tangent = this.tangentAt(0, this.tmpB);
    line.position.set(p.x, p.y + 0.1, p.z);
    line.rotation.y = Math.atan2(tangent.x, tangent.z);
    this.group.add(line);
  }

  private buildGantry(s: number, withBanner: boolean): void {
    const p = this.pointAt(s, new THREE.Vector3());
    const tangent = this.tangentAt(s, new THREE.Vector3());
    const yaw = Math.atan2(tangent.x, tangent.z);
    const group = new THREE.Group();
    group.position.copy(p);
    group.rotation.y = yaw;

    const metal = this.materials.lambert({ color: 0x4b4f49 });
    const dark = this.materials.lambert({ color: 0x2a2c28 });
    const span = TRACK_HALF_WIDTH + 3.4;

    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.0, 9, 1.0), metal);
      pillar.position.set(side * span, 4.5, 0);
      group.add(pillar);

      const foot = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 1.8), dark);
      foot.position.set(side * span, 0.4, 0);
      group.add(foot);
    }

    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 1.2, 1.1, 1.2), metal);
    beam.position.set(0, 9.1, 0);
    group.add(beam);

    if (withBanner) {
      const bannerTexture = canvasTexture(512, 128, (ctx, w, h) => {
        ctx.fillStyle = '#111a1c';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#e8ff3a';
        ctx.lineWidth = 8;
        ctx.strokeRect(4, 4, w - 8, h - 8);
        ctx.fillStyle = '#e8ff3a';
        ctx.font = 'bold 68px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('IRON LAP', w / 2, h / 2 + 2);
      });
      const material = this.materials.basic({ map: bannerTexture, side: THREE.DoubleSide });
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(span * 2 + 0.6, 2.8), material);
      banner.position.set(0, 7.4, 0);
      group.add(banner);

      const bannerBack = new THREE.Mesh(banner.geometry, material);
      bannerBack.position.set(0, 7.4, -0.02);
      bannerBack.rotation.y = Math.PI;
      group.add(bannerBack);
    }

    this.group.add(group);
  }

  private buildScenery(): void {
    const rng = mulberry32(0x1a2b3c);
    const containers: InstanceEntry[] = [];
    const barrels: InstanceEntry[] = [];
    const blocks: InstanceEntry[] = [];
    const poles: InstanceEntry[] = [];
    const lampHeads: InstanceEntry[] = [];
    const hills: InstanceEntry[] = [];

    const palette = [0x8a4a32, 0x3f6b63, 0x5d6442, 0x3d5876, 0x8f8348, 0x6b4a4a];

    const place = (
      target: InstanceEntry[],
      scale: THREE.Vector3,
      color: number,
      minOffset: number,
      maxOffset: number,
      rotationJitter: number,
    ) => {
      for (let attempt = 0; attempt < 24; attempt++) {
        const s = rng();
        const side = rng() < 0.5 ? -1 : 1;
        const lateral = (TRACK_HALF_WIDTH + minOffset + rng() * (maxOffset - minOffset)) * side;
        const p = this.pointAt(s, new THREE.Vector3());
        const r = this.rightAt(s, new THREE.Vector3());
        const x = p.x + r.x * lateral;
        const z = p.z + r.z * lateral;
        if (this.distanceToTrack(x, z) < TRACK_HALF_WIDTH + 5) continue;
        if (Math.hypot(x, z) > 900) continue;
        target.push({
          position: new THREE.Vector3(x, 0, z),
          rotationY: rng() * Math.PI * 2,
          scale,
          color,
        });
        return;
      }
    };

    for (let i = 0; i < 64; i++) {
      place(
        containers,
        new THREE.Vector3(3.2 + rng() * 3.4, 2.6 + rng() * 2.2, 6.5 + rng() * 8),
        palette[Math.floor(rng() * palette.length)],
        7,
        30,
        0,
      );
    }

    for (let i = 0; i < 46; i++) {
      place(
        barrels,
        new THREE.Vector3(1.15, 1.4 + rng() * 0.8, 1.15),
        rng() < 0.5 ? 0x7a4a2e : 0x4f5a3a,
        4,
        16,
        0,
      );
    }

    for (let i = 0; i < 34; i++) {
      place(
        blocks,
        new THREE.Vector3(2.2 + rng() * 1.4, 0.9 + rng() * 0.8, 3.4 + rng() * 2.2),
        0x6b6b60,
        5,
        18,
        0,
      );
    }

    for (let i = 0; i < 20; i++) {
      const s = rng();
      const side = rng() < 0.5 ? -1 : 1;
      const lateral = (TRACK_HALF_WIDTH + 3.6) * side;
      const p = this.pointAt(s, new THREE.Vector3());
      const r = this.rightAt(s, new THREE.Vector3());
      const x = p.x + r.x * lateral;
      const z = p.z + r.z * lateral;
      poles.push({
        position: new THREE.Vector3(x, 4.6, z),
        rotationY: 0,
        scale: new THREE.Vector3(1, 1, 1),
        color: 0x3c3f3a,
      });
      lampHeads.push({
        position: new THREE.Vector3(x, 9.2, z),
        rotationY: 0,
        scale: new THREE.Vector3(1, 1, 1),
        color: 0xffe6a3,
      });
    }

    for (let i = 0; i < 26; i++) {
      const theta = (i / 26) * Math.PI * 2 + rng() * 0.12;
      const radius = 330 + rng() * 300;
      hills.push({
        position: new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius),
        rotationY: rng() * Math.PI,
        scale: new THREE.Vector3(40 + rng() * 70, 14 + rng() * 32, 40 + rng() * 70),
        color: rng() < 0.5 ? 0x4a523f : 0x3f4838,
      });
    }

    const containerMesh = buildInstances(
      new THREE.BoxGeometry(1, 1, 1),
      this.materials.lambert({ color: 0xffffff }),
      containers,
    );
    const barrelMesh = buildInstances(
      new THREE.CylinderGeometry(0.55, 0.55, 1, 8),
      this.materials.lambert({ color: 0xffffff }),
      barrels,
    );
    const blockMesh = buildInstances(
      new THREE.BoxGeometry(1, 1, 1),
      this.materials.lambert({ color: 0xffffff }),
      blocks,
    );
    const poleMesh = buildInstances(
      new THREE.CylinderGeometry(0.09, 0.13, 9.2, 6),
      this.materials.lambert({ color: 0x3c3f3a }),
      poles,
    );
    const lampMesh = buildInstances(
      new THREE.BoxGeometry(1.8, 0.32, 0.7),
      this.materials.basic({ color: 0xffe6a3 }),
      lampHeads,
    );
    const hillMesh = buildInstances(
      new THREE.ConeGeometry(1, 1, 7),
      this.materials.lambert({ color: 0x454c3a }),
      hills,
    );

    for (const mesh of [containerMesh, barrelMesh, blockMesh, poleMesh, lampMesh, hillMesh]) {
      if (mesh) {
        mesh.frustumCulled = false;
        this.group.add(mesh);
      }
    }

    // Scattered rocks and concrete debris close to the road.
    const debris: InstanceEntry[] = [];
    for (let i = 0; i < 90; i++) {
      const s = rng();
      const side = rng() < 0.5 ? -1 : 1;
      const lateral = (TRACK_HALF_WIDTH + 2.2 + rng() * 6) * side;
      const p = this.pointAt(s, new THREE.Vector3());
      const r = this.rightAt(s, new THREE.Vector3());
      debris.push({
        position: new THREE.Vector3(p.x + r.x * lateral, 0.1 + rng() * 0.2, p.z + r.z * lateral),
        rotationY: rng() * Math.PI,
        scale: new THREE.Vector3(0.4 + rng() * 1.1, 0.3 + rng() * 0.7, 0.4 + rng() * 1.1),
        color: rng() < 0.5 ? 0x5c5b50 : 0x6d6a5c,
      });
    }
    const debrisMesh = buildInstances(
      new THREE.DodecahedronGeometry(1, 0),
      this.materials.lambert({ color: 0xffffff }),
      debris,
    );
    if (debrisMesh) {
      debrisMesh.frustumCulled = false;
      this.group.add(debrisMesh);
    }
  }

  /** Sample points for the minimap and other 2D overlays. */
  minimapPoints(step = 8): Array<{ x: number; z: number }> {
    const result: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < SAMPLE_COUNT; i += step) {
      result.push({ x: this.points[i].x, z: this.points[i].z });
    }
    return result;
  }
}
