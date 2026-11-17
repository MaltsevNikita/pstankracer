import * as THREE from 'three';
import { AudioSys } from './audio';
import { Effects } from './effects';
import { Ps1Materials } from './ps1';
import { Tank } from './tank';
import { PickupSpot, Track } from './track';

export type WeaponType = 'none' | 'missile' | 'mine';

export interface WeaponActor {
  tank: Tank;
  weapon: WeaponType;
}

interface Missile {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  owner: WeaponActor;
  target: WeaponActor | null;
}

interface Mine {
  mesh: THREE.Group;
  position: THREE.Vector3;
  life: number;
  arm: number;
  owner: WeaponActor;
  blink: number;
}

interface Ball {
  mesh: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  owner: WeaponActor;
}

interface Pickup {
  spot: PickupSpot;
  mesh: THREE.Group;
  type: Exclude<WeaponType, 'none'>;
  active: boolean;
  timer: number;
  baseY: number;
  phase: number;
}

export interface WeaponCallbacks {
  onHit(victim: WeaponActor, attacker: WeaponActor | null): void;
  onPickup(actor: WeaponActor, type: WeaponType): void;
  onFire(actor: WeaponActor, type: WeaponType): void;
}

const MISSILE_SPEED = 88;
const MISSILE_LIFE = 3.8;
/** Default player cannon: straight orange balls, unlimited ammo. */
const BALL_SPEED = 80;
const BALL_LIFE = 2.6;
const MAX_BALLS = 64;
const mineLightGeometry = new THREE.BoxGeometry(0.22, 0.22, 0.22);

export class Weapons {
  private readonly scene: THREE.Scene;
  private readonly track: Track;
  private readonly effects: Effects;
  private readonly audio: AudioSys;
  private readonly callbacks: WeaponCallbacks;
  private readonly materials: Ps1Materials;

  private readonly missiles: Missile[] = [];
  private readonly mines: Mine[] = [];
  private readonly balls: Ball[] = [];
  private readonly pickups: Pickup[] = [];
  private readonly ballGeometry = new THREE.SphereGeometry(0.78, 9, 7);
  private readonly ballMaterial: THREE.MeshBasicMaterial;
  private readonly missileGeometry = new THREE.ConeGeometry(0.28, 1.5, 5);
  private readonly missileMaterial: THREE.MeshBasicMaterial;
  private readonly mineGeometry = new THREE.CylinderGeometry(0.72, 0.82, 0.3, 8);
  private readonly mineMaterial: THREE.MeshLambertMaterial;
  private readonly mineLightMaterial: THREE.MeshBasicMaterial;
  private readonly pickupGeometry = new THREE.OctahedronGeometry(0.95, 0);
  private readonly ringGeometry = new THREE.TorusGeometry(1.5, 0.1, 4, 12);
  private readonly pickupMaterials: Record<'missile' | 'mine', THREE.MeshBasicMaterial>;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly tmp = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private time = 0;

  constructor(
    scene: THREE.Scene,
    materials: Ps1Materials,
    track: Track,
    effects: Effects,
    audio: AudioSys,
    callbacks: WeaponCallbacks,
  ) {
    this.scene = scene;
    this.track = track;
    this.effects = effects;
    this.audio = audio;
    this.materials = materials;
    this.callbacks = callbacks;

    this.ballMaterial = materials.basic({ color: 0xffa42a });

    this.missileMaterial = materials.basic({ color: 0x2b2b2b });
    this.missileMaterial.color.setHex(0x2f2f2f);

    this.mineMaterial = materials.lambert({ color: 0x3c4a44 });
    this.mineLightMaterial = materials.basic({ color: 0xff4d3d });
    this.pickupMaterials = {
      missile: materials.basic({ color: 0xff8a2a }),
      mine: materials.basic({ color: 0x5fe3d0 }),
    };
    this.ringMaterial = materials.basic({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    this.buildPickups();
  }

  private buildPickups(): void {
    this.track.pickupSpots.forEach((spot, index) => {
      const type: Pickup['type'] = index % 2 === 0 ? 'missile' : 'mine';
      const group = new THREE.Group();
      const gem = new THREE.Mesh(this.pickupGeometry, this.pickupMaterials[type]);
      group.add(gem);

      const ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -2.05;
      group.add(ring);

      const point = this.track.pointAt(spot.s, new THREE.Vector3());
      const right = this.track.rightAt(spot.s, new THREE.Vector3());
      const baseY = this.track.heightAt(spot.s) + 2.4;
      group.position.set(
        point.x + right.x * spot.lateral,
        baseY,
        point.z + right.z * spot.lateral,
      );
      group.frustumCulled = false;
      this.scene.add(group);

      this.pickups.push({
        spot,
        mesh: group,
        type,
        active: true,
        timer: 0,
        baseY,
        phase: Math.random() * Math.PI * 2,
      });
    });
  }

  fire(actor: WeaponActor, actors: WeaponActor[]): WeaponType {
    if (actor.weapon === 'none') return 'none';

    if (actor.weapon === 'missile') {
      this.spawnMissile(actor, actors);
      actor.weapon = 'none';
      this.callbacks.onFire(actor, 'missile');
      return 'missile';
    }

    this.spawnMine(actor);
    actor.weapon = 'none';
    this.callbacks.onFire(actor, 'mine');
    return 'mine';
  }

  /**
   * Player's default gun: a straight orange ball, no ammo, no homing.
   * Fired along the barrel, so it follows whatever the turret is aiming at.
   */
  fireBall(actor: WeaponActor): void {
    if (this.balls.length >= MAX_BALLS) {
      const oldest = this.balls.shift();
      if (oldest) this.scene.remove(oldest.mesh);
    }

    actor.tank.root.updateMatrixWorld(true);
    actor.tank.turret.getWorldQuaternion(this.tmpQuat);
    this.tmpDir.set(0, 0, 1).applyQuaternion(this.tmpQuat).normalize();

    const position = actor.tank.muzzleWorldPosition();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.ballGeometry, this.ballMaterial));
    group.position.copy(position);
    group.frustumCulled = false;
    this.scene.add(group);

    this.balls.push({
      mesh: group,
      position,
      velocity: this.tmpDir.clone().multiplyScalar(BALL_SPEED),
      life: BALL_LIFE,
      owner: actor,
    });

    this.effects.muzzle(position);
    this.audio.shot();
    actor.tank.fireVisual();
  }

  private spawnMissile(actor: WeaponActor, actors: WeaponActor[]): void {
    actor.tank.root.updateMatrixWorld(true);
    actor.tank.turret.getWorldQuaternion(this.tmpQuat);
    this.tmpDir.set(0, 0, 1).applyQuaternion(this.tmpQuat).normalize();

    const position = actor.tank.muzzleWorldPosition();
    const mesh = new THREE.Mesh(this.missileGeometry, this.missileMaterial);
    mesh.position.copy(position);
    mesh.quaternion.copy(this.tmpQuat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    const target = this.findTarget(actor, actors);
    this.missiles.push({
      mesh,
      position,
      velocity: this.tmpDir.clone().multiplyScalar(MISSILE_SPEED),
      life: MISSILE_LIFE,
      owner: actor,
      target,
    });

    this.effects.muzzle(position);
    this.audio.shot();
    actor.tank.fireVisual();
  }

  private spawnMine(actor: WeaponActor): void {
    const position = actor.tank.pos
      .clone()
      .addScaledVector(actor.tank.forward, -4.2);
    position.y = Math.max(0.18, actor.tank.pos.y + 0.18);

    const group = new THREE.Group();
    const body = new THREE.Mesh(this.mineGeometry, this.mineMaterial);
    body.position.y = 0.15;
    group.add(body);
    const light = new THREE.Mesh(mineLightGeometry, this.mineLightMaterial);
    light.position.y = 0.45;
    group.add(light);
    group.position.copy(position);
    group.frustumCulled = false;
    this.scene.add(group);

    this.mines.push({
      mesh: group,
      position,
      life: 26,
      arm: 0.9,
      owner: actor,
      blink: 0,
    });
    this.audio.drop();
  }

  private findTarget(actor: WeaponActor, actors: WeaponActor[]): WeaponActor | null {
    const forward = actor.tank.forward;
    let best: WeaponActor | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const other of actors) {
      if (other === actor) continue;
      const dx = other.tank.pos.x - actor.tank.pos.x;
      const dz = other.tank.pos.z - actor.tank.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 4 || dist > 130) continue;
      const dot = (dx * forward.x + dz * forward.z) / dist;
      if (dot < 0.55) continue;
      const score = dist - dot * 45;
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  update(dt: number, actors: WeaponActor[]): void {
    this.time += dt;

    this.updatePickups(dt, actors);
    this.updateBalls(dt, actors);
    this.updateMissiles(dt, actors);
    this.updateMines(dt, actors);
  }

  private updateBalls(dt: number, actors: WeaponActor[]): void {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];
      ball.life -= dt;
      ball.position.addScaledVector(ball.velocity, dt);
      ball.mesh.position.copy(ball.position);
      ball.mesh.rotation.y += dt * 9;

      let hitActor: WeaponActor | null = null;
      for (const actor of actors) {
        if (actor === ball.owner) continue;
        const dx = actor.tank.pos.x - ball.position.x;
        const dz = actor.tank.pos.z - ball.position.z;
        const dy = actor.tank.pos.y + 0.95 - ball.position.y;
        if (dx * dx + dz * dz + dy * dy < 9.6) {
          hitActor = actor;
          break;
        }
      }

      const ground = this.track.nearest(ball.position.x, ball.position.z);
      const offTrack = Math.abs(ground.lateral) > this.track.halfWidth + 7;

      if (hitActor || offTrack || ball.position.y < ground.y + 0.35 || ball.life <= 0) {
        if (hitActor) this.callbacks.onHit(hitActor, ball.owner);
        this.effects.spawn(ball.position, 0xffa63a, 10, 8, 0.4, 6);
        this.effects.flash(ball.position, 0xffc06a, 2.6, 0.12);
        this.audio.impact();
        this.scene.remove(ball.mesh);
        this.balls.splice(i, 1);
      }
    }
  }

  private updatePickups(dt: number, actors: WeaponActor[]): void {
    for (const pickup of this.pickups) {
      pickup.mesh.rotation.y += dt * 2.2;
      pickup.mesh.position.y = pickup.baseY + Math.sin(this.time * 2.1 + pickup.phase) * 0.3;

      if (!pickup.active) {
        pickup.timer -= dt;
        if (pickup.timer <= 0) {
          pickup.active = true;
          pickup.mesh.visible = true;
        }
        continue;
      }

      for (const actor of actors) {
        if (actor.weapon !== 'none') continue;
        const dx = actor.tank.pos.x - pickup.mesh.position.x;
        const dz = actor.tank.pos.z - pickup.mesh.position.z;
        if (dx * dx + dz * dz > 16) continue;
        if (Math.abs(actor.tank.pos.y - pickup.mesh.position.y) > 6) continue;

        actor.weapon = pickup.type;
        pickup.active = false;
        pickup.timer = 7;
        pickup.mesh.visible = false;
        this.callbacks.onPickup(actor, pickup.type);
        this.audio.pickup();
        break;
      }
    }
  }

  private updateMissiles(dt: number, actors: WeaponActor[]): void {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const missile = this.missiles[i];
      missile.life -= dt;

      if (missile.target && missile.target.tank.spinTimer > 2) missile.target = null;
      if (missile.target) {
        const desired = this.tmp
          .copy(missile.target.tank.pos)
          .add(new THREE.Vector3(0, 1.1, 0))
          .sub(missile.position)
          .normalize();
        const speed = missile.velocity.length();
        const desiredVelocity = desired.multiplyScalar(speed);
        missile.velocity.lerp(desiredVelocity, 1 - Math.exp(-3.4 * dt));
        missile.velocity.setLength(speed);
      }

      missile.position.addScaledVector(missile.velocity, dt);
      missile.mesh.position.copy(missile.position);
      missile.mesh.lookAt(this.tmp.copy(missile.position).add(missile.velocity));
      missile.mesh.rotateX(Math.PI / 2);

      if (Math.random() < dt * 22) {
        this.effects.spawn(missile.position, 0xff8a2a, 1, 1.2, 0.28, 0);
      }

      let hitActor: WeaponActor | null = null;
      for (const actor of actors) {
        if (actor === missile.owner) continue;
        const dx = actor.tank.pos.x - missile.position.x;
        const dz = actor.tank.pos.z - missile.position.z;
        const dy = actor.tank.pos.y + 0.9 - missile.position.y;
        if (dx * dx + dz * dz + dy * dy < 11) {
          hitActor = actor;
          break;
        }
      }

      if (hitActor || missile.life <= 0 || missile.position.y < 0) {
        this.effects.explosion(missile.position);
        this.audio.explosion();
        if (hitActor) this.callbacks.onHit(hitActor, missile.owner);
        this.scene.remove(missile.mesh);
        this.missiles.splice(i, 1);
      }
    }
  }

  private updateMines(dt: number, actors: WeaponActor[]): void {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mine = this.mines[i];
      mine.life -= dt;
      mine.arm -= dt;
      mine.blink += dt;
      const light = mine.mesh.children[1] as THREE.Mesh;
      light.visible = mine.arm <= 0 ? Math.sin(mine.blink * 12) > 0 : Math.sin(mine.blink * 4) > 0;

      let victim: WeaponActor | null = null;
      if (mine.arm <= 0) {
        for (const actor of actors) {
          if (actor === mine.owner) continue;
          const dx = actor.tank.pos.x - mine.position.x;
          const dz = actor.tank.pos.z - mine.position.z;
          if (dx * dx + dz * dz < 10.2 && Math.abs(actor.tank.pos.y - mine.position.y) < 4) {
            victim = actor;
            break;
          }
        }
      }

      if (victim || mine.life <= 0) {
        if (victim) {
          this.effects.explosion(this.tmp.copy(mine.position).setY(mine.position.y + 0.6));
          this.audio.explosion();
          this.callbacks.onHit(victim, mine.owner);
        }
        this.scene.remove(mine.mesh);
        this.mines.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const ball of this.balls) this.scene.remove(ball.mesh);
    for (const missile of this.missiles) this.scene.remove(missile.mesh);
    for (const mine of this.mines) this.scene.remove(mine.mesh);
    for (const pickup of this.pickups) this.scene.remove(pickup.mesh);
    this.ballGeometry.dispose();
    this.ballMaterial.dispose();
    this.missileGeometry.dispose();
    this.missileMaterial.dispose();
    this.mineGeometry.dispose();
    this.mineMaterial.dispose();
    this.mineLightMaterial.dispose();
    this.pickupGeometry.dispose();
    this.ringGeometry.dispose();
    for (const material of Object.values(this.pickupMaterials)) material.dispose();
    this.ringMaterial.dispose();
  }
}
