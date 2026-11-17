import * as THREE from 'three';
import { Tank, TankInput } from './tank';
import { Track } from './track';
import { angleDiff, clamp, mulberry32 } from './util';

export type Difficulty = 'easy' | 'normal' | 'hard';

const BASE_SPEED: Record<Difficulty, number> = {
  easy: 42,
  normal: 48.5,
  hard: 53.5,
};

const SKILL: Record<Difficulty, number> = {
  easy: 0.35,
  normal: 0.65,
  hard: 0.95,
};

export class AiDriver {
  private readonly track: Track;
  private readonly difficulty: Difficulty;
  private readonly baseSpeed: number;
  private readonly skill: number;
  private readonly laneOffset: number;
  private readonly phase: number;
  private readonly rng: () => number;
  private time = 0;
  private mistakeTimer = 0;
  private mistakeSteer = 0;
  private rubber = 0;

  private readonly tmpTarget = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpT1 = new THREE.Vector3();
  private readonly tmpT2 = new THREE.Vector3();

  constructor(track: Track, difficulty: Difficulty, laneOffset: number, seed: number) {
    this.track = track;
    this.difficulty = difficulty;
    this.baseSpeed = BASE_SPEED[difficulty];
    this.skill = SKILL[difficulty];
    this.laneOffset = laneOffset;
    this.rng = mulberry32(seed);
    this.phase = this.rng() * Math.PI * 2;
  }

  update(dt: number, tank: Tank, trackS: number, progressGap: number): TankInput {
    this.time += dt;

    // Positive gap means the AI is behind the player.
    const targetRubber = clamp(progressGap * 1.1, -0.09, 0.11);
    this.rubber += (targetRubber - this.rubber) * Math.min(1, dt * 0.8);

    const speed = Math.abs(tank.speed);
    const lookahead = 15 + speed * 0.42 + this.skill * 6;
    const targetS = trackS + lookahead / this.track.length;

    const point = this.track.pointAt(targetS, this.tmpTarget);
    const right = this.track.rightAt(targetS, this.tmpRight);
    const wobble = Math.sin(this.time * 0.55 + this.phase) * 0.9;
    const lane = this.laneOffset + wobble;

    const dx = point.x + right.x * lane - tank.pos.x;
    const dz = point.z + right.z * lane - tank.pos.z;
    const desiredYaw = Math.atan2(dx, dz);
    const diff = angleDiff(desiredYaw, tank.yaw);

    let steer = clamp(diff * 2.35, -1, 1);

    // Look at the curvature a bit further ahead to pick a corner speed.
    const t1 = this.track.tangentAt(trackS + (lookahead + 18) / this.track.length, this.tmpT1);
    const t2 = this.track.tangentAt(trackS + (lookahead + 48) / this.track.length, this.tmpT2);
    const cos = clamp(t1.dot(t2), -1, 1);
    const curve = clamp((1 - cos) * 2.3, 0, 1);
    const targetSpeed = this.baseSpeed * (1 + this.rubber) * (1 - curve * 0.52);

    let throttle = speed < targetSpeed ? 1 : 0.18;
    if (Math.abs(diff) > 0.95) throttle = Math.min(throttle, 0.28);

    // Occasional mistakes, more often on easier difficulties.
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      steer = clamp(steer + this.mistakeSteer, -1, 1);
      throttle *= 0.82;
    } else {
      const chance = (1 - this.skill) * 0.22;
      if (this.rng() < chance * dt) {
        this.mistakeTimer = 0.35 + this.rng() * 0.4;
        this.mistakeSteer = (this.rng() < 0.5 ? -1 : 1) * (0.35 + this.rng() * 0.5);
      }
    }

    return { throttle, steer, boost: false };
  }

  get label(): string {
    return this.difficulty;
  }
}
