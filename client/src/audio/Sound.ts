const MUTE_KEY = "levi.muted";

/**
 * Everything you hear, synthesised (no audio files): a bed of wind, birds
 * now and then, and chimes for story moments. Browsers only allow sound
 * after a click or key press, so it wakes on the first input.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wind: GainNode | null = null;
  private muted = false;
  private birdIn = 4;
  private windTarget = 0.5;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      this.muted = false;
    }
    const wake = (): void => {
      this.start();
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? "1" : "0");
    } catch {
      // not remembered
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.1);
    return this.muted;
  }

  private start(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);

    // Wind: looping brown noise through a slowly breathing low-pass filter.
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(lp.frequency);
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    src.connect(lp).connect(this.wind).connect(this.master);
    src.start();
    lfo.start();
  }

  /** How windy it is here (0..1): high on the island, calmer on the ground. */
  setWind(level: number): void {
    this.windTarget = level;
  }

  update(dt: number, birds: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.wind) return;
    this.wind.gain.setTargetAtTime(0.09 * this.windTarget, ctx.currentTime, 1.5);
    if (!birds) return;
    this.birdIn -= dt;
    if (this.birdIn <= 0) {
      this.birdIn = 5 + Math.random() * 12;
      this.chirp();
    }
  }

  /** A short warble of two to four notes. */
  private chirp(): void {
    const ctx = this.ctx!;
    const base = 2200 + Math.random() * 1600;
    const notes = 2 + Math.floor(Math.random() * 3);
    let t = ctx.currentTime + 0.05;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      const f = base * (0.9 + Math.random() * 0.25);
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * (1.2 + Math.random() * 0.3), t + 0.08);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.11);
      o.connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + 0.13);
      t += 0.1 + Math.random() * 0.06;
    }
  }

  /** Soft bell notes (frequencies in Hz), spaced `gap` seconds apart. */
  private bells(freqs: readonly number[], gap: number, volume = 0.07): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    let t = ctx.currentTime + 0.02;
    for (const f of freqs) {
      for (const [mult, v] of [[1, 1], [2, 0.3], [3.01, 0.12]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f * mult;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(volume * v, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + 1.5);
      }
      t += gap;
    }
  }

  questStart(): void {
    this.bells([523.25, 783.99], 0.14);
  }

  questComplete(): void {
    this.bells([523.25, 659.25, 783.99, 1046.5], 0.12, 0.08);
  }

  levelUp(): void {
    this.bells([392, 523.25, 659.25, 783.99, 1046.5], 0.09, 0.07);
  }

  /** A low swell for arriving somewhere new. */
  arrive(): void {
    this.bells([261.63, 392], 0.35, 0.05);
  }
}
