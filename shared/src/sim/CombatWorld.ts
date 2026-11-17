import { findPath } from "../nav/pathfind.js";
import type { CombatStyle } from "../progression/disciplines.js";
import type { EnemySpawn, SpawnZone } from "../schemas/building.js";
import { attackFollows, type EnemyAttack, type EnemyDef } from "../schemas/enemy.js";
import type { WalkGrid } from "../terrain/WalkGrid.js";
import { distToSegment, inCircle, inCone, inLine, rollDamage } from "./combatMath.js";
import { advanceAlongPath } from "./movement.js";
import { NpcWalker } from "./npcWander.js";
import type { Vec2 } from "../math/vec2.js";

/** How hard a player-made hit lands (rolled against the target's armour). */
export interface HitPayload {
  base: number;
  ratio: number;
  stat: number;
  critChance: number;
  critMultiplier: number;
  /** Combat style credited with the hit (XP on kill). */
  style: CombatStyle;
}

export interface Projectile {
  id: number;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  dirX: number;
  dirZ: number;
  speed: number;
  /** Distance left before it fizzles. */
  left: number;
  /** Hit radius around the projectile path. */
  width: number;
  /** Keeps going through enemies (melee sweeps) or stops at the first. */
  pierce: boolean;
  /** Auto-attacks fly at one enemy and can't miss. */
  homing: string | null;
  payload: HitPayload;
  visual: CombatStyle;
  hit: Set<string>;
}

export interface Telegraph {
  id: number;
  enemy: string;
  attack: EnemyAttack;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Seconds elapsed of attack.windup. */
  t: number;
}

export type EnemyMode = "idle" | "chase" | "windup" | "return" | "dead";

export interface EnemyState {
  spawn: EnemySpawn;
  /** Set for enemies that live in a spawn zone. */
  zone: SpawnZone | null;
  def: EnemyDef;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  dirX: number;
  dirZ: number;
  hp: number;
  mode: EnemyMode;
  path: Vec2[];
  repath: number;
  cooldowns: Map<string, number>;
  telegraph: Telegraph | null;
  /** Seconds until respawn (dead) / since last hit (dummies). */
  timer: number;
  walker: NpcWalker<EnemySpawn>;
}

export type CombatEvent =
  | { kind: "damage"; target: "enemy" | "player"; id: string; x: number; z: number; amount: number; crit: boolean }
  | { kind: "kill"; enemy: EnemyDef; spawn: string; style: CombatStyle }
  | { kind: "dummyHit"; enemy: EnemyDef; style: CombatStyle; amount: number };

export interface CombatPlayer {
  x: number;
  z: number;
  /** Enemies only fight on the ground storey for now. */
  onGround: boolean;
  alive: boolean;
  armour: number;
}

const FACING: Array<[number, number]> = [[0, 1], [-1, 0], [0, -1], [1, 0]];
const BODY_RADIUS = 0.45;

/** Small seeded RNG so a run is reproducible. */
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

/**
 * Everything that fights: enemies (roam, notice, chase, telegraph, strike,
 * leash home, die, respawn), player projectiles, and enemy telegraphs.
 * Pure simulation shared with the future server; the client only renders
 * what's in here and the events it emits.
 */
export class CombatWorld {
  readonly enemies = new Map<string, EnemyState>();
  readonly projectiles: Projectile[] = [];
  private events: CombatEvent[] = [];
  /** Telegraphs that just struck (renderer flashes them). Drained by the client. */
  struck: Telegraph[] = [];
  private nextId = 1;
  private source: readonly EnemySpawn[] | null = null;
  private zoneSource: readonly SpawnZone[] | null = null;
  private grid: WalkGrid | null = null;
  readonly rand: () => number;

  constructor(
    private readonly defs: ReadonlyMap<string, EnemyDef>,
    seed = 1,
  ) {
    this.rand = mulberry(seed);
  }

  /** Keep enemy states in step with the placed spawns (dev edits add/remove). */
  sync(spawns: readonly EnemySpawn[], zones: readonly SpawnZone[] = [], grid?: WalkGrid): void {
    if (grid) this.grid = grid;
    if (zones !== this.zoneSource) {
      this.zoneSource = zones;
      for (const [id, e] of [...this.enemies]) if (e.zone) this.enemies.delete(id);
      for (const z of zones) {
        let n = 0;
        for (const m of z.mobs) {
          const def = this.defs.get(m.enemy);
          if (!def) continue;
          for (let i = 0; i < m.count; i++) {
            const id = `${z.id}#${n++}`;
            const e = this.freshInZone(z, def, id);
            if (e) this.enemies.set(id, e);
          }
        }
      }
    }
    if (spawns === this.source) return;
    this.source = spawns;
    const keep = new Set<string>();
    for (const s of spawns) {
      const def = this.defs.get(s.enemy);
      if (!def) continue;
      keep.add(s.id);
      const old = this.enemies.get(s.id);
      if (old && old.def.id === def.id) {
        old.spawn = s;
        old.walker = new NpcWalker(s, FACING[s.rot & 3]!);
        continue;
      }
      this.enemies.set(s.id, this.fresh(s, def));
    }
    for (const [id, e] of [...this.enemies]) if (!e.zone && !keep.has(id)) this.enemies.delete(id);
  }

  /** A zone enemy on a random walkable cell of its zone. */
  private freshInZone(z: SpawnZone, def: EnemyDef, id: string): EnemyState | null {
    if (z.cells.length === 0) return null;
    let pick = z.cells[Math.floor(this.rand() * z.cells.length)]!;
    for (let tries = 0; tries < 24 && this.grid && !this.grid.isWalkable(pick[0], pick[1]); tries++) {
      pick = z.cells[Math.floor(this.rand() * z.cells.length)]!;
    }
    const spawn: EnemySpawn = { id, enemy: def.id, x: pick[0], z: pick[1], rot: Math.floor(this.rand() * 4), storey: 0, wander: "area", radius: 2, route: [] };
    const e = this.fresh(spawn, def);
    const spot = { ...spawn, cells: z.cells };
    e.walker = new NpcWalker<EnemySpawn>(spot, FACING[spawn.rot & 3]!);
    e.zone = z;
    return e;
  }

  private fresh(s: EnemySpawn, def: EnemyDef): EnemyState {
    const [dx, dz] = FACING[s.rot & 3]!;
    const walker = new NpcWalker(def.dummy ? { ...s, wander: "none" } : s, [dx, dz]);
    return {
      spawn: s, zone: null, def, x: s.x + 0.5, z: s.z + 0.5, prevX: s.x + 0.5, prevZ: s.z + 0.5, dirX: dx, dirZ: dz,
      hp: def.stats.maxHp, mode: "idle", path: [], repath: 0, cooldowns: new Map(), telegraph: null, timer: 0, walker,
    };
  }

  /** Enemy definitions were edited: swap them in (spawns that lost their def disappear). */
  refreshDefs(): void {
    for (const [id, e] of [...this.enemies]) {
      const def = this.defs.get(e.spawn.enemy);
      if (!def) {
        this.enemies.delete(id);
        continue;
      }
      e.def = def;
      e.hp = Math.min(e.hp, def.stats.maxHp);
    }
    this.source = null;
  }

  /** Take (and clear) what happened since the last call. */
  drainEvents(): CombatEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get telegraphs(): Telegraph[] {
    const out: Telegraph[] = [];
    for (const e of this.enemies.values()) if (e.telegraph) out.push(e.telegraph);
    return out;
  }

  /** Living enemy under / nearest a point (for clicks). */
  enemyNear(x: number, z: number, reach = 0.9): EnemyState | null {
    let best: EnemyState | null = null;
    let bd = reach;
    for (const e of this.enemies.values()) {
      if (e.mode === "dead") continue;
      const d = Math.hypot(e.x - x, e.z - z) - this.radius(e) + BODY_RADIUS;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  radius(e: EnemyState): number {
    return BODY_RADIUS * Math.max(0.6, e.def.scale);
  }

  // --- Player actions ------------------------------------------------------------------------------

  /** A skillshot / auto-attack projectile from the player. */
  fire(p: Omit<Projectile, "id" | "prevX" | "prevZ" | "hit">): void {
    this.projectiles.push({ ...p, id: this.nextId++, prevX: p.x, prevZ: p.z, hit: new Set() });
  }

  /** Land a hit on an enemy (projectiles, melee). */
  hitEnemy(e: EnemyState, payload: HitPayload): void {
    if (e.mode === "dead") return;
    const roll = rollDamage(payload.base, payload.ratio, payload.stat, payload.critChance, payload.critMultiplier, e.def.stats.armour, this.rand);
    this.events.push({ kind: "damage", target: "enemy", id: e.spawn.id, x: e.x, z: e.z, amount: roll.amount, crit: roll.crit });
    if (e.def.dummy) {
      e.hp = Math.max(1, e.hp - roll.amount);
      e.timer = 0;
      this.events.push({ kind: "dummyHit", enemy: e.def, style: payload.style, amount: roll.amount });
      return;
    }
    e.hp -= roll.amount;
    if (e.mode === "idle" || e.mode === "return") e.mode = "chase";
    if (e.hp <= 0) {
      e.hp = 0;
      e.mode = "dead";
      e.telegraph = null;
      e.path = [];
      e.timer = e.def.respawn;
      this.events.push({ kind: "kill", enemy: e.def, spawn: e.spawn.id, style: payload.style });
    }
  }

  /** Player died / left: everyone calms down and heads home. */
  calmAll(): void {
    for (const e of this.enemies.values()) {
      if (e.mode === "chase" || e.mode === "windup") {
        e.mode = "return";
        e.telegraph = null;
        e.path = [];
      }
    }
  }

  // --- Simulation ----------------------------------------------------------------------------------

  tick(dt: number, grid: WalkGrid, player: CombatPlayer, damagePlayer: (amount: number, crit: boolean) => void): void {
    this.grid = grid;
    this.tickProjectiles(dt, grid);
    for (const e of this.enemies.values()) this.tickEnemy(e, dt, grid, player, damagePlayer);
  }

  private tickProjectiles(dt: number, grid: WalkGrid): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]!;
      p.prevX = p.x;
      p.prevZ = p.z;
      if (p.homing) {
        const t = this.enemies.get(p.homing);
        if (!t || t.mode === "dead") {
          this.projectiles.splice(i, 1);
          continue;
        }
        const dx = t.x - p.x;
        const dz = t.z - p.z;
        const d = Math.hypot(dx, dz);
        const step = p.speed * dt;
        if (d <= step + this.radius(t)) {
          this.hitEnemy(t, p.payload);
          this.projectiles.splice(i, 1);
          continue;
        }
        p.dirX = dx / d;
        p.dirZ = dz / d;
        p.x += p.dirX * step;
        p.z += p.dirZ * step;
        continue;
      }
      // Move in small steps; walls, cliffs and the world's edge stop the shot.
      const step = Math.min(p.speed * dt, p.left);
      let moved = 0;
      let blocked = false;
      let cx = Math.floor(p.x);
      let cz = Math.floor(p.z);
      while (moved < step - 1e-6) {
        const d = Math.min(0.2, step - moved);
        const nx = p.x + p.dirX * d;
        const nz = p.z + p.dirZ * d;
        const ncx = Math.floor(nx);
        const ncz = Math.floor(nz);
        if ((ncx !== cx || ncz !== cz) && !grid.canStep(cx, cz, Math.sign(ncx - cx), Math.sign(ncz - cz))) {
          blocked = true;
          break;
        }
        p.x = nx;
        p.z = nz;
        cx = ncx;
        cz = ncz;
        moved += d;
      }
      p.left -= moved;
      let done = blocked || p.left <= 1e-4;
      for (const e of this.enemies.values()) {
        if (e.mode === "dead" || p.hit.has(e.spawn.id)) continue;
        if (distToSegment(e.x, e.z, p.prevX, p.prevZ, p.x, p.z) <= p.width / 2 + this.radius(e)) {
          p.hit.add(e.spawn.id);
          this.hitEnemy(e, p.payload);
          if (!p.pierce) {
            done = true;
            break;
          }
        }
      }
      if (done) this.projectiles.splice(i, 1);
    }
  }

  private tickEnemy(e: EnemyState, dt: number, grid: WalkGrid, pl: CombatPlayer, damagePlayer: (amount: number, crit: boolean) => void): void {
    e.prevX = e.x;
    e.prevZ = e.z;
    for (const [k, v] of e.cooldowns) e.cooldowns.set(k, Math.max(0, v - dt));
    const def = e.def;
    const home = { x: e.spawn.x + 0.5, z: e.spawn.z + 0.5 };

    if (e.mode === "dead") {
      e.timer -= dt;
      if (e.timer <= 0) {
        const next = e.zone ? this.freshInZone(e.zone, def, e.spawn.id) : this.fresh(e.spawn, def);
        if (next) Object.assign(e, next);
      }
      return;
    }
    if (def.dummy) {
      // Heals back up a few seconds after the last hit.
      e.timer += dt;
      if (e.timer > 4) e.hp = def.stats.maxHp;
      return;
    }

    const dPlayer = Math.hypot(pl.x - e.x, pl.z - e.z);
    const canSee = pl.alive && pl.onGround;

    // Mid-attack: hold still, then strike whoever is still in the marked area.
    if (e.mode === "windup" && e.telegraph) {
      const t = e.telegraph;
      t.t += dt;
      // Small attacks keep chasing: the marked area moves and turns with the enemy.
      if (attackFollows(t.attack) && canSee) {
        const reach = Math.max(0.8, t.attack.range * 0.6);
        if (dPlayer > reach) {
          e.repath -= dt;
          if (e.repath <= 0 || e.path.length === 0) {
            e.path = findPath(grid, e, { x: pl.x, z: pl.z }, { maxExpansions: 3000, snapRadius: 2 });
            e.repath = 0.3;
          }
          this.move(e, def.stats.moveSpeed, dt);
        } else e.path = [];
        const d = dPlayer || 1;
        e.dirX = (pl.x - e.x) / d;
        e.dirZ = (pl.z - e.z) / d;
        t.x = e.x;
        t.z = e.z;
        t.dirX = e.dirX;
        t.dirZ = e.dirZ;
      }
      if (t.t >= t.attack.windup) {
        const a = t.attack;
        const inside =
          canSee &&
          (a.shape === "circle"
            ? inCircle(pl.x, pl.z, t.x, t.z, a.radius, 0.25)
            : a.shape === "line"
              ? inLine(pl.x, pl.z, t.x, t.z, t.dirX, t.dirZ, a.length, a.width, 0.25)
              : inCone(pl.x, pl.z, t.x, t.z, t.dirX, t.dirZ, a.length, a.angle, 0.25));
        if (inside) {
          const roll = rollDamage(a.damage, 0, 0, 0, 1, pl.armour, this.rand);
          this.events.push({ kind: "damage", target: "player", id: "player", x: pl.x, z: pl.z, amount: roll.amount, crit: false });
          damagePlayer(roll.amount, false);
        }
        e.cooldowns.set(a.id, a.cooldown);
        this.struck.push({ ...t });
        e.telegraph = null;
        e.mode = "chase";
      }
      return;
    }

    if (e.mode === "idle") {
      e.walker.x = e.x;
      e.walker.z = e.z;
      e.walker.tick(dt, grid, false, () => false);
      e.x = e.walker.x;
      e.z = e.walker.z;
      if (e.walker.moving) {
        e.dirX = e.walker.dirX;
        e.dirZ = e.walker.dirZ;
      }
      if (canSee && dPlayer <= def.aggroRange && def.attacks.length > 0) e.mode = "chase";
      return;
    }

    if (e.mode === "return") {
      if (e.path.length === 0) e.path = findPath(grid, e, home, { maxExpansions: 4000, snapRadius: 2 });
      this.move(e, def.stats.moveSpeed * 1.4, dt);
      e.hp = Math.min(def.stats.maxHp, e.hp + def.stats.maxHp * 0.25 * dt);
      if (Math.hypot(e.x - home.x, e.z - home.z) < 0.4 || e.path.length === 0) {
        e.mode = "idle";
        e.hp = def.stats.maxHp;
        e.path = [];
      }
      return;
    }

    // Chase: leash, attack if something's in range, otherwise close in.
    if (!canSee || Math.hypot(e.x - home.x, e.z - home.z) > def.leashRange || dPlayer > def.leashRange) {
      e.mode = "return";
      e.path = [];
      return;
    }
    const ready = def.attacks.filter((a) => (e.cooldowns.get(a.id) ?? 0) <= 0 && dPlayer <= a.range);
    if (ready.length > 0) {
      const a = ready[Math.floor(this.rand() * ready.length)]!;
      const dx = pl.x - e.x;
      const dz = pl.z - e.z;
      const d = Math.hypot(dx, dz) || 1;
      e.dirX = dx / d;
      e.dirZ = dz / d;
      const atTarget = a.shape === "circle" && a.anchor === "target";
      e.telegraph = {
        id: this.nextId++, enemy: e.spawn.id, attack: a,
        x: atTarget ? pl.x : e.x, z: atTarget ? pl.z : e.z, dirX: e.dirX, dirZ: e.dirZ, t: 0,
      };
      e.mode = "windup";
      e.path = [];
      return;
    }
    const reach = Math.max(0.9, Math.min(...def.attacks.map((a) => a.range)) * 0.8);
    if (dPlayer > reach) {
      e.repath -= dt;
      if (e.repath <= 0 || e.path.length === 0) {
        e.path = findPath(grid, e, { x: pl.x, z: pl.z }, { maxExpansions: 3000, snapRadius: 2 });
        e.repath = 0.4;
      }
      this.move(e, def.stats.moveSpeed, dt);
    } else {
      e.path = [];
      const d = dPlayer || 1;
      e.dirX = (pl.x - e.x) / d;
      e.dirZ = (pl.z - e.z) / d;
    }
  }

  private move(e: EnemyState, speed: number, dt: number): void {
    const m = { x: e.x, z: e.z, path: e.path, dirX: e.dirX, dirZ: e.dirZ };
    advanceAlongPath(m, speed * dt);
    e.x = m.x;
    e.z = m.z;
    e.path = m.path;
    e.dirX = m.dirX;
    e.dirZ = m.dirZ;
  }
}
