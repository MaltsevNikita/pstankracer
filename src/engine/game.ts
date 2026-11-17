import * as THREE from 'three';
import { AiDriver, Difficulty } from './ai';
import { AudioSys } from './audio';
import { Effects } from './effects';
import { Controls, Input } from './input';
import { Ps1Renderer } from './ps1';
import { Tank, TankInput } from './tank';
import { Track } from './track';
import { WeaponActor, Weapons, WeaponType } from './weapons';
import { clamp, damp, wrap01, wrapDelta } from './util';

export const DEFAULT_LAPS = 3;
export const MIN_LAPS = 1;
export const MAX_LAPS = 9;
export type CameraMode = 'chase' | 'hood';

export interface GameSettings {
  difficulty: Difficulty;
  camera: CameraMode;
  volume: number;
  muted: boolean;
  laps: number;
}

export interface HudRacerState {
  x: number;
  z: number;
  color: number;
  isPlayer: boolean;
}

export type MessageKind = 'big' | 'small' | 'danger';

export interface HudState {
  place: number;
  total: number;
  lap: number;
  laps: number;
  time: number;
  bestLap: number | null;
  lastLap: number | null;
  speed: number;
  boost: number;
  weapon: WeaponType;
  message: string;
  messageKind: MessageKind;
  wrongWay: boolean;
  countdown: number | null;
  racers: HudRacerState[];
}

export interface RacerResult {
  name: string;
  color: number;
  isPlayer: boolean;
  place: number;
  time: number | null;
  bestLap: number | null;
  lapsDone: number;
}

export interface RaceResult {
  trackName: string;
  laps: number;
  racers: RacerResult[];
  playerPlace: number;
  playerTime: number;
  bestLap: number | null;
}

export interface GameCallbacks {
  onHud(state: HudState): void;
  onTrack(points: Array<{ x: number; z: number }>): void;
  onFinish(result: RaceResult): void;
  onPause(): void;
}

interface Racer extends WeaponActor {
  name: string;
  color: number;
  isPlayer: boolean;
  ai: AiDriver | null;
  progress: number;
  trackS: number;
  lapsDone: number;
  lapStart: number;
  lapTimes: number[];
  bestLap: number | null;
  finished: boolean;
  finishTime: number;
  groundY: number;
  wrongWayTimer: number;
  fireCooldown: number;
  dustTimer: number;
}

interface GridSlot {
  name: string;
  color: number;
  isPlayer: boolean;
  distance: number;
  lateral: number;
  lane: number;
  seed: number;
}

const GRID: GridSlot[] = [
  { name: 'ГРОМ', color: 0x4f8fd6, isPlayer: false, distance: 9, lateral: -3.2, lane: -1.9, seed: 11 },
  { name: 'ВЕПРЬ', color: 0xc25a3c, isPlayer: false, distance: 9, lateral: 3.2, lane: 2.4, seed: 22 },
  { name: 'ШТОРМ', color: 0x7f9b4a, isPlayer: false, distance: 17, lateral: -3.2, lane: -2.2, seed: 33 },
  { name: 'ВЫ', color: 0xf2c53d, isPlayer: true, distance: 17, lateral: 3.2, lane: 0, seed: 0 },
];

export class Game {
  private readonly renderer: Ps1Renderer;
  private readonly track: Track;
  private readonly effects: Effects;
  private readonly weapons: Weapons;
  private readonly input = new Input();
  private readonly audio: AudioSys;
  private readonly callbacks: GameCallbacks;
  private readonly racers: Racer[] = [];
  private readonly player: Racer;

  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();

  private state: 'countdown' | 'racing' | 'finished' = 'countdown';
  private paused = false;
  private disposed = false;
  private resultsShown = false;
  private cameraMode: CameraMode;
  private readonly difficulty: Difficulty;
  private readonly laps: number;

  private raceTime = 0;
  private countdown = 3;
  private lastCount = 4;
  private finishTimer = 0;
  private lastTime = 0;
  private accumulator = 0;
  private hudTimer = 0;
  private raf = 0;

  private message = '';
  private messageKind: MessageKind = 'big';
  private messageTimer = 0;
  private throttleInput = 0;
  private pendingFire = false;
  private pendingSpecial = false;

  constructor(
    canvas: HTMLCanvasElement,
    audio: AudioSys,
    settings: GameSettings,
    callbacks: GameCallbacks,
  ) {
    this.audio = audio;
    this.callbacks = callbacks;
    this.cameraMode = settings.camera;
    this.difficulty = settings.difficulty;
    this.laps = Number.isFinite(settings.laps)
      ? Math.min(MAX_LAPS, Math.max(MIN_LAPS, Math.round(settings.laps)))
      : DEFAULT_LAPS;

    this.renderer = new Ps1Renderer(canvas);
    this.renderer.resize(window.innerWidth, window.innerHeight);

    this.track = new Track(this.renderer.materials);
    this.renderer.scene.add(this.track.group);

    this.effects = new Effects(this.renderer.scene, this.renderer.materials);

    for (const slot of GRID) {
      this.racers.push(this.createRacer(slot));
    }
    this.player = this.racers.find((r) => r.isPlayer) ?? this.racers[0];

    this.weapons = new Weapons(
      this.renderer.scene,
      this.renderer.materials,
      this.track,
      this.effects,
      this.audio,
      {
        onHit: (victim, attacker) => this.handleHit(victim, attacker),
        onPickup: (actor, type) => this.handlePickup(actor, type),
        onFire: () => {},
      },
    );

    this.input.attach();
    window.addEventListener('resize', this.onResize);

    callbacks.onTrack(this.track.minimapPoints(6));

    const fwd = this.player.tank.forward;
    this.camPos.copy(this.player.tank.pos).addScaledVector(fwd, -11.5);
    this.camPos.y += 5.4;
    this.camLook.copy(this.player.tank.pos).addScaledVector(fwd, 9);
    this.camLook.y += 1.6;
    this.updateCamera(1);

    if (import.meta.env.DEV) {
      (window as unknown as { __ironlap?: Game }).__ironlap = this;
    }
  }

  private readonly onResize = (): void => {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  };

  private createRacer(slot: GridSlot): Racer {
    const s = wrap01(1 - slot.distance / this.track.length);
    const point = this.track.pointAt(s);
    const right = this.track.rightAt(s);
    const tangent = this.track.tangentAt(s);
    const yaw = Math.atan2(tangent.x, tangent.z);
    const x = point.x + right.x * slot.lateral;
    const z = point.z + right.z * slot.lateral;
    const y = this.track.heightAt(s);

    const tank = new Tank(this.renderer.materials, {
      color: slot.color,
      isPlayer: slot.isPlayer,
    });
    tank.placeAt(x, y, z, yaw);
    this.renderer.scene.add(tank.root);

    const ai = slot.isPlayer
      ? null
      : new AiDriver(this.track, this.difficulty, slot.lane, slot.seed);

    return {
      name: slot.name,
      color: slot.color,
      isPlayer: slot.isPlayer,
      tank,
      weapon: 'none',
      ai,
      progress: s - 1,
      trackS: s,
      lapsDone: 0,
      lapStart: 0,
      lapTimes: [],
      bestLap: null,
      finished: false,
      finishTime: 0,
      groundY: y,
      wrongWayTimer: 0,
      fireCooldown: 0,
      dustTimer: 0,
    };
  }

  start(): void {
    this.audio.init();
    this.audio.startEngine();
    this.lastTime = performance.now();
    this.racerReadyMessage();
    this.raf = requestAnimationFrame(this.frame);
  }

  private racerReadyMessage(): void {
    this.setMessage('', 'big', 0);
    this.pushHud();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.pendingFire = false;
    this.pendingSpecial = false;
    this.input.clear();
    this.lastTime = performance.now();
    this.accumulator = 0;
    if (paused) {
      this.audio.stopEngine();
    } else if (!this.resultsShown) {
      this.audio.startEngine();
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);

    const dt = clamp((now - this.lastTime) / 1000, 0, 0.08);
    this.lastTime = now;

    if (this.paused) {
      this.renderer.render();
      return;
    }

    const controls = this.input.poll();
    if (controls.pause) {
      this.paused = true;
      this.audio.stopEngine();
      this.pendingFire = false;
      this.pendingSpecial = false;
      this.input.clear();
      this.callbacks.onPause();
      this.renderer.render();
      return;
    }

    if (controls.camera) {
      this.cameraMode = this.cameraMode === 'chase' ? 'hood' : 'chase';
    }

    // Buffer the presses: on high refresh rates a frame may not run a fixed step,
    // and the key would otherwise be swallowed.
    if (controls.fire) this.pendingFire = true;
    if (controls.special) this.pendingSpecial = true;

    this.accumulator += dt;
    const stepDt = 1 / 60;
    let steps = 0;
    while (this.accumulator >= stepDt && steps < 5) {
      this.step(stepDt, controls);
      this.accumulator -= stepDt;
      steps += 1;
    }
    if (steps === 5) this.accumulator = 0;

    this.visual(dt);

    this.hudTimer += dt;
    if (this.hudTimer >= 1 / 30) {
      this.hudTimer = 0;
      this.pushHud();
    }

    this.renderer.render();
  };

  private step(dt: number, controls: Controls): void {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0 && this.state !== 'countdown') this.message = '';
    }

    if (this.state === 'countdown') {
      this.audio.updateEngine(0.05, 0.3);
      const count = Math.max(1, Math.ceil(this.countdown));
      if (count !== this.lastCount) {
        this.lastCount = count;
        this.audio.beep(count === 1);
      }
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.raceTime = 0;
        for (const racer of this.racers) racer.lapStart = 0;
        this.setMessage('СТАРТ', 'big', 1.1);
        this.audio.beep(true);
      }
      return;
    }

    if (!this.paused) this.raceTime += dt;

    this.throttleInput = controls.throttle;

    for (const racer of this.racers) {
      let input: TankInput = { throttle: 0, steer: 0, boost: false };
      if (!(racer.isPlayer && racer.finished)) {
        if (racer.isPlayer) {
          if (this.state === 'racing') {
            input = { throttle: controls.throttle, steer: controls.steer, boost: controls.boost };
          }
        } else if (racer.ai) {
          input = racer.ai.update(
            dt,
            racer.tank,
            racer.trackS,
            this.player.progress - racer.progress,
          );
        }
      }
      racer.tank.step(dt, input);
    }

    this.resolveTankCollisions();
    this.updateTurrets();

    for (const racer of this.racers) {
      this.updateRacerOnTrack(racer, dt);
    }

    this.updateBoostPads();
    this.weapons.update(dt, this.racers);
    this.updateAiWeapons(dt);

    if (this.pendingFire) {
      if (this.state === 'racing' && !this.player.finished) {
        this.weapons.fireBall(this.player);
      }
      this.pendingFire = false;
    }

    if (this.pendingSpecial) {
      if (this.state === 'racing' && !this.player.finished) {
        this.weapons.fire(this.player, this.racers);
      }
      this.pendingSpecial = false;
    }

    this.updateDust(dt);
    this.audio.updateEngine(this.player.tank.speed / 57, controls.throttle);

    if (this.state === 'finished' && !this.resultsShown) {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0) {
        this.resultsShown = true;
        this.audio.stopEngine();
        this.paused = true;
        this.callbacks.onFinish(this.buildResult());
      }
    }
  }

  private updateRacerOnTrack(racer: Racer, dt: number): void {
    const tank = racer.tank;
    const hit = this.track.nearest(tank.pos.x, tank.pos.z);
    const limit = this.track.halfWidth - 1.4;

    if (Math.abs(hit.lateral) > limit) {
      const side = Math.sign(hit.lateral);
      const push = Math.abs(hit.lateral) - limit;
      tank.pos.x -= hit.rightX * push * side;
      tank.pos.z -= hit.rightZ * push * side;

      const normalSpeed = tank.vel.x * hit.rightX + tank.vel.z * hit.rightZ;
      if (normalSpeed * side > 0) {
        tank.vel.x -= hit.rightX * normalSpeed * 1.25;
        tank.vel.z -= hit.rightZ * normalSpeed * 1.25;
        if (Math.abs(normalSpeed) > 9) {
          this.effects.sparks(this.tmpA.copy(tank.pos).setY(tank.pos.y + 0.9));
          if (racer.isPlayer) {
            this.effects.shake = Math.max(this.effects.shake, 0.35);
            this.audio.crash();
          }
        }
      }
      tank.syncSpeed();
    }

    const previousS = racer.trackS;
    racer.trackS = hit.s;
    if (!racer.finished) {
      racer.progress += wrapDelta(hit.s, previousS);
    }

    const groundY = hit.y + 0.04;
    racer.groundY = groundY;

    if (!tank.airborne) {
      const slope = this.track.slopeAt(hit.s);
      tank.pos.y = groundY;
      const aheadY = this.track.heightAt(hit.s + 0.006);
      if (groundY - aheadY > 0.9 && Math.abs(tank.speed) > 21) {
        tank.airborne = true;
        tank.vy = Math.max(1.4, this.track.slopeAt(hit.s - 0.005) * Math.abs(tank.speed) * 1.2);
      }
    } else {
      tank.vy -= 30 * dt;
      tank.pos.y += tank.vy * dt;
      if (tank.pos.y <= groundY) {
        tank.pos.y = groundY;
        if (tank.vy < -8) {
          this.effects.sparks(this.tmpA.copy(tank.pos).setY(tank.pos.y + 0.4));
          if (racer.isPlayer) this.effects.shake = Math.max(this.effects.shake, 0.3);
        }
        tank.vy = 0;
        tank.airborne = false;
      }
    }

    const forwardDot = tank.vel.x * hit.tangentX + tank.vel.z * hit.tangentZ;
    if (!racer.finished && forwardDot < -4 && this.state === 'racing') {
      racer.wrongWayTimer += dt;
    } else {
      racer.wrongWayTimer = Math.max(0, racer.wrongWayTimer - dt * 3);
    }

    if (!racer.finished) {
      const completed = Math.floor(racer.progress + 1e-4);
      if (completed > racer.lapsDone && completed > 0) {
        const lapTime = this.raceTime - racer.lapStart;
        racer.lapStart = this.raceTime;
        racer.lapsDone = Math.min(completed, this.laps);
        if (lapTime > 1) {
          racer.lapTimes.push(lapTime);
          if (racer.bestLap === null || lapTime < racer.bestLap) racer.bestLap = lapTime;
        }

        if (racer.isPlayer) {
          if (completed < this.laps) {
            this.setMessage(`КРУГ ${completed + 1}/${this.laps}`, 'small', 1.7);
          }
        }

        if (completed >= this.laps) {
          this.finishRacer(racer);
        }
      }
    }
  }

  private finishRacer(racer: Racer): void {
    racer.finished = true;
    racer.finishTime = this.raceTime;
    racer.lapsDone = this.laps;
    if (!racer.isPlayer) return;

    this.state = 'finished';
    this.accumulator = 0;
    this.finishTimer = 1.9;
    this.setMessage('ФИНИШ', 'big', 2);
    this.audio.finish();
  }

  private resolveTankCollisions(): void {
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i];
        const b = this.racers[j];
        const dx = b.tank.pos.x - a.tank.pos.x;
        const dz = b.tank.pos.z - a.tank.pos.z;
        const dist = Math.hypot(dx, dz);
        const minDist = a.tank.radius + b.tank.radius;
        if (dist < 0.001 || dist >= minDist) continue;

        const nx = dx / dist;
        const nz = dz / dist;
        const overlap = (minDist - dist) * 0.5;
        a.tank.pos.x -= nx * overlap;
        a.tank.pos.z -= nz * overlap;
        b.tank.pos.x += nx * overlap;
        b.tank.pos.z += nz * overlap;

        const relative = (b.tank.vel.x - a.tank.vel.x) * nx + (b.tank.vel.z - a.tank.vel.z) * nz;
        if (relative < 0) {
          const impulse = -relative * 0.55;
          a.tank.vel.x -= nx * impulse;
          a.tank.vel.z -= nz * impulse;
          b.tank.vel.x += nx * impulse;
          b.tank.vel.z += nz * impulse;

          if (-relative > 14) {
            this.effects.sparks(
              this.tmpA.set((a.tank.pos.x + b.tank.pos.x) * 0.5, a.tank.pos.y + 1, (a.tank.pos.z + b.tank.pos.z) * 0.5),
            );
            this.audio.crash();
            if (a.isPlayer || b.isPlayer) {
              this.effects.shake = Math.max(this.effects.shake, 0.45);
            }
          }
        }

        a.tank.syncSpeed();
        b.tank.syncSpeed();
      }
    }
  }

  private updateTurrets(): void {
    for (const racer of this.racers) {
      let best: Racer | null = null;
      let bestDist = 70 * 70;
      for (const other of this.racers) {
        if (other === racer) continue;
        const dx = other.tank.pos.x - racer.tank.pos.x;
        const dz = other.tank.pos.z - racer.tank.pos.z;
        const dist = dx * dx + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          best = other;
        }
      }
      if (best) racer.tank.aimAt(best.tank.pos.x, best.tank.pos.z);
      else racer.tank.clearAim();
    }
  }

  private updateBoostPads(): void {
    for (const pad of this.track.boostPads) {
      const point = this.track.pointAt(pad.s, this.tmpA);
      const right = this.track.rightAt(pad.s, this.tmpB);
      const px = point.x + right.x * pad.lateral;
      const pz = point.z + right.z * pad.lateral;

      for (const racer of this.racers) {
        if (racer.tank.padCooldown > 0) continue;
        const dx = racer.tank.pos.x - px;
        const dz = racer.tank.pos.z - pz;
        if (dx * dx + dz * dz > 18) continue;
        racer.tank.boostTimer = 2.3;
        racer.tank.padCooldown = 1.2;
        if (racer.isPlayer) {
          this.audio.boost();
          this.setMessage('БУСТ', 'small', 0.7);
        }
      }
    }
  }

  private updateAiWeapons(dt: number): void {
    for (const racer of this.racers) {
      if (racer.isPlayer) continue;
      racer.fireCooldown = Math.max(0, racer.fireCooldown - dt);
      if (racer.weapon === 'none' || racer.fireCooldown > 0) continue;

      if (racer.weapon === 'missile') {
        if (this.rivalAhead(racer, 105, 0.55)) {
          this.weapons.fire(racer, this.racers);
          racer.fireCooldown = 2.4;
        }
      } else if (this.rivalBehind(racer, 34)) {
        this.weapons.fire(racer, this.racers);
        racer.fireCooldown = 3.4;
      }
    }
  }

  private rivalAhead(racer: Racer, maxDistance: number, minDot: number): boolean {
    const forward = racer.tank.forward;
    for (const other of this.racers) {
      if (other === racer) continue;
      const dx = other.tank.pos.x - racer.tank.pos.x;
      const dz = other.tank.pos.z - racer.tank.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 3 || dist > maxDistance) continue;
      if ((dx * forward.x + dz * forward.z) / dist >= minDot) return true;
    }
    return false;
  }

  private rivalBehind(racer: Racer, maxDistance: number): boolean {
    const forward = racer.tank.forward;
    for (const other of this.racers) {
      if (other === racer) continue;
      const dx = other.tank.pos.x - racer.tank.pos.x;
      const dz = other.tank.pos.z - racer.tank.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 3 || dist > maxDistance) continue;
      if ((dx * forward.x + dz * forward.z) / dist < -0.35) return true;
    }
    return false;
  }

  private handleHit(victim: WeaponActor, attacker: WeaponActor | null): void {
    const victimRacer = victim as Racer;
    const attackerRacer = attacker as Racer | null;
    const dx = attackerRacer ? victim.tank.pos.x - attackerRacer.tank.pos.x : 1;
    const dz = attackerRacer ? victim.tank.pos.z - attackerRacer.tank.pos.z : 0;
    const cross = victim.tank.forward.x * dz - victim.tank.forward.z * dx;
    victim.tank.applyHit(cross >= 0 ? 1 : -1);

    if (victimRacer.isPlayer) {
      this.setMessage('В ВАС ПОПАЛИ', 'danger', 1.3);
      this.effects.shake = Math.max(this.effects.shake, 0.85);
      this.audio.crash();
    } else if (attackerRacer?.isPlayer) {
      this.setMessage('ПОПАДАНИЕ', 'small', 1.1);
    }
  }

  private handlePickup(actor: WeaponActor, type: WeaponType): void {
    if (!(actor as Racer).isPlayer) return;
    this.setMessage(type === 'missile' ? 'РАКЕТА' : 'МИНА', 'small', 0.9);
  }

  private updateDust(dt: number): void {
    for (const racer of this.racers) {
      racer.dustTimer -= dt;
      if (racer.dustTimer > 0 || racer.tank.airborne) continue;
      if (Math.abs(racer.tank.speed) < 14) continue;
      racer.dustTimer = 0.09;
      const rear = this.tmpA
        .copy(racer.tank.pos)
        .addScaledVector(racer.tank.forward, -2.6);
      rear.y = racer.groundY + 0.15;
      this.effects.dust(rear, racer.tank.vel);
    }
  }

  private visual(dt: number): void {
    for (const racer of this.racers) {
      racer.tank.syncVisual(dt, racer.groundY);
    }
    this.effects.update(dt);
    this.updateCamera(dt);
  }

  private updateCamera(dt: number): void {
    const tank = this.player.tank;
    const forward = tank.forward;
    const speed = Math.abs(tank.speed);
    const desired = this.tmpA;
    const look = this.tmpB;

    if (this.cameraMode === 'hood') {
      // Rigidly attached: smoothing would leave the camera behind the turret.
      desired.copy(tank.pos).addScaledVector(forward, 3.1);
      desired.y += 2.95;
      look.copy(tank.pos).addScaledVector(forward, 42);
      look.y += 1.7;
      this.camPos.copy(desired);
      this.camLook.copy(look);
    } else {
      desired.copy(tank.pos).addScaledVector(forward, -11.5);
      desired.y += 5.4;
      look.copy(tank.pos).addScaledVector(forward, 9);
      look.y += 1.6;
      this.camPos.lerp(desired, 1 - Math.exp(-7 * dt));
      this.camLook.lerp(look, 1 - Math.exp(-10 * dt));
    }

    const ground = this.track.heightAt(this.player.trackS);
    if (this.camPos.y < ground + 1.4) this.camPos.y = ground + 1.4;

    const camera = this.renderer.camera;
    camera.position.copy(this.camPos);
    const shake = this.effects.shake;
    if (shake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake * 1.4;
      camera.position.y += (Math.random() - 0.5) * shake;
      camera.position.z += (Math.random() - 0.5) * shake * 1.4;
    }
    camera.lookAt(this.camLook);

    const targetFov = 68 + Math.min(1, speed / 70) * 12;
    camera.fov = damp(camera.fov, targetFov, 4, dt);
    camera.updateProjectionMatrix();
  }

  private setMessage(text: string, kind: MessageKind, duration: number): void {
    this.message = text;
    this.messageKind = kind;
    this.messageTimer = duration;
  }

  private ordered(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.progress - a.progress;
    });
  }

  private buildResult(): RaceResult {
    const ordered = this.ordered();
    const player = this.player;
    return {
      trackName: 'ЗАВОДСКОЙ КРУГ',
      laps: this.laps,
      playerPlace: ordered.indexOf(player) + 1,
      playerTime: player.finishTime,
      bestLap: player.bestLap,
      racers: ordered.map((racer, index) => ({
        name: racer.name,
        color: racer.color,
        isPlayer: racer.isPlayer,
        place: index + 1,
        time: racer.finished ? racer.finishTime : null,
        bestLap: racer.bestLap,
        lapsDone: racer.lapsDone,
      })),
    };
  }

  private pushHud(): void {
    const ordered = this.ordered();
    const player = this.player;
    const place = ordered.indexOf(player) + 1;

    this.callbacks.onHud({
      place,
      total: this.racers.length,
      lap: Math.min(this.laps, player.lapsDone + 1),
      laps: this.laps,
      time: this.raceTime,
      bestLap: player.bestLap,
      lastLap: player.lapTimes.length > 0 ? player.lapTimes[player.lapTimes.length - 1] : null,
      speed: Math.round(Math.abs(player.tank.speed) * 1.75),
      boost: Math.max(clamp(player.tank.boostTimer / 2.3, 0, 1), player.tank.nitro),
      weapon: player.weapon,
      message: this.state === 'countdown' ? '' : this.message,
      messageKind: this.messageKind,
      wrongWay: player.wrongWayTimer > 0.5,
      countdown: this.state === 'countdown' ? Math.max(1, Math.ceil(this.countdown)) : null,
      racers: this.racers.map((racer) => ({
        x: racer.tank.pos.x,
        z: racer.tank.pos.z,
        color: racer.color,
        isPlayer: racer.isPlayer,
      })),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.audio.stopEngine();
    this.weapons.dispose();
    this.effects.dispose();
    this.renderer.dispose();
  }
}
