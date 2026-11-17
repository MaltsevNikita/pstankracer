export class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineOscillators: OscillatorNode[] = [];
  private noiseBuffer: AudioBuffer | null = null;
  private volume = 0.7;
  private muted = false;
  private engineRunning = false;

  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    const length = Math.floor(ctx.sampleRate * 1.2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 320;
    this.engineFilter.Q.value = 3;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 44 + i * 1.5;
      osc.detune.value = i === 0 ? -7 : 6;
      osc.connect(this.engineFilter);
      osc.start();
      this.engineOscillators.push(osc);
    }
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  startEngine(): void {
    if (!this.ctx || !this.engineGain) return;
    this.engineRunning = true;
    this.engineGain.gain.setTargetAtTime(0.0275, this.ctx.currentTime, 0.2);
  }

  stopEngine(): void {
    if (!this.ctx || !this.engineGain) return;
    this.engineRunning = false;
    this.engineGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.15);
  }

  updateEngine(ratio: number, throttle: number): void {
    if (!this.ctx || !this.engineRunning) return;
    const now = this.ctx.currentTime;
    const freq = 40 + Math.min(1, Math.abs(ratio)) * 92 + Math.max(0, throttle) * 6;
    for (let i = 0; i < this.engineOscillators.length; i++) {
      this.engineOscillators[i].frequency.setTargetAtTime(freq * (i === 0 ? 1 : 1.008), now, 0.06);
    }
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(
        260 + Math.min(1, Math.abs(ratio)) * 1150 + Math.max(0, throttle) * 240,
        now,
        0.08,
      );
    }
    if (this.engineGain) {
      this.engineGain.gain.setTargetAtTime(0.025 + Math.min(1, Math.abs(ratio)) * 0.015, now, 0.12);
    }
  }

  private noiseBurst(
    duration: number,
    gain: number,
    startFreq: number,
    endFreq: number,
    type: BiquadFilterType = 'lowpass',
  ): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(startFreq, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), now + duration);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  private tone(
    frequency: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'square',
    slideTo?: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(envelope);
    envelope.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  shot(): void {
    this.noiseBurst(0.18, 0.5, 2400, 220);
    this.tone(150, 0.16, 0.22, 'square', 46);
  }

  impact(): void {
    this.noiseBurst(0.12, 0.28, 1900, 420);
    this.tone(230, 0.11, 0.13, 'triangle', 90);
  }

  explosion(): void {
    this.noiseBurst(0.6, 0.75, 1600, 60);
    this.tone(88, 0.45, 0.3, 'sine', 28);
  }

  pickup(): void {
    this.tone(660, 0.09, 0.16, 'square');
    this.tone(990, 0.14, 0.14, 'square', undefined, 0.08);
  }

  drop(): void {
    this.noiseBurst(0.08, 0.18, 700, 180);
  }

  crash(): void {
    this.noiseBurst(0.22, 0.35, 900, 90);
  }

  boost(): void {
    this.noiseBurst(0.4, 0.25, 300, 2600, 'bandpass');
  }

  beep(high = false): void {
    this.tone(high ? 880 : 440, high ? 0.32 : 0.12, 0.18, 'square');
  }

  finish(): void {
    this.tone(523, 0.16, 0.15, 'square');
    this.tone(659, 0.16, 0.15, 'square', undefined, 0.13);
    this.tone(784, 0.34, 0.17, 'square', undefined, 0.26);
  }

  wheelSlip(): void {
    this.noiseBurst(0.18, 0.12, 900, 400, 'bandpass');
  }

  dispose(): void {
    for (const osc of this.engineOscillators) {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
    }
    this.engineOscillators = [];
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.master = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.noiseBuffer = null;
  }
}
