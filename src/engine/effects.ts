import * as THREE from 'three';
import { Ps1Materials } from './ps1';
import { clamp } from './util';

const MAX_PARTICLES = 900;
const MAX_FLASHES = 10;

interface Flash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  size: number;
}

export class Effects {
  shake = 0;

  private readonly scene: THREE.Scene;
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private readonly baseColors = new Float32Array(MAX_PARTICLES * 3);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly gravity = new Float32Array(MAX_PARTICLES);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private readonly flashes: Flash[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene, materials: Ps1Materials) {
    this.scene = scene;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.positions[i * 3 + 1] = -9999;
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.55,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    const flashGeometry = new THREE.SphereGeometry(1, 8, 6);
    for (let i = 0; i < MAX_FLASHES; i++) {
      const flashMaterial = materials.basic({
        color: 0xffaa33,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(flashGeometry, flashMaterial);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.flashes.push({ mesh, life: 0, maxLife: 1, size: 1 });
    }
  }

  spawn(
    position: THREE.Vector3,
    color: number,
    count: number,
    speed: number,
    life: number,
    gravity: number,
  ): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;

      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI;
      const magnitude = speed * (0.35 + Math.random() * 0.65);

      this.positions[index * 3] = position.x + (Math.random() - 0.5) * 0.8;
      this.positions[index * 3 + 1] = position.y + (Math.random() - 0.5) * 0.8;
      this.positions[index * 3 + 2] = position.z + (Math.random() - 0.5) * 0.8;

      this.velocities[index * 3] = Math.cos(yaw) * Math.cos(pitch) * magnitude;
      this.velocities[index * 3 + 1] = Math.sin(pitch) * magnitude + speed * 0.4;
      this.velocities[index * 3 + 2] = Math.sin(yaw) * Math.cos(pitch) * magnitude;

      const variation = 0.7 + Math.random() * 0.5;
      this.baseColors[index * 3] = c.r * variation;
      this.baseColors[index * 3 + 1] = c.g * variation;
      this.baseColors[index * 3 + 2] = c.b * variation;
      this.colors[index * 3] = this.baseColors[index * 3];
      this.colors[index * 3 + 1] = this.baseColors[index * 3 + 1];
      this.colors[index * 3 + 2] = this.baseColors[index * 3 + 2];

      this.maxLife[index] = life * (0.6 + Math.random() * 0.8);
      this.life[index] = this.maxLife[index];
      this.gravity[index] = gravity;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  explosion(position: THREE.Vector3): void {
    this.spawn(position, 0xff8a2a, 26, 20, 0.8, 16);
    this.spawn(position, 0xffe08a, 14, 12, 0.55, 12);
    this.spawn(position, 0x5a5a5a, 10, 2.6, 1.4, -1.6);
    this.flash(position, 0xffb347, 6.5, 0.24);
    this.shake = Math.max(this.shake, 0.55);
  }

  muzzle(position: THREE.Vector3): void {
    this.spawn(position, 0xffd36a, 6, 5, 0.16, 2);
    this.flash(position, 0xffc65a, 1.6, 0.08);
  }

  sparks(position: THREE.Vector3): void {
    this.spawn(position, 0xffd89a, 12, 9, 0.35, 20);
    this.shake = Math.max(this.shake, 0.22);
  }

  dust(position: THREE.Vector3, velocity: THREE.Vector3): void {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.positions[index * 3] = position.x;
    this.positions[index * 3 + 1] = position.y + 0.2;
    this.positions[index * 3 + 2] = position.z;
    this.velocities[index * 3] = -velocity.x * 0.12 + (Math.random() - 0.5) * 1.6;
    this.velocities[index * 3 + 1] = 0.8 + Math.random() * 1.2;
    this.velocities[index * 3 + 2] = -velocity.z * 0.12 + (Math.random() - 0.5) * 1.6;
    const shade = 0.35 + Math.random() * 0.2;
    this.baseColors[index * 3] = 0.3 * shade;
    this.baseColors[index * 3 + 1] = 0.27 * shade;
    this.baseColors[index * 3 + 2] = 0.2 * shade;
    this.colors[index * 3] = this.baseColors[index * 3];
    this.colors[index * 3 + 1] = this.baseColors[index * 3 + 1];
    this.colors[index * 3 + 2] = this.baseColors[index * 3 + 2];
    this.maxLife[index] = 0.45;
    this.life[index] = 0.45;
    this.gravity[index] = -0.4;
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  flash(position: THREE.Vector3, color: number, size: number, life: number): void {
    const flash = this.flashes.find((f) => f.life <= 0);
    if (!flash) return;
    flash.mesh.position.copy(position);
    flash.mesh.visible = true;
    flash.mesh.scale.setScalar(size * 0.4);
    const material = flash.mesh.material as THREE.MeshBasicMaterial;
    material.color.setHex(color);
    material.opacity = 0.9;
    flash.life = life;
    flash.maxLife = life;
    flash.size = size;
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.2);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -9999;
        this.colors[i * 3] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        continue;
      }
      const inv = 1 / Math.max(0.0001, this.maxLife[i]);
      const fade = clamp(this.life[i] * inv, 0, 1);
      this.velocities[i * 3 + 1] -= this.gravity[i] * dt;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      if (this.positions[i * 3 + 1] < 0.05) {
        this.positions[i * 3 + 1] = 0.05;
        this.velocities[i * 3 + 1] *= -0.35;
        this.velocities[i * 3] *= 0.7;
        this.velocities[i * 3 + 2] *= 0.7;
      }
      this.colors[i * 3] = this.baseColors[i * 3] * fade;
      this.colors[i * 3 + 1] = this.baseColors[i * 3 + 1] * fade;
      this.colors[i * 3 + 2] = this.baseColors[i * 3 + 2] * fade;
    }

    for (const flash of this.flashes) {
      if (flash.life <= 0) {
        if (flash.mesh.visible) flash.mesh.visible = false;
        continue;
      }
      flash.life -= dt;
      const k = clamp(flash.life / flash.maxLife, 0, 1);
      const scale = flash.size * (0.35 + (1 - k) * 0.9);
      flash.mesh.scale.setScalar(scale);
      (flash.mesh.material as THREE.MeshBasicMaterial).opacity = k * 0.85;
      if (flash.life <= 0) flash.mesh.visible = false;
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const flash of this.flashes) {
      this.scene.remove(flash.mesh);
      (flash.mesh.material as THREE.Material).dispose();
    }
  }
}
