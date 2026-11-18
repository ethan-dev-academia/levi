import type { CameraShot } from "../camera/OrbitCamera.js";

/** One line of the Benefactor's voice: seconds into the intro, then the words. */
const LINES: ReadonlyArray<readonly [number, string]> = [
  [1.2, "...Wake, little spark."],
  [4.4, "This is Falcon's Landing, the first shore of my world, high above the clouds."],
  [8.4, "Seek out Falcon. He will make you strong... strong enough for what is coming."],
  [12.2, "Go now. I will be watching."],
];
const DURATION = 15;

export interface ArrivalHooks {
  cinematic(on: boolean): void;
  whiteFlash(fadeIn: number, hold: number, fadeOut: number): void;
  voice(text: string): void;
  pillar(x: number, z: number, seconds: number): void;
  title(): void;
  /** Tell the server the arrival has been seen (it won't play again). */
  done(): void;
}

const ease = (t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
};

/**
 * The first thing a new hero sees: white light, the camera sinking through
 * the clouds onto the island, a pillar of light where they stand, and the
 * Benefactor's voice. Presentation only; the player can't act until it ends.
 */
export class ArrivalIntro {
  private t = -1;
  private line = 0;
  private titled = false;
  private yaw0 = 0;

  constructor(private readonly hooks: ArrivalHooks) {}

  get active(): boolean {
    return this.t >= 0 && this.t < DURATION;
  }

  start(x: number, z: number, yaw: number): void {
    this.t = 0;
    this.line = 0;
    this.titled = false;
    this.yaw0 = yaw;
    this.hooks.cinematic(true);
    this.hooks.whiteFlash(0.01, 1.2, 3.2);
    this.hooks.pillar(x, z, 6.5);
  }

  /** Advance; returns the camera shot while playing. */
  update(dt: number): CameraShot | null {
    if (!this.active) return null;
    // Loading hitches can make one frame seconds long (and the first one can even be negative).
    this.t += Math.max(0, Math.min(dt, 0.05));
    while (this.line < LINES.length && LINES[this.line]![0] <= this.t) this.hooks.voice(LINES[this.line++]![1]);
    if (!this.titled && this.t >= 9.8) {
      this.titled = true;
      this.hooks.title();
    }
    if (this.t >= DURATION) {
      this.hooks.cinematic(false);
      this.hooks.done();
      return null;
    }
    // From high above the clouds, circling down to just behind the hero.
    const k = ease(this.t / 12.5);
    return { yaw: this.yaw0 + (1 - k) * 1.4, pitch: 1.28 + (0.62 - 1.28) * k, distance: 95 + (15 - 95) * k, rate: 9 };
  }
}
