import type { Vec2 } from "../math/vec2.js";
import { findPath } from "../nav/pathfind.js";
import type { NpcSpawn } from "../schemas/building.js";
import type { WalkGrid } from "../terrain/WalkGrid.js";
import { advanceAlongPath, type Mover } from "./movement.js";

/** What a walker needs from a placement (NPCs and enemies both fit). */
export type WanderSpot = Pick<NpcSpawn, "id" | "x" | "z" | "wander" | "radius" | "route"> & {
  /** Roam anywhere in these cells instead of a radius (spawn zones). */
  cells?: ReadonlyArray<readonly [number, number]>;
};

/** NPC stroll speed (world units / s): slower than players. */
export const NPC_WALK_SPEED = 1.6;
const MIN_PAUSE = 2.5;
const MAX_PAUSE = 8;

/** Small deterministic RNG so each NPC has its own rhythm. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h;
}

/**
 * One NPC's movement: idle a random while, then stroll to a random cell in
 * its area (or the next route point), repeat. Runs in the sim (server
 * authoritative later); renderers interpolate prevX/prevZ → x/z.
 */
export class NpcWalker<S extends WanderSpot = NpcSpawn> implements Mover {
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  path: Vec2[] = [];
  dirX: number;
  dirZ: number;
  private wait: number;
  private routeIndex = 0;
  private readonly rand: () => number;

  constructor(readonly spawn: S, facing: [number, number]) {
    this.x = this.prevX = spawn.x + 0.5;
    this.z = this.prevZ = spawn.z + 0.5;
    [this.dirX, this.dirZ] = facing;
    this.rand = mulberry(hash(spawn.id));
    this.wait = 1 + this.rand() * MAX_PAUSE; // staggered starts
  }

  get moving(): boolean {
    return this.path.length > 0;
  }

  cell(): [number, number] {
    return [Math.floor(this.x), Math.floor(this.z)];
  }

  /**
   * Advance by `dt` seconds. `held` = stay put (talking); `blocked(cx, cz)`
   * = someone else stands there (player, other NPCs).
   */
  tick(dt: number, grid: WalkGrid, held: boolean, blocked: (cx: number, cz: number) => boolean): void {
    this.prevX = this.x;
    this.prevZ = this.z;
    if (this.spawn.wander === "none") return;
    if (held) {
      this.path = [];
      this.wait = Math.max(this.wait, MIN_PAUSE);
      return;
    }
    if (this.path.length > 0) {
      advanceAlongPath(this, NPC_WALK_SPEED * dt);
      if (this.path.length === 0) this.wait = MIN_PAUSE + this.rand() * (MAX_PAUSE - MIN_PAUSE);
      return;
    }
    this.wait -= dt;
    if (this.wait > 0) return;
    const target = this.pickTarget(grid, blocked);
    this.wait = MIN_PAUSE + this.rand() * 2; // retry soon if nothing worked
    if (!target) return;
    const path = findPath(grid, { x: this.x, z: this.z }, { x: target[0] + 0.5, z: target[1] + 0.5 }, { maxExpansions: 2000, snapRadius: 0 });
    if (path.length) this.path = path;
  }

  private zoneSet: Set<string> | null = null;

  /** Does the straight walk from here to (tx, tz) stay inside the zone (with a little margin)? */
  private straightInZone(cells: ReadonlyArray<readonly [number, number]>, tx: number, tz: number): boolean {
    if (!this.zoneSet) this.zoneSet = new Set(cells.map(([x, z]) => `${x},${z}`));
    const dx = tx - this.x;
    const dz = tz - this.z;
    const n = Math.ceil(Math.hypot(dx, dz) / 0.3);
    for (let i = 1; i <= n; i++) {
      const px = this.x + (dx * i) / n;
      const pz = this.z + (dz * i) / n;
      // Check the point and a small body-width around it so paths don't graze corners.
      for (const [ox, oz] of [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]] as const) {
        if (!this.zoneSet.has(`${Math.floor(px + ox)},${Math.floor(pz + oz)}`)) return false;
      }
    }
    return true;
  }

  private pickTarget(grid: WalkGrid, blocked: (cx: number, cz: number) => boolean): [number, number] | null {
    const s = this.spawn;
    const [cx, cz] = this.cell();
    if (s.wander === "route") {
      const stops: Array<[number, number]> = [[s.x, s.z], ...s.route];
      if (stops.length < 2) return null;
      this.routeIndex = (this.routeIndex + 1) % stops.length;
      const t = stops[this.routeIndex]!;
      return grid.isWalkable(t[0], t[1]) && !blocked(t[0], t[1]) ? t : null;
    }
    if (s.cells && s.cells.length > 0) {
      // Zones: wander anywhere in the zone, in hops of a sensible length.
      for (let tries = 0; tries < 20; tries++) {
        const t = s.cells[Math.floor(this.rand() * s.cells.length)]!;
        if (Math.max(Math.abs(t[0] - cx), Math.abs(t[1] - cz)) > 10 && tries < 14) continue;
        if ((t[0] === cx && t[1] === cz) || !grid.isWalkable(t[0], t[1]) || blocked(t[0], t[1])) continue;
        if (!this.straightInZone(s.cells, t[0] + 0.5, t[1] + 0.5)) continue;
        return [t[0], t[1]];
      }
      return null;
    }
    const r = s.radius;
    for (let tries = 0; tries < 8; tries++) {
      const tx = s.x + Math.round((this.rand() * 2 - 1) * r);
      const tz = s.z + Math.round((this.rand() * 2 - 1) * r);
      if ((tx === cx && tz === cz) || !grid.isWalkable(tx, tz) || blocked(tx, tz)) continue;
      return [tx, tz];
    }
    return null;
  }
}
