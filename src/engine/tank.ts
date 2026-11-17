import * as THREE from 'three';
import { Ps1Materials } from './ps1';
import { clamp, damp, moveToward } from './util';

export interface TankInput {
  throttle: number;
  steer: number;
  boost: boolean;
}

export interface TankOptions {
  color: number;
  isPlayer: boolean;
}

const MAX_SPEED = 57;
const BOOST_SPEED = 84;
const REVERSE_SPEED = 18;
const ACCEL = 31;
const BRAKE = 62;
const COAST = 8.5;
/** Seconds of continuous manual boost from a full charge, and recharge time. */
const NITRO_DRAIN = 0.5;
const NITRO_RECHARGE = 0.2;

interface TankGeometry {
  track: THREE.BoxGeometry;
  wheel: THREE.CylinderGeometry;
  hull: THREE.BoxGeometry;
  glacis: THREE.BoxGeometry;
  stripe: THREE.BoxGeometry;
  turret: THREE.CylinderGeometry;
  mantlet: THREE.BoxGeometry;
  barrel: THREE.CylinderGeometry;
  muzzle: THREE.BoxGeometry;
  hatch: THREE.CylinderGeometry;
  antenna: THREE.BoxGeometry;
  shadow: THREE.CircleGeometry;
}

let sharedGeometry: TankGeometry | null = null;

function getGeometry(): TankGeometry {
  if (!sharedGeometry) {
    sharedGeometry = {
      track: new THREE.BoxGeometry(0.96, 1.16, 4.75),
      wheel: new THREE.CylinderGeometry(0.43, 0.43, 1.02, 8),
      hull: new THREE.BoxGeometry(2.5, 0.86, 4.25),
      glacis: new THREE.BoxGeometry(2.32, 0.5, 1.15),
      stripe: new THREE.BoxGeometry(0.07, 0.3, 2.9),
      turret: new THREE.CylinderGeometry(0.98, 1.12, 0.58, 8),
      mantlet: new THREE.BoxGeometry(0.94, 0.46, 0.55),
      barrel: new THREE.CylinderGeometry(0.11, 0.14, 2.5, 6),
      muzzle: new THREE.BoxGeometry(0.28, 0.28, 0.42),
      hatch: new THREE.CylinderGeometry(0.32, 0.32, 0.16, 8),
      antenna: new THREE.BoxGeometry(0.035, 1.15, 0.035),
      shadow: new THREE.CircleGeometry(2.75, 14),
    };
  }
  return sharedGeometry;
}

const BARREL_Z = 2.02;

export class Tank {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly turret = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly radius = 2.3;

  yaw = 0;
  speed = 0;
  vy = 0;
  airborne = false;
  boostTimer = 0;
  /** Manual boost charge, 0..1. */
  nitro = 1;
  spinTimer = 0;
  spinDir = 1;
  padCooldown = 0;

  private readonly shadow: THREE.Mesh;
  private readonly barrel: THREE.Mesh;
  private readonly wheels: THREE.Mesh[] = [];
  private turretTarget = 0;
  private turretCurrent = 0;
  private recoil = 0;
  private steerVisual = 0;
  private throttleVisual = 0;
  private wheelSpin = 0;

  constructor(materials: Ps1Materials, options: TankOptions) {
    const geo = getGeometry();
    const dark = materials.lambert({ color: 0x24251f });
    const metal = materials.lambert({ color: 0x55594d });
    const hull = materials.lambert({ color: options.color });
    const accent = materials.lambert({ color: options.isPlayer ? 0xffd23f : 0xd8d2b4 });

    this.root.add(this.body);

    for (const side of [-1, 1]) {
      const track = new THREE.Mesh(geo.track, dark);
      track.position.set(side * 1.32, 0.63, 0);
      this.body.add(track);

      for (let i = 0; i < 4; i++) {
        const wheel = new THREE.Mesh(geo.wheel, metal);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * 1.34, 0.56, -1.6 + i * 1.06);
        this.body.add(wheel);
        this.wheels.push(wheel);
      }

      const stripe = new THREE.Mesh(geo.stripe, accent);
      stripe.position.set(side * 1.27, 1.18, 0);
      this.body.add(stripe);
    }

    const hullMesh = new THREE.Mesh(geo.hull, hull);
    hullMesh.position.set(0, 1.05, 0);
    this.body.add(hullMesh);

    const glacis = new THREE.Mesh(geo.glacis, metal);
    glacis.position.set(0, 1.18, 1.72);
    glacis.rotation.x = -0.34;
    this.body.add(glacis);

    const engine = new THREE.Mesh(geo.hull, dark);
    engine.scale.set(0.82, 0.55, 0.42);
    engine.position.set(0, 1.5, -1.5);
    this.body.add(engine);

    this.turret.position.set(0, 1.56, 0.05);
    this.body.add(this.turret);

    const turretMesh = new THREE.Mesh(geo.turret, hull);
    turretMesh.position.y = 0.29;
    this.turret.add(turretMesh);

    const mantlet = new THREE.Mesh(geo.mantlet, metal);
    mantlet.position.set(0, 0.34, 0.86);
    this.turret.add(mantlet);

    this.barrel = new THREE.Mesh(geo.barrel, metal);
    this.barrel.rotation.x = Math.PI / 2;
    this.barrel.position.set(0, 0.36, BARREL_Z);
    this.turret.add(this.barrel);

    const muzzle = new THREE.Mesh(geo.muzzle, dark);
    muzzle.position.set(0, 0.36, BARREL_Z + 1.2);
    this.turret.add(muzzle);

    const hatch = new THREE.Mesh(geo.hatch, accent);
    hatch.position.set(-0.34, 0.62, -0.18);
    this.turret.add(hatch);

    const antenna = new THREE.Mesh(geo.antenna, dark);
    antenna.position.set(0.58, 0.95, -0.55);
    antenna.rotation.z = -0.09;
    this.turret.add(antenna);

    const shadowMaterial = materials.basic({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(geo.shadow, shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.08;
    this.shadow.renderOrder = 1;
    this.root.add(this.shadow);

    this.root.matrixAutoUpdate = true;
  }

  placeAt(x: number, y: number, z: number, yaw: number): void {
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.vy = 0;
    this.airborne = false;
    this.boostTimer = 0;
    this.nitro = 1;
    this.spinTimer = 0;
    this.padCooldown = 0;
    this.turretCurrent = 0;
    this.root.position.copy(this.pos);
    this.root.rotation.y = yaw;
  }

  step(dt: number, input: TankInput): void {
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.padCooldown = Math.max(0, this.padCooldown - dt);

    // Manual boost on its own recharging charge, independent of track pads.
    if (input.boost && this.spinTimer <= 0 && this.nitro > 0.01) {
      this.nitro = Math.max(0, this.nitro - dt * NITRO_DRAIN);
      this.boostTimer = Math.max(this.boostTimer, 0.14);
    } else {
      this.nitro = Math.min(1, this.nitro + dt * NITRO_RECHARGE);
    }

    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    this.forward.set(fwdX, 0, fwdZ);

    const fwdSpeed = this.vel.x * fwdX + this.vel.z * fwdZ;
    const lateral = this.vel.x * rightX + this.vel.z * rightZ;

    const steer = this.spinTimer > 0 ? 0 : clamp(input.steer, -1, 1);
    const absSpeed = Math.abs(fwdSpeed);
    const steerRate = 2.05 / (1 + absSpeed * 0.028);
    const pivot = absSpeed < 1.6 ? 0.72 : 1;
    const reverseSign = fwdSpeed < -0.6 ? -1 : 1;
    this.yaw += steer * steerRate * dt * pivot * reverseSign;

    let targetSpeed = 0;
    let rate = COAST;
    if (this.spinTimer <= 0) {
      if (input.throttle > 0.02) {
        targetSpeed = MAX_SPEED * clamp(input.throttle, 0, 1);
        rate = ACCEL;
      } else if (input.throttle < -0.02) {
        if (fwdSpeed > 1) {
          targetSpeed = 0;
          rate = BRAKE;
        } else {
          targetSpeed = REVERSE_SPEED * clamp(input.throttle, -1, 0);
          rate = ACCEL * 0.72;
        }
      }
    } else {
      this.spinTimer -= dt;
      this.yaw += this.spinDir * 7.4 * dt * (0.35 + Math.max(0, this.spinTimer));
      targetSpeed = fwdSpeed * 0.55;
      rate = BRAKE;
    }

    if (this.boostTimer > 0) {
      targetSpeed = Math.max(targetSpeed, BOOST_SPEED);
      rate = 50;
    }

    const newSpeed = moveToward(fwdSpeed, targetSpeed, rate * dt);
    const grip = Math.exp(-7.2 * dt);
    this.vel.x = fwdX * newSpeed + rightX * lateral * grip;
    this.vel.z = fwdZ * newSpeed + rightZ * lateral * grip;
    this.speed = newSpeed;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    this.steerVisual = damp(this.steerVisual, steer, 8, dt);
    this.throttleVisual = damp(this.throttleVisual, input.throttle, 8, dt);
  }

  syncSpeed(): void {
    this.speed = this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
  }

  applyHit(spinDir: number): void {
    this.spinTimer = 1.15;
    this.spinDir = spinDir;
    this.vel.multiplyScalar(0.4);
    this.recoil = 0.6;
  }

  aimAt(x: number, z: number): void {
    const world = Math.atan2(x - this.pos.x, z - this.pos.z);
    let diff = world - this.yaw;
    diff = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.turretTarget = clamp(diff, -1.35, 1.35);
  }

  clearAim(): void {
    this.turretTarget = 0;
  }

  muzzleWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const local = new THREE.Vector3(0, 0.36, BARREL_Z + 1.35);
    this.turret.updateWorldMatrix(true, false);
    return out.copy(local).applyMatrix4(this.turret.matrixWorld);
  }

  forwardPoint(distance: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.forward).multiplyScalar(distance).add(this.pos);
  }

  fireVisual(): void {
    this.recoil = 1;
  }

  syncVisual(dt: number, groundY: number): void {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;

    const speedFactor = clamp(this.speed / 60, -1, 1);
    this.body.rotation.z = damp(this.body.rotation.z, this.steerVisual * speedFactor * 0.075, 7, dt);
    const airPitch = this.airborne ? clamp(-this.vy * 0.016, -0.14, 0.14) : 0;
    this.body.rotation.x = damp(
      this.body.rotation.x,
      -this.throttleVisual * 0.022 + airPitch,
      6,
      dt,
    );

    this.turretCurrent = damp(this.turretCurrent, this.turretTarget, 5.5, dt);
    this.turret.rotation.y = this.turretCurrent;

    this.recoil = damp(this.recoil, 0, 11, dt);
    this.barrel.position.z = BARREL_Z - this.recoil * 0.3;

    this.wheelSpin += this.speed * dt * 1.7;
    for (const wheel of this.wheels) {
      wheel.rotation.x = this.wheelSpin;
    }

    const height = Math.max(0, this.pos.y - groundY);
    this.shadow.position.y = groundY - this.pos.y + 0.07;
    const shadowScale = clamp(1 - height * 0.05, 0.55, 1);
    this.shadow.scale.setScalar(shadowScale);
  }
}
