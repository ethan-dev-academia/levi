const MUTE_KEY = "levi.muted";

/** MIDI note number → Hz. */
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

// Note names (MIDI), so the phrases below read like music.
const N = {
  C2: 36, D2: 38, E2: 40, F2: 41, G2: 43, A2: 45, Bb2: 46, B2: 47,
  C3: 48, Cs3: 49, D3: 50, E3: 52, F3: 53, Fs3: 54, G3: 55, A3: 57, Bb3: 58, B3: 59,
  C4: 60, Cs4: 61, D4: 62, E4: 64, F4: 65, Fs4: 66, G4: 67, A4: 69, B4: 71,
  C5: 72, Cs5: 73, D5: 74, E5: 76, Fs5: 78, G5: 79, A5: 81, B5: 83, D6: 86,
} as const;

/** One note of a phrase: when (seconds from now), which key, how hard (0..1). */
type Note = [at: number, midi: number, vel: number];

/** Wandering notes for the ambient piano: D major pentatonic, middle of the keyboard. */
const NOODLE = [N.D4, N.E4, N.Fs4, N.A4, N.B4, N.D5, N.E5, N.Fs5, N.A5];

/**
 * Everything you hear, synthesised (no audio files): a soft bed of wind, a
 * piano that plays now and then, and piano phrases for story moments.
 *
 * Quests share one motif (A–D–E): it hangs on the open second when a quest
 * begins and lands home on F♯ over a D chord when it's done. Other moments
 * get open, unresolved chords. Browsers only allow sound after a click or
 * key press, so it wakes on the first input.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Piano → (dry + reverb) → master. */
  private piano: GainNode | null = null;
  private wind: GainNode | null = null;
  private muted = false;
  private noodleIn = 12;
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
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.1);
    return this.muted;
  }

  private start(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(comp);

    // The room: a generated hall impulse (decaying stereo noise, darker as it fades).
    const verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const k = 0.5 + t * 0.45; // smoothing grows: the tail loses its highs
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
        d[i] = lp * (1 - t) ** 2.6 * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1) * 2.2;
      }
    }
    verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    this.piano = ctx.createGain();
    this.piano.gain.value = 0.85;
    this.piano.connect(this.master);
    this.piano.connect(verb).connect(wet).connect(this.master);

    // Wind: looping brown noise through a slowly breathing low-pass filter.
    const wlen = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, wlen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < wlen; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 380;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(lpf.frequency);
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    src.connect(lpf).connect(this.wind).connect(this.master);
    src.start();
    lfo.start();
  }

  /**
   * One piano note: slightly stretched (inharmonic) partials, each struck as
   * a pair of strings a hair out of tune, higher partials dying first, a
   * felt-hammer knock, and a filter that closes as the note rings.
   */
  private note(midi: number, at: number, vel: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.piano) return;
    const f = hz(midi);
    const t = ctx.currentTime + 0.03 + at;
    // Low notes ring for ages; high ones are short.
    const ring = Math.min(7, Math.max(1.4, 3.6 * Math.sqrt(220 / f)));
    const out = ctx.createGain();
    out.gain.value = vel * 0.22;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 0.4;
    const bright = Math.min(16000, f * (5 + vel * 9));
    tone.frequency.setValueAtTime(bright, t);
    tone.frequency.setTargetAtTime(Math.max(f * 2.2, 500), t + 0.02, ring * 0.25);
    tone.connect(out).connect(this.piano);
    const B = 0.00035; // string stiffness
    const stop = t + ring * 1.6;
    for (let n = 1; n <= 9; n++) {
      const pf = f * n * Math.sqrt(1 + B * n * n);
      if (pf > 15000) break;
      const amp = (1 / n ** 1.15) * (n === 1 ? 1 : 0.5 + vel * 0.6) * (n % 7 === 0 ? 0.3 : 1);
      const decay = ring / (1 + 0.55 * (n - 1));
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.003);
      // The two-stage piano decay: a quick drop after the strike, then the long ring.
      g.gain.setTargetAtTime(amp * 0.45, t + 0.004, 0.07 + 0.05 / n);
      g.gain.setTargetAtTime(0, t + 0.25, decay * 0.45);
      g.connect(tone);
      for (const cents of n <= 4 ? [-0.9, 0.9] : [0]) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = pf;
        o.detune.value = cents + (Math.random() - 0.5) * 0.6;
        o.connect(g);
        o.start(t);
        o.stop(stop);
      }
    }
    // Hammer: a tiny thump of filtered noise.
    const nlen = Math.floor(ctx.sampleRate * 0.03);
    const nb = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nlen) ** 3;
    const ns = ctx.createBufferSource();
    ns.buffer = nb;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.min(4000, f * 3);
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0.25 * vel;
    ns.connect(bp).connect(ng).connect(out);
    ns.start(t);
  }

  private play(notes: readonly Note[]): void {
    for (const [at, m, v] of notes) this.note(m, at, v);
  }

  /** A chord rolled from the bottom up, like a hand spreading across the keys. */
  private roll(at: number, keys: readonly number[], vel: number, spread = 0.045): Note[] {
    return keys.map((m, i) => [at + i * spread, m, vel * (0.85 + (i / keys.length) * 0.15)] as Note);
  }

  /** How windy it is here (0..1): high on the island, calmer on the ground. */
  setWind(level: number): void {
    this.windTarget = level;
  }

  /** `calm`: somewhere quiet enough for the piano to wander (outdoors, not fighting). */
  update(dt: number, calm: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.wind) return;
    this.wind.gain.setTargetAtTime(0.06 * this.windTarget, ctx.currentTime, 1.5);
    if (!calm) return;
    this.noodleIn -= dt;
    if (this.noodleIn <= 0) {
      this.noodleIn = 28 + Math.random() * 40;
      this.noodle();
    }
  }

  /** A few quiet notes, as if someone far off were idly playing. */
  private noodle(): void {
    const count = 2 + Math.floor(Math.random() * 4);
    let i = Math.floor(Math.random() * NOODLE.length);
    let at = 0;
    const notes: Note[] = [];
    if (Math.random() < 0.55) notes.push([0, Math.random() < 0.5 ? N.D3 : N.G2, 0.22]);
    for (let k = 0; k < count; k++) {
      i = Math.max(0, Math.min(NOODLE.length - 1, i + [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)]!));
      notes.push([at, NOODLE[i]!, 0.18 + Math.random() * 0.1]);
      at += 0.45 + Math.random() * 0.6;
    }
    this.play(notes);
  }

  /** The quest motif, left hanging: A–D–E over G and D (IV add9). */
  questStart(): void {
    this.play([
      ...this.roll(0, [N.G2, N.D3, N.A3], 0.35, 0.03),
      [0.02, N.A4, 0.5],
      [0.3, N.D5, 0.55],
      [0.62, N.E5, 0.6],
    ]);
  }

  /** The same motif, coming home: A–D–E then F♯ over D. */
  questComplete(): void {
    this.play([
      [0, N.A4, 0.5],
      [0.24, N.D5, 0.55],
      [0.48, N.E5, 0.55],
      ...this.roll(0.78, [N.D2, N.A2, N.D3, N.Fs3, N.A3], 0.45, 0.035),
      [0.8, N.Fs5, 0.65],
      [1.4, N.D6, 0.3],
    ]);
  }

  /** Climbing a D major 9, left open at the top. */
  levelUp(): void {
    this.play([
      [0, N.D3, 0.45],
      [0.1, N.Fs4, 0.4],
      [0.2, N.A4, 0.45],
      [0.3, N.Cs5, 0.5],
      [0.4, N.E5, 0.55],
      [0.55, N.A5, 0.5],
      ...this.roll(0.62, [N.D2, N.A2, N.E3], 0.35, 0.04),
    ]);
  }

  /** A new land: G lydian, rolled slow and low (wonder, not an ending). */
  arrive(): void {
    this.play([...this.roll(0, [N.G2, N.D3, N.Fs3, N.B3, N.Cs4, N.Fs4], 0.38, 0.11), [0.95, N.A4, 0.3]]);
  }

  /** Story beats get their own chords: none of them resolve. */
  story(beat: "arrival" | "dread" | "fight" | "rescue" | "farewell"): void {
    switch (beat) {
      case "arrival": // Dsus2 opening up, as the clouds part.
        this.play([...this.roll(0, [N.D2, N.A2, N.E3, N.A3, N.D4, N.E4], 0.3, 0.16), [1.3, N.B4, 0.25], [1.9, N.A4, 0.22]]);
        break;
      case "dread": // Low and wrong: a fifth with a minor ninth leaning on it.
        this.play([[0, N.D2, 0.6], [0.02, N.A2, 0.5], [0.05, N.Bb2, 0.45], [0.6, N.E4, 0.3], [1.1, N.F4, 0.32]]);
        break;
      case "fight": // Hammered, unresolved: D minor with an added sixth flat against it.
        this.play([...this.roll(0, [N.D2, N.D3, N.F3, N.Bb3], 0.65, 0.02), [0.35, N.E4, 0.5], [0.55, N.F4, 0.5]]);
        break;
      case "rescue": // Light breaking in: B♭ lydian over D.
        this.play([...this.roll(0, [N.Bb2, N.F3, N.C4, N.D4, N.E4], 0.45, 0.07), [0.6, N.A4, 0.45], [0.95, N.G4, 0.4]]);
        break;
      case "farewell": // Gsus2 drifting up, never landing.
        this.play([...this.roll(0, [N.G2, N.D3, N.A3, N.D4], 0.28, 0.2), [1.1, N.E5, 0.22], [1.8, N.D5, 0.2], [2.6, N.A4, 0.2]]);
        break;
    }
  }
}
