import { Difficulty } from '../engine/ai';
import { CameraMode, DEFAULT_LAPS, MAX_LAPS, MIN_LAPS, RaceResult } from '../engine/game';
import { formatTime } from '../engine/util';

export interface Settings {
  difficulty: Difficulty;
  camera: CameraMode;
  volume: number;
  muted: boolean;
  laps: number;
}

export interface Records {
  bestLap: number | null;
  /** Best finish time per lap count (the distance changes the result). */
  bestRaceByLaps: Record<string, number>;
}

/** Lap counts offered in the settings menu; records keep them apart. */
const LAP_OPTIONS = [1, 3, 5];

function lapWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'КРУГ';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'КРУГА';
  return 'КРУГОВ';
}

function normalizeLaps(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const laps = Math.round(value);
  if (laps < MIN_LAPS || laps > MAX_LAPS) return null;
  return laps;
}

export interface UiCallbacks {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onSettingsChange(settings: Settings): void;
}

const SETTINGS_KEY = 'ironlap.settings.v1';
const RECORDS_KEY = 'ironlap.records.v1';

const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  camera: 'chase',
  volume: 0.7,
  muted: false,
  laps: DEFAULT_LAPS,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      difficulty:
        parsed.difficulty === 'easy' || parsed.difficulty === 'hard'
          ? parsed.difficulty
          : 'normal',
      camera: parsed.camera === 'hood' ? 'hood' : 'chase',
      volume: typeof parsed.volume === 'number' ? Math.max(0, Math.min(1, parsed.volume)) : 0.7,
      muted: !!parsed.muted,
      laps: normalizeLaps(parsed.laps) ?? DEFAULT_LAPS,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private mode; the game still works.
  }
}

export function loadRecords(): Records {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return { bestLap: null, bestRaceByLaps: {} };
    const parsed = JSON.parse(raw) as {
      bestLap?: unknown;
      bestRace?: unknown;
      bestRaceByLaps?: unknown;
    };

    const bestRaceByLaps: Record<string, number> = {};
    if (parsed.bestRaceByLaps && typeof parsed.bestRaceByLaps === 'object') {
      for (const [key, value] of Object.entries(parsed.bestRaceByLaps)) {
        const laps = normalizeLaps(Number(key));
        if (laps !== null && typeof value === 'number' && Number.isFinite(value) && value > 0) {
          bestRaceByLaps[String(laps)] = value;
        }
      }
    } else if (typeof parsed.bestRace === 'number' && parsed.bestRace > 0) {
      // Records from before the lap setting existed were always 3-lap races.
      bestRaceByLaps[String(DEFAULT_LAPS)] = parsed.bestRace;
    }

    return {
      bestLap: typeof parsed.bestLap === 'number' ? parsed.bestLap : null,
      bestRaceByLaps,
    };
  } catch {
    return { bestLap: null, bestRaceByLaps: {} };
  }
}

export function saveRecords(records: Records): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // Ignore storage failures.
  }
}

export class Ui {
  private readonly settings: Settings;
  private records: Records;
  private readonly callbacks: UiCallbacks;
  private readonly screens: Record<string, HTMLElement> = {};
  private readonly root: HTMLElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly menuRecords: HTMLElement;
  private readonly menuLaps: HTMLElement;
  private readonly resultBody: HTMLElement;
  private readonly resultHero: HTMLElement;
  private readonly resultTrack: HTMLElement;
  private readonly recordNote: HTMLElement;

  constructor(
    root: HTMLElement,
    settings: Settings,
    records: Records,
    callbacks: UiCallbacks,
  ) {
    this.settings = { ...settings };
    this.records = { ...records };
    this.callbacks = callbacks;
    this.root = root;

    this.screens.menu = this.makeScreen(
      'menu',
      `
      <div class="menu-card">
        <h1 class="logo">IRON<span>LAP</span></h1>
        <div class="tagline">ТАКТИЧЕСКИЕ ГОНКИ НА БРОНЕ</div>
        <div class="badge-row">
          <span class="badge">PS1 STYLE</span>
          <span class="badge" id="menu-laps">3 КРУГА</span>
          <span class="badge">3 СОПЕРНИКА</span>
          <span class="badge">РАКЕТЫ И МИНЫ</span>
        </div>
        <div class="records" id="menu-records"></div>
        <div class="menu-actions">
          <button class="btn" data-action="start">ЗАЕЗД</button>
          <button class="btn small" data-action="settings">НАСТРОЙКИ</button>
          <button class="btn small" data-action="controls">УПРАВЛЕНИЕ</button>
        </div>
      </div>
      <div class="menu-footer">ENTER — СТАРТ · VITE + THREE.JS · 640×360</div>
      `,
    );

    this.screens.settings = this.makeScreen(
      'settings',
      `
      <div class="dialog settings-panel">
        <h2>НАСТРОЙКИ</h2>
        <div class="sub">ПОДГОНКА ПОД СЕБЯ</div>
        <div class="setting">
          <label>СЛОЖНОСТЬ</label>
          <div class="seg" data-group="difficulty">
            <button data-action="difficulty" data-value="easy">ЛЕГКО</button>
            <button data-action="difficulty" data-value="normal">НОРМА</button>
            <button data-action="difficulty" data-value="hard">ЖЁСТКО</button>
          </div>
        </div>
        <div class="setting">
          <label>КРУГИ</label>
          <div class="seg" data-group="laps">
            ${LAP_OPTIONS.map(
              (laps) =>
                `<button data-action="laps" data-value="${laps}">${laps} ${lapWord(laps)}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="setting">
          <label>КАМЕРА</label>
          <div class="seg" data-group="camera">
            <button data-action="camera" data-value="chase">ПОГОНЯ</button>
            <button data-action="camera" data-value="hood">КАПОТ</button>
          </div>
        </div>
        <div class="setting">
          <label>ГРОМКОСТЬ</label>
          <input id="volume" type="range" min="0" max="100" step="1" value="70" />
        </div>
        <div class="setting">
          <label>ЗВУК</label>
          <div class="seg" data-group="muted">
            <button data-action="sound" data-value="on">ВКЛ</button>
            <button data-action="sound" data-value="off">ВЫКЛ</button>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="btn small" data-action="back">НАЗАД</button>
        </div>
      </div>
      `,
    );

    this.screens.controls = this.makeScreen(
      'controls',
      `
      <div class="dialog controls-panel">
        <h2>УПРАВЛЕНИЕ</h2>
        <div class="sub">КЛАВИАТУРА И ГЕЙМПАД</div>
        <div class="controls-list">
          <div><span>ГАЗ</span><b>W / ↑</b></div>
          <div><span>ТОРМОЗ / НАЗАД</span><b>S / ↓</b></div>
          <div><span>ПОВОРОТ</span><b>A D / ← →</b></div>
          <div><span>ОГОНЬ (ЯДРО)</span><b>SPACE / A</b></div>
          <div><span>ОСОБОЕ ОРУЖИЕ</span><b>F / X</b></div>
          <div><span>УСКОРЕНИЕ</span><b>TAB / B</b></div>
          <div><span>КАМЕРА</span><b>C / Y</b></div>
          <div><span>ПАУЗА</span><b>ESC / START</b></div>
          <div><span>ГЕЙМПАД: ГАЗ</span><b>RT / СТИК</b></div>
          <div><span>ГЕЙМПАД: ТОРМОЗ</span><b>LT</b></div>
        </div>
        <p class="hint">SPACE СТРЕЛЯЕТ ОРАНЖЕВЫМ ЯДРОМ БЕЗ ОГРАНИЧЕНИЯ ЗАРЯДОВ. ПОДОБРАННЫЕ РАКЕТА ИЛИ МИНА — НА F. TAB РАСХОДУЕТ НИТРО.</p>
        <div class="dialog-actions">
          <button class="btn small" data-action="back">НАЗАД</button>
        </div>
      </div>
      `,
    );

    this.screens.pause = this.makeScreen(
      'pause',
      `
      <div class="dialog">
        <h2>ПАУЗА</h2>
        <div class="sub">ЗАЕЗД ПРИОСТАНОВЛЕН</div>
        <div class="dialog-actions">
          <button class="btn" data-action="resume">ПРОДОЛЖИТЬ</button>
          <button class="btn small" data-action="restart">ЗАНОВО</button>
          <button class="btn small danger" data-action="quit">В МЕНЮ</button>
        </div>
      </div>
      `,
    );

    this.screens.results = this.makeScreen(
      'results',
      `
      <div class="dialog">
        <h2>ЗАЕЗД ЗАВЕРШЁН</h2>
        <div class="sub" id="result-track">ЗАВОДСКОЙ КРУГ</div>
        <div class="result-hero" id="result-hero"></div>
        <table class="result-table">
          <thead>
            <tr><th>#</th><th>ПИЛОТ</th><th>ВРЕМЯ</th><th>ЛУЧШИЙ КРУГ</th></tr>
          </thead>
          <tbody id="result-body"></tbody>
        </table>
        <div class="record-note" id="record-note"></div>
        <div class="dialog-actions">
          <button class="btn" data-action="restart">ЕЩЁ ЗАЕЗД</button>
          <button class="btn small" data-action="quit">В МЕНЮ</button>
        </div>
      </div>
      `,
    );

    this.menuRecords = this.screens.menu.querySelector('#menu-records') as HTMLElement;
    this.menuLaps = this.screens.menu.querySelector('#menu-laps') as HTMLElement;
    this.resultBody = this.screens.results.querySelector('#result-body') as HTMLElement;
    this.resultHero = this.screens.results.querySelector('#result-hero') as HTMLElement;
    this.resultTrack = this.screens.results.querySelector('#result-track') as HTMLElement;
    this.recordNote = this.screens.results.querySelector('#record-note') as HTMLElement;
    this.volumeInput = this.screens.settings.querySelector('#volume') as HTMLInputElement;

    this.volumeInput.value = String(Math.round(this.settings.volume * 100));
    this.volumeInput.addEventListener('input', () => {
      this.settings.volume = Number(this.volumeInput.value) / 100;
      this.applySettings();
    });

    root.addEventListener('click', (event) => this.handleClick(event));
    document.addEventListener('keydown', (event) => this.handleKey(event));

    this.updateRecords(this.records);
    this.syncSettingsUi();
  }

  private makeScreen(name: string, html: string): HTMLElement {
    const element = document.createElement('div');
    element.className = `screen screen-${name}`;
    element.hidden = true;
    element.innerHTML = html;
    this.screens[name] = element;
    this.root.appendChild(element);
    return element;
  }

  private handleClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const value = target.dataset.value;

    switch (action) {
      case 'start':
        this.callbacks.onStart();
        break;
      case 'settings':
        this.showScreen('settings');
        break;
      case 'controls':
        this.showScreen('controls');
        break;
      case 'back':
        this.showScreen('menu');
        break;
      case 'resume':
        this.callbacks.onResume();
        break;
      case 'restart':
        this.callbacks.onRestart();
        break;
      case 'quit':
        this.callbacks.onQuit();
        break;
      case 'difficulty':
        if (value === 'easy' || value === 'normal' || value === 'hard') {
          this.settings.difficulty = value;
          this.applySettings();
        }
        break;
      case 'laps': {
        const laps = normalizeLaps(Number(value));
        if (laps !== null) {
          this.settings.laps = laps;
          this.applySettings();
        }
        break;
      }
      case 'camera':
        if (value === 'chase' || value === 'hood') {
          this.settings.camera = value;
          this.applySettings();
        }
        break;
      case 'sound':
        this.settings.muted = value === 'off';
        this.applySettings();
        break;
      default:
        break;
    }
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.code === 'Enter') {
      if (!this.screens.menu.hidden) {
        event.preventDefault();
        this.callbacks.onStart();
      } else if (!this.screens.pause.hidden) {
        event.preventDefault();
        this.callbacks.onResume();
      }
      return;
    }
    if (event.code === 'Escape' && !this.screens.pause.hidden) {
      event.preventDefault();
      this.callbacks.onResume();
    }
  }

  private applySettings(): void {
    this.syncSettingsUi();
    saveSettings(this.settings);
    this.callbacks.onSettingsChange({ ...this.settings });
  }

  private syncSettingsUi(): void {
    const settingsScreen = this.screens.settings;
    const mark = (group: string, selected: string): void => {
      settingsScreen.querySelectorAll<HTMLElement>(`[data-group="${group}"] [data-value]`).forEach((button) => {
        button.classList.toggle('active', button.dataset.value === selected);
      });
    };
    mark('difficulty', this.settings.difficulty);
    mark('laps', String(this.settings.laps));
    mark('camera', this.settings.camera);
    mark('muted', this.settings.muted ? 'off' : 'on');
    this.volumeInput.value = String(Math.round(this.settings.volume * 100));
    this.renderRecords();
  }

  private showScreen(name: string): void {
    for (const [key, element] of Object.entries(this.screens)) {
      element.hidden = key !== name;
    }
  }

  hideAll(): void {
    for (const element of Object.values(this.screens)) element.hidden = true;
  }

  showMenu(): void {
    this.showScreen('menu');
  }

  hideMenu(): void {
    this.screens.menu.hidden = true;
  }

  showPause(): void {
    this.showScreen('pause');
  }

  hidePause(): void {
    this.screens.pause.hidden = true;
  }

  showResults(
    result: RaceResult,
    records: Records,
    lapRecord: boolean,
    raceRecord: boolean,
  ): void {
    this.records = { ...records };
    this.updateRecords(this.records);

    this.resultTrack.textContent = `${result.trackName} · ${result.laps} ${lapWord(result.laps)}`;
    this.resultHero.innerHTML = `
      <div class="place"><span>МЕСТО</span><b>${result.playerPlace}</b></div>
      <div><span>ВРЕМЯ</span><b>${formatTime(result.playerTime)}</b></div>
      <div><span>ЛУЧШИЙ КРУГ</span><b>${formatTime(result.bestLap)}</b></div>
    `;

    this.resultBody.innerHTML = result.racers
      .map(
        (racer) => `
        <tr class="${racer.isPlayer ? 'is-player' : ''}">
          <td>${racer.place}</td>
          <td>${racer.name}</td>
          <td>${racer.time != null ? formatTime(racer.time) : `${racer.lapsDone}/${result.laps}`}</td>
          <td>${formatTime(racer.bestLap)}</td>
        </tr>`,
      )
      .join('');

    const notes: string[] = [];
    if (lapRecord) notes.push('НОВЫЙ РЕКОРД КРУГА');
    if (raceRecord) notes.push('НОВЫЙ РЕКОРД ЗАЕЗДА');
    this.recordNote.textContent = notes.join(' · ');

    this.showScreen('results');
  }

  hideResults(): void {
    this.screens.results.hidden = true;
  }

  updateRecords(records: Records): void {
    this.records = {
      bestLap: records.bestLap,
      bestRaceByLaps: { ...records.bestRaceByLaps },
    };
    this.renderRecords();
  }

  private renderRecords(): void {
    const laps = this.settings.laps;
    const bestRace = this.records.bestRaceByLaps[String(laps)] ?? null;
    this.menuLaps.textContent = `${laps} ${lapWord(laps)}`;
    this.menuRecords.innerHTML = `
      <span>ЛУЧШИЙ КРУГ <b>${formatTime(this.records.bestLap)}</b></span>
      <span>ЗАЕЗД ${laps} ${lapWord(laps)} <b>${formatTime(bestRace)}</b></span>
    `;
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  isMenuVisible(): boolean {
    return !this.screens.menu.hidden;
  }
}
