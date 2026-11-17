import { HudRacerState, HudState } from '../engine/game';
import { colorToCss, formatTime } from '../engine/util';

interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const WEAPON_LABELS: Record<string, string> = {
  none: 'ЯДРО ∞',
  missile: 'РАКЕТА',
  mine: 'МИНА',
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly place: HTMLElement;
  private readonly placeTotal: HTMLElement;
  private readonly lap: HTMLElement;
  private readonly lapTotal: HTMLElement;
  private readonly time: HTMLElement;
  private readonly best: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly boost: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly message: HTMLElement;
  private readonly wrong: HTMLElement;
  private readonly minimap: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private track: Array<{ x: number; z: number }> = [];
  private bounds: MapBounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  private readonly cache = new Map<string, string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="panel hud-top-left">
        <div class="hud-place"><b id="hud-place">4</b><span id="hud-place-total">/4</span></div>
        <div class="hud-lap">КРУГ <b id="hud-lap">1</b>/<span id="hud-lap-total">3</span></div>
        <div class="hud-time" id="hud-time">0:00.000</div>
        <div class="hud-best">ЛУЧШИЙ <span id="hud-best">—</span></div>
      </div>
      <div class="panel hud-top-right">
        <canvas id="minimap" width="180" height="180"></canvas>
      </div>
      <div class="panel hud-bottom-left">
        <div class="hud-speed"><b id="hud-speed">0</b><span>КМ/Ч</span></div>
        <div class="hud-boost"><i id="hud-boost"></i></div>
        <div class="hud-boost-label">БУСТ · TAB</div>
      </div>
      <div class="panel hud-bottom-right">
        <div class="hud-weapon empty" id="hud-weapon">—</div>
        <div class="hud-weapon-hint">SPACE — ЯДРО · F — ОСОБОЕ</div>
      </div>
      <div class="hud-center" id="hud-message"></div>
      <div class="hud-wrong" id="hud-wrong" hidden>НЕ ТУДА!</div>
    `;
    parent.appendChild(this.root);

    this.place = this.take('hud-place');
    this.placeTotal = this.take('hud-place-total');
    this.lap = this.take('hud-lap');
    this.lapTotal = this.take('hud-lap-total');
    this.time = this.take('hud-time');
    this.best = this.take('hud-best');
    this.speed = this.take('hud-speed');
    this.boost = this.take('hud-boost');
    this.weapon = this.take('hud-weapon');
    this.message = this.take('hud-message');
    this.wrong = this.take('hud-wrong');

    this.minimap = this.root.querySelector('#minimap') as HTMLCanvasElement;
    const context = this.minimap.getContext('2d');
    if (!context) throw new Error('Minimap canvas is not available');
    this.ctx = context;
  }

  private take(id: string): HTMLElement {
    const element = this.root.querySelector(`#${id}`);
    if (!element) throw new Error(`HUD element #${id} not found`);
    return element as HTMLElement;
  }

  setTrack(points: Array<{ x: number; z: number }>): void {
    this.track = points;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  show(): void {
    this.root.hidden = false;
    this.cache.clear();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private setText(element: HTMLElement, value: string): void {
    const key = element.id;
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    element.textContent = value;
  }

  update(state: HudState): void {
    if (this.root.hidden) return;

    this.setText(this.place, String(state.place));
    this.setText(this.placeTotal, `/${state.total}`);
    this.setText(this.lap, String(state.lap));
    this.setText(this.lapTotal, String(state.laps));
    this.setText(this.time, formatTime(state.time));
    this.setText(this.best, formatTime(state.bestLap));
    this.setText(this.speed, String(state.speed));

    this.boost.style.width = `${Math.round(state.boost * 100)}%`;

    const weaponLabel = WEAPON_LABELS[state.weapon] ?? 'ЯДРО ∞';
    this.setText(this.weapon, weaponLabel);
    // The default cannon never runs dry, so the slot is never empty.
    this.weapon.classList.remove('empty');

    const countdown = state.countdown;
    if (countdown !== null) {
      this.setText(this.message, String(countdown));
      this.message.className = 'hud-center';
    } else {
      this.setText(this.message, state.message);
      this.message.className =
        state.messageKind === 'danger'
          ? 'hud-center small danger'
          : state.messageKind === 'small'
            ? 'hud-center small'
            : 'hud-center';
    }

    this.wrong.hidden = !state.wrongWay;
    this.drawMap(state.racers);
  }

  private drawMap(racers: HudRacerState[]): void {
    const ctx = this.ctx;
    const w = this.minimap.width;
    const h = this.minimap.height;
    const pad = 16;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(5, 11, 13, 0.9)';
    ctx.fillRect(0, 0, w, h);

    if (this.track.length > 1) {
      const b = this.bounds;
      const scale = Math.min(
        (w - pad * 2) / Math.max(1, b.maxX - b.minX),
        (h - pad * 2) / Math.max(1, b.maxZ - b.minZ),
      );
      const offsetX = (w - (b.maxX - b.minX) * scale) * 0.5 - b.minX * scale;
      const offsetY = (h - (b.maxZ - b.minZ) * scale) * 0.5 - b.minZ * scale;

      ctx.beginPath();
      this.track.forEach((point, index) => {
        const x = offsetX + point.x * scale;
        const y = offsetY + point.z * scale;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(170, 205, 195, 0.55)';
      ctx.lineWidth = 4;
      ctx.stroke();

      for (const racer of racers) {
        const x = offsetX + racer.x * scale;
        const y = offsetY + racer.z * scale;
        ctx.beginPath();
        ctx.fillStyle = colorToCss(racer.color);
        ctx.arc(x, y, racer.isPlayer ? 4.5 : 3.3, 0, Math.PI * 2);
        ctx.fill();
        if (racer.isPlayer) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  }
}
