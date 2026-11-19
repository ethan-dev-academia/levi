import * as THREE from "three";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Seconds of flight, from the player's shoulder out over the shore to the far point. */
const FLIGHT = 21;
/** White-out back to the player: in, hold, out. */
export const VISTA_FADE = { in: 0.7, hold: 0.25, out: 0.9 } as const;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * A dialogue line's "look out there" moment, played through without a
 * skip: the camera turns from the player towards a far point, lifts out
 * past the edge, sweeps down over the shore and circles the place, then
 * whites out back to the player.
 *
 * One spline at an even pace, eased only at the very start and end, so it
 * never stops and starts between waypoints.
 */
export class Vista {
  private path: THREE.CatmullRomCurve3 | null = null;
  private P = new THREE.Vector3();
  private T = new THREE.Vector3();
  private near = new THREE.Vector3();
  private t = 0;
  private on = false;
  private backAt = Infinity;
  readonly cam = new THREE.Vector3();
  readonly look = new THREE.Vector3();

  get active(): boolean {
    return this.on;
  }

  /** The flight is over and the white-out has covered the screen: hand back. */
  get landed(): boolean {
    return this.on && this.t >= this.backAt;
  }

  /** 0..1: how far out the view should reach (fog, far plane). */
  get openness(): number {
    return this.on ? smoothstep(0, 2.5, this.t) : 0;
  }

  /** Clouds clear out of the way at once, and come back with you. */
  get cloudFade(): number {
    return this.on ? 1 - smoothstep(0, 1.4, this.t) : 1;
  }

  /** Once the camera has left the player, build the land over there. */
  get lookingFar(): boolean {
    return this.on && this.t > 1;
  }

  get target(): Point3 {
    return this.T;
  }

  /** When to start the white-out so it peaks as the flight ends. */
  get fadeAt(): number {
    return FLIGHT - VISTA_FADE.in;
  }

  get time(): number {
    return this.t;
  }

  start(camera: THREE.Vector3, player: Point3, target: Point3): void {
    const P = this.P.set(player.x, player.y, player.z);
    const T = this.T.set(target.x, target.y, target.z);
    const dir = new THREE.Vector3(T.x - P.x, 0, T.z - P.z).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const span = Math.hypot(T.x - P.x, T.z - P.z);
    const at = (base: THREE.Vector3, along: number, up: number, across = 0): THREE.Vector3 =>
      base.clone().addScaledVector(dir, along).addScaledVector(side, across).add(new THREE.Vector3(0, up, 0));
    const high = Math.max(P.y + 26, T.y + 90);
    const lift = (v: THREE.Vector3, y: number): THREE.Vector3 => v.setY(y);
    this.near = at(P, 45, -14);
    this.path = new THREE.CatmullRomCurve3(
      [
        camera.clone(),
        lift(at(P, -16, 0, 5), P.y + 13), // crane up and back: you, small, and the world beyond
        lift(at(P, span * 0.22, 0, -6), high), // out over the edge, high above the clouds
        lift(at(P, span * 0.55, 0, -14), T.y + 80), // gliding down over the shore
        lift(at(T, -105, 0, -34), T.y + 55), // the walls come up
        lift(at(T, -40, 0, -82), T.y + 46), // round the side of the city
        lift(at(T, 35, 0, -80), T.y + 44),
      ],
      false,
      "centripetal",
    );
    this.t = 0;
    this.backAt = FLIGHT + VISTA_FADE.hold * 0.5;
    this.on = true;
    this.sample();
  }

  stop(): void {
    this.on = false;
    this.path = null;
  }

  update(dt: number): void {
    if (!this.on) return;
    this.t += dt;
    this.sample();
  }

  private sample(): void {
    if (!this.path) return;
    const s = Math.min(1, this.t / FLIGHT);
    // Even pace through the middle, gentle at both ends.
    // (Cubic ease-in/out joined to the linear middle with matching speed: no kinks.)
    let u = s;
    if (s < 0.12) {
      const x = s / 0.12;
      u = 0.12 * (2 * x * x - x * x * x);
    } else if (s > 0.9) {
      const x = (s - 0.9) / 0.1;
      u = 0.9 + 0.1 * (x + x * x - x * x * x);
    }
    this.path.getPointAt(Math.min(1, u), this.cam);
    // Look: from the player, out ahead over the edge, then settle on the far point.
    this.look.copy(this.P).lerp(this.near, smoothstep(0, 0.12, s));
    this.look.lerp(this.T, smoothstep(0.1, 0.36, s));
  }
}
