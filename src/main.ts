import './style.css';
import { AudioSys } from './engine/audio';
import { Game, RaceResult } from './engine/game';
import { Hud } from './ui/hud';
import {
  loadRecords,
  loadSettings,
  Records,
  saveRecords,
  Settings,
  Ui,
} from './ui/ui';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui') as HTMLElement | null;

if (!canvas || !uiRoot) {
  throw new Error('Game canvas or UI root is missing');
}

const audio = new AudioSys();
let settings: Settings = loadSettings();
let records: Records = loadRecords();

const hud = new Hud(uiRoot);
const ui = new Ui(uiRoot, settings, records, {
  onStart: () => startRace(),
  onResume: () => resumeRace(),
  onRestart: () => startRace(),
  onQuit: () => quitToMenu(),
  onSettingsChange: (next) => {
    settings = { ...next };
    audio.setVolume(settings.volume);
    audio.setMuted(settings.muted);
  },
});

let game: Game | null = null;
let raceActive = false;

audio.setVolume(settings.volume);
audio.setMuted(settings.muted);

function startRace(): void {
  audio.init();
  audio.resume();
  audio.setVolume(settings.volume);
  audio.setMuted(settings.muted);

  ui.hideAll();
  hud.show();

  game?.dispose();
  game = new Game(canvas as HTMLCanvasElement, audio, settings, {
    onHud: (state) => hud.update(state),
    onTrack: (points) => hud.setTrack(points),
    onFinish: (result) => onRaceFinish(result),
    onPause: () => {
      ui.showPause();
    },
  });
  raceActive = true;
  game.start();
}

function onRaceFinish(result: RaceResult): void {
  raceActive = false;

  let lapRecord = false;
  let raceRecord = false;
  const next: Records = {
    bestLap: records.bestLap,
    bestRaceByLaps: { ...records.bestRaceByLaps },
  };

  if (
    result.bestLap !== null &&
    (next.bestLap === null || result.bestLap < next.bestLap)
  ) {
    next.bestLap = result.bestLap;
    lapRecord = true;
  }
  // Race distance depends on the lap setting, so records are kept per lap count.
  const lapKey = String(result.laps);
  const previousBest = next.bestRaceByLaps[lapKey];
  if (
    result.playerTime > 0 &&
    (previousBest === undefined || result.playerTime < previousBest)
  ) {
    next.bestRaceByLaps[lapKey] = result.playerTime;
    raceRecord = true;
  }

  records = next;
  saveRecords(records);
  ui.updateRecords(records);

  hud.hide();
  ui.showResults(result, records, lapRecord, raceRecord);
}

function resumeRace(): void {
  ui.hidePause();
  game?.setPaused(false);
}

function quitToMenu(): void {
  raceActive = false;
  game?.dispose();
  game = null;
  hud.hide();
  ui.hideAll();
  ui.showMenu();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && raceActive && game) {
    ui.showPause();
    game.setPaused(true);
  }
});

window.addEventListener('beforeunload', () => {
  game?.dispose();
  audio.dispose();
});

ui.showMenu();
