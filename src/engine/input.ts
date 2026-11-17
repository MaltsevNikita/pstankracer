export interface Controls {
  throttle: number;
  steer: number;
  fire: boolean;
  special: boolean;
  boost: boolean;
  pause: boolean;
  camera: boolean;
}

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyF',
  'Tab',
  'Escape',
  'KeyC',
]);

const DEADZONE = 0.14;

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private prevButtons: boolean[] = [];
  private gamepadIndex: number | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    if (event.repeat) return;
    this.down.add(event.code);
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.down.clear();
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  clear(): void {
    this.down.clear();
    this.pressed.clear();
  }

  private findGamepad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.gamepadIndex !== null) {
      const pad = pads[this.gamepadIndex];
      if (pad) return pad;
      this.gamepadIndex = null;
    }
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (pad && pad.connected) {
        this.gamepadIndex = i;
        return pad;
      }
    }
    return null;
  }

  private buttonPressed(pad: Gamepad, index: number): boolean {
    const button = pad.buttons[index];
    return !!button && button.pressed;
  }

  poll(): Controls {
    let throttle = 0;
    let steer = 0;

    if (this.down.has('KeyW') || this.down.has('ArrowUp')) throttle += 1;
    if (this.down.has('KeyS') || this.down.has('ArrowDown')) throttle -= 1;
    if (this.down.has('KeyA') || this.down.has('ArrowLeft')) steer += 1;
    if (this.down.has('KeyD') || this.down.has('ArrowRight')) steer -= 1;

    let fire = this.pressed.has('Space');
    let special = this.pressed.has('KeyF');
    let pause = this.pressed.has('Escape');
    let camera = this.pressed.has('KeyC');
    let boost = this.down.has('Tab');

    const pad = this.findGamepad();
    if (pad) {
      const axisX = pad.axes[0] ?? 0;
      const axisY = pad.axes[1] ?? 0;
      if (steer === 0 && Math.abs(axisX) > DEADZONE) steer = -axisX;
      if (this.buttonPressed(pad, 14)) steer = 1;
      if (this.buttonPressed(pad, 15)) steer = -1;

      if (throttle === 0) {
        const stick = Math.abs(axisY) > DEADZONE ? -axisY : 0;
        const rt = pad.buttons[7]?.value ?? 0;
        const lt = pad.buttons[6]?.value ?? 0;
        throttle = Math.max(-1, Math.min(1, stick + rt - lt));
      }

      if (this.buttonPressed(pad, 1) || this.buttonPressed(pad, 4)) boost = true;

      const fireNow = this.buttonPressed(pad, 0) || this.buttonPressed(pad, 5);
      const specialNow = this.buttonPressed(pad, 2);
      const pauseNow = this.buttonPressed(pad, 9);
      const cameraNow = this.buttonPressed(pad, 3);

      const firePrev = this.prevButtons[0] || this.prevButtons[5];
      const specialPrev = this.prevButtons[2];
      const pausePrev = this.prevButtons[9];
      const cameraPrev = this.prevButtons[3];

      if (fireNow && !firePrev) fire = true;
      if (specialNow && !specialPrev) special = true;
      if (pauseNow && !pausePrev) pause = true;
      if (cameraNow && !cameraPrev) camera = true;

      this.prevButtons = pad.buttons.map((b) => b.pressed);
    }

    this.pressed.clear();

    return {
      throttle: Math.max(-1, Math.min(1, throttle)),
      steer: Math.max(-1, Math.min(1, steer)),
      fire,
      special,
      boost,
      pause,
      camera,
    };
  }
}
