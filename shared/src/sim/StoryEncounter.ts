import type { QuestEngine } from "../progression/quests.js";
import type { EnemyDef } from "../schemas/enemy.js";
import type { BarkSpeaker, EncounterDef, EncounterPhase } from "../schemas/encounter.js";
import type { Vec2 } from "../math/vec2.js";
import type { CombatWorld, EnemyState } from "./CombatWorld.js";

/** A hop through the air: x/z move straight from → to; the renderer adds the height. */
export interface Arc {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** Encounter clock (seconds) when it starts, and how long it takes. */
  t0: number;
  dur: number;
  /** Extra height at the middle of the hop. */
  peak: number;
}

export type ActorPose = "stand" | "down" | "kneel" | "channel" | "hover";

/** Someone the encounter moves around (Falcon, the boss, the player's flight). */
export interface Actor {
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  dirX: number;
  dirZ: number;
  arc: Arc | null;
  visible: boolean;
  pose: ActorPose;
}

export type BulletKind = "orb" | "needle" | "big" | "mine";

export interface Bullet {
  id: number;
  kind: BulletKind;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  vx: number;
  vz: number;
  r: number;
  age: number;
  /** Mines: seconds until they burst into a ring. */
  fuse: number;
}

/** What the renderer and UI show. Drained every frame. */
export type EncounterEvent =
  | { kind: "bark"; speaker: BarkSpeaker; name: string; text: string }
  | { kind: "cinematic"; on: boolean }
  | { kind: "comet"; x: number; z: number; dur: number }
  | { kind: "impact"; x: number; z: number; size: number }
  | { kind: "blast"; x: number; z: number; dirX: number; dirZ: number }
  | { kind: "debris"; dur: number }
  | { kind: "blink"; fromX: number; fromZ: number; toX: number; toZ: number }
  | { kind: "volley"; x: number; z: number }
  | { kind: "falconShot"; fromX: number; fromZ: number; toX: number; toZ: number }
  | { kind: "charge"; x: number; z: number; dur: number }
  | { kind: "beam"; fromX: number; fromZ: number; toX: number; toZ: number }
  | { kind: "playerHit"; x: number; z: number; amount: number }
  | { kind: "clearBullets" }
  | { kind: "portal"; x: number; z: number; dur: number }
  | { kind: "flash"; fadeIn: number; hold: number; fadeOut: number }
  | { kind: "shake"; power: number; dur: number };

export interface EncounterHost {
  player: { x: number; z: number; prevX: number; prevZ: number; dirX: number; dirZ: number; path: Vec2[] };
  quests: QuestEngine;
  /** The character's world flags (mutable). */
  flags(): string[];
  hp(): number;
  setHp(v: number): void;
  combat: CombatWorld;
  boss: EnemyDef | undefined;
  /** Where an NPC is placed on the map (Falcon's starting spot). */
  npcPos(npc: string): Vec2 | null;
  /** In a conversation right now. */
  talking(): boolean;
  teleport(x: number, z: number): void;
  message(text: string): void;
}

const PLAYER_R = 0.3;
const BULLET: Record<BulletKind, { r: number; speed: number }> = {
  orb: { r: 0.3, speed: 4.6 },
  needle: { r: 0.2, speed: 8.2 },
  big: { r: 0.62, speed: 2.7 },
  mine: { r: 0.42, speed: 0 },
};

/** Beat timings (seconds into each phase). */
const CRASH = { comet: 0.4, land: 1.9, blast: 2.9, fly: 1.7, debris: 4.7, debrisDur: 2.2, glide: 7.2, glideDur: 1.6, end: 10.2 };
const RESCUE = { charge: 0.3, chargeDur: 2.2, leap: 1.35, leapDur: 0.85, fire: 2.5, end: 5.2 };
const FAREWELL = { portal: 7.4, portalDur: 3.4, flash: 10.4, warp: 11.1 };
const FIGHT_FAILSAFE = 110;

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

const actor = (x: number, z: number): Actor => ({ x, z, prevX: x, prevZ: z, dirX: 0, dirZ: 1, arc: null, visible: false, pose: "stand" });

interface Shot {
  at: number;
  fire: () => void;
}

/**
 * The prologue's scripted boss fight, run by the simulation (so a server can
 * run it too): the crash, the knock-back off the mountain, the arena forming,
 * the bullet-hell fight, Falcon's dive, and the teleport out. Which beat
 * plays comes from quest progress, so reloading mid-way picks up again.
 */
export class StoryEncounter {
  phase: EncounterPhase | null = null;
  /** Seconds into the current phase. */
  t = 0;
  /** Seconds since this encounter object was made (arcs are timed on this). */
  clock = 0;
  readonly falcon = actor(0, 0);
  readonly bossActor = actor(0, 0);
  readonly bullets: Bullet[] = [];
  /** Cutscene beat: the player can't act. */
  locked = false;
  private events: EncounterEvent[] = [];
  private barkIndex = 0;
  private nextBullet = 1;
  private grace = 0;
  private readonly rand = mulberry(77);
  private boss: EnemyState | null = null;
  private shots: Shot[] = [];
  private patternEnd = 0;
  private patternN = 0;
  private falconSwatted = false;
  private falconShotAt = 0;
  private playerArc: Arc | null = null;

  constructor(
    readonly def: EncounterDef,
    private readonly host: EncounterHost,
  ) {}

  get bossId(): string {
    return `${this.def.boss}-boss`;
  }

  /** Is the encounter playing Falcon right now (hide the placed NPC)? */
  get ownsFalcon(): boolean {
    return this.phase !== null;
  }

  /** The player's flight (knock-back), for the renderer. */
  get flight(): Arc | null {
    return this.playerArc;
  }

  get active(): boolean {
    return this.phase !== null;
  }

  drainEvents(): EncounterEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // --- Quest wiring ----------------------------------------------------------------------------

  private stepActive(h: { quest: string; step: string }): boolean {
    const q = this.host.quests.quest(h.quest);
    return !!q && this.host.quests.status(h.quest) === "active" && this.host.quests.step(q)?.id === h.step;
  }

  private complete(h: { quest: string; step: string; objective: string }): void {
    const qe = this.host.quests;
    if (qe.status(h.quest) === "notStarted") qe.start(h.quest);
    if (this.stepActive(h)) qe.completeObjective(h.quest, h.objective);
  }

  /** Which beat quest progress says is next (null = nothing to play). */
  private wanted(): EncounterPhase | null {
    const q = this.def.quests;
    if (this.stepActive(q.farewell)) return "farewell";
    if (this.stepActive(q.rescue)) return "rescue";
    if (this.stepActive(q.fight)) return "fight";
    if (this.stepActive(q.crash)) return "crash";
    return null;
  }

  // --- Phases ----------------------------------------------------------------------------------

  private inArena(x: number, z: number, slack = 0): boolean {
    const a = this.def.arena;
    return Math.hypot(x - a.x, z - a.z) <= a.radius + slack;
  }

  private setFlag(): void {
    if (!this.host.flags().includes(this.def.arenaFlag)) this.host.flags().push(this.def.arenaFlag);
  }

  private spawnBoss(x: number, z: number): void {
    const def = this.host.boss;
    if (!def) return;
    this.boss = this.host.combat.addScripted(this.bossId, def, x, z);
    this.syncBoss();
  }

  private despawnBoss(): void {
    this.host.combat.enemies.delete(this.bossId);
    this.boss = null;
  }

  private syncBoss(): void {
    const e = this.boss;
    const b = this.bossActor;
    if (!e) return;
    e.prevX = b.prevX;
    e.prevZ = b.prevZ;
    e.x = b.x;
    e.z = b.z;
    e.dirX = b.dirX;
    e.dirZ = b.dirZ;
  }

  private place(a: Actor, x: number, z: number): void {
    a.x = a.prevX = x;
    a.z = a.prevZ = z;
    a.arc = null;
  }

  private face(a: Actor, x: number, z: number): void {
    const dx = x - a.x;
    const dz = z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) {
      a.dirX = dx / d;
      a.dirZ = dz / d;
    }
  }

  private hop(a: Actor, toX: number, toZ: number, dur: number, peak: number): void {
    a.arc = { fromX: a.x, fromZ: a.z, toX, toZ, t0: this.clock, dur, peak };
  }

  private enter(phase: EncounterPhase): void {
    const d = this.def;
    const p = this.host.player;
    this.phase = phase;
    this.t = 0;
    this.barkIndex = 0;
    this.shots = [];
    this.patternEnd = 0;
    this.bullets.length = 0;
    this.locked = phase !== "fight";
    this.events.push({ kind: "cinematic", on: this.locked });
    p.path = [];
    if (phase === "crash") {
      const f = this.host.npcPos(d.falconNpc) ?? d.lookout;
      this.place(this.falcon, f.x + 0.5, f.z + 0.5);
      this.falcon.visible = true;
      this.falcon.pose = "stand";
      this.face(this.falcon, p.x, p.z);
      this.place(this.bossActor, d.impact.x, d.impact.z);
      this.bossActor.visible = false;
      return;
    }
    // Every later beat happens in the arena.
    this.setFlag();
    if (!this.inArena(p.x, p.z)) this.host.teleport(d.playerLand.x, d.playerLand.z);
    this.playerArc = null;
    if (!this.boss) {
      this.place(this.bossActor, d.bossHome.x, d.bossHome.z);
      this.spawnBoss(d.bossHome.x, d.bossHome.z);
    }
    this.bossActor.visible = true;
    this.bossActor.pose = "hover";
    this.face(this.bossActor, p.x, p.z);
    this.falcon.visible = true;
    if (phase === "fight") {
      this.place(this.falcon, d.falconLand.x, d.falconLand.z);
      this.falcon.pose = "stand";
      this.face(this.falcon, this.bossActor.x, this.bossActor.z);
      this.falconSwatted = false;
      this.falconShotAt = 0.8;
      this.patternN = 0;
      this.patternEnd = 1.6;
    } else if (phase === "rescue") {
      if (!this.falconSwatted) this.place(this.falcon, d.falconRest.x, d.falconRest.z);
      this.falcon.pose = "down";
      this.host.setHp(Math.min(this.host.hp(), d.rescueHp));
      this.events.push({ kind: "clearBullets" });
      // She blinks in close for the finishing blow (toward the middle, so it stays in the arena).
      const a = d.arena;
      const tx = a.x - p.x;
      const tz = a.z - p.z;
      const td = Math.hypot(tx, tz);
      const ux = td > 0.5 ? tx / td : 1;
      const uz = td > 0.5 ? tz / td : 0;
      const to = this.clampToArena(p.x + ux * 6.5, p.z + uz * 6.5, 1);
      this.events.push({ kind: "blink", fromX: this.bossActor.x, fromZ: this.bossActor.z, toX: to.x, toZ: to.z });
      this.place(this.bossActor, to.x, to.z);
    } else {
      // Farewell: Falcon on one knee beside you, the boss a few steps off.
      const bx = this.bossActor.x - p.x;
      const bz = this.bossActor.z - p.z;
      const bd = Math.hypot(bx, bz) || 1;
      this.place(this.falcon, p.x + (bx / bd) * 1.2, p.z + (bz / bd) * 1.2);
      this.falcon.pose = "kneel";
      this.face(this.falcon, p.x, p.z);
    }
  }

  private finish(): void {
    this.phase = null;
    this.locked = false;
    this.bullets.length = 0;
    this.falcon.visible = false;
    this.bossActor.visible = false;
    this.despawnBoss();
    this.events.push({ kind: "cinematic", on: false });
  }

  private say(speaker: BarkSpeaker, text: string): void {
    this.events.push({ kind: "bark", speaker, name: this.def.speakers[speaker], text });
  }

  private barks(): void {
    const list = this.def.barks;
    // Barks are authored in order; play each whose moment has come.
    for (;;) {
      const mine = list.filter((b) => b.phase === this.phase);
      const b = mine[this.barkIndex];
      if (!b || b.at > this.t) return;
      this.barkIndex++;
      this.say(b.speaker, b.text);
    }
  }

  // --- Tick ------------------------------------------------------------------------------------

  tick(dt: number): void {
    this.clock += dt;
    for (const a of [this.falcon, this.bossActor]) {
      a.prevX = a.x;
      a.prevZ = a.z;
    }
    if (this.phase === null) {
      const want = this.wanted();
      if (!want) return;
      if (want === "crash") {
        const p = this.host.player;
        const l = this.def.lookout;
        if (this.host.talking() || Math.hypot(p.x - l.x, p.z - l.z) > this.def.triggerRadius) return;
        if (this.host.flags().includes(this.def.arenaFlag)) {
          // Reloaded after the arena formed: straight into the fight.
          this.complete(this.def.quests.crash);
          this.enter("fight");
          return;
        }
      }
      this.enter(want);
      return;
    }
    this.t += dt;
    this.barks();
    this.moveArcs();
    if (this.phase === "crash") this.tickCrash();
    else if (this.phase === "fight") this.tickFight();
    else if (this.phase === "rescue") this.tickRescue();
    else if (this.phase === "farewell") this.tickFarewell();
    this.tickBullets(dt);
    this.syncBoss();
  }

  private crossed(at: number, dt = 0.05): boolean {
    return this.t >= at && this.t - dt < at;
  }

  /** Move actors (and the player) along their hops. */
  private moveArcs(): void {
    const along = (a: Arc, o: { x: number; z: number }): boolean => {
      const s = Math.min(1, Math.max(0, (this.clock - a.t0) / a.dur));
      o.x = a.fromX + (a.toX - a.fromX) * s;
      o.z = a.fromZ + (a.toZ - a.fromZ) * s;
      return s >= 1;
    };
    for (const a of [this.falcon, this.bossActor]) {
      if (a.arc && along(a.arc, a)) a.arc = null;
    }
    const pa = this.playerArc;
    if (pa) {
      const p = this.host.player;
      p.path = [];
      if (along(pa, p)) this.playerArc = null;
    }
  }

  private tickCrash(): void {
    const d = this.def;
    const p = this.host.player;
    const b = this.bossActor;
    if (this.crossed(CRASH.comet)) this.events.push({ kind: "comet", x: d.impact.x, z: d.impact.z, dur: CRASH.land - CRASH.comet });
    if (this.crossed(CRASH.land)) {
      b.visible = true;
      b.pose = "stand";
      this.spawnBoss(b.x, b.z);
      this.face(b, p.x, p.z);
      this.events.push({ kind: "impact", x: d.impact.x, z: d.impact.z, size: 2.2 }, { kind: "shake", power: 1, dur: 1 });
      this.face(this.falcon, b.x, b.z);
    }
    if (this.crossed(CRASH.blast - 0.5)) b.pose = "channel";
    if (this.crossed(CRASH.blast)) {
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const dd = Math.hypot(dx, dz) || 1;
      this.events.push({ kind: "blast", x: b.x, z: b.z, dirX: dx / dd, dirZ: dz / dd }, { kind: "shake", power: 0.8, dur: 0.7 });
      this.playerArc = { fromX: p.x, fromZ: p.z, toX: d.playerLand.x, toZ: d.playerLand.z, t0: this.clock, dur: CRASH.fly, peak: 7 };
      this.hop(this.falcon, d.falconLand.x, d.falconLand.z, CRASH.fly * 1.08, 8);
      this.falcon.pose = "down";
      b.pose = "stand";
    }
    if (this.crossed(CRASH.blast + CRASH.fly)) {
      this.events.push({ kind: "impact", x: d.playerLand.x, z: d.playerLand.z, size: 0.8 }, { kind: "shake", power: 0.5, dur: 0.4 });
    }
    if (this.crossed(CRASH.debris)) {
      this.setFlag();
      this.events.push({ kind: "debris", dur: CRASH.debrisDur }, { kind: "shake", power: 0.35, dur: CRASH.debrisDur });
    }
    if (this.crossed(CRASH.debris + 1.4)) {
      this.falcon.pose = "stand";
      this.face(this.falcon, b.x, b.z);
    }
    if (this.crossed(CRASH.glide)) {
      // She steps off the cliff and drifts down into the arena.
      this.hop(b, d.bossHome.x, d.bossHome.z, CRASH.glideDur, 2.5);
      b.pose = "hover";
    }
    if (b.arc === null && this.t > CRASH.glide) this.face(b, p.x, p.z);
    if (this.t >= CRASH.end) {
      this.complete(d.quests.crash);
      this.enter("fight");
    }
  }

  // --- The fight -------------------------------------------------------------------------------

  private fire(kind: BulletKind, x: number, z: number, angle: number, speedMul = 1): void {
    const s = BULLET[kind].speed * speedMul;
    this.bullets.push({
      id: this.nextBullet++, kind, x, z, prevX: x, prevZ: z,
      vx: Math.sin(angle) * s, vz: Math.cos(angle) * s, r: BULLET[kind].r, age: 0, fuse: kind === "mine" ? 1.3 : 0,
    });
  }

  private aimAngle(fromX: number, fromZ: number): number {
    const p = this.host.player;
    return Math.atan2(p.x - fromX, p.z - fromZ);
  }

  /** Queue the next pattern. Density climbs the longer the fight goes. */
  private nextPattern(): void {
    const b = this.bossActor;
    const k = 1 + Math.min(1.1, this.t / 45);
    const at = this.t;
    const shots: Shot[] = [];
    const add = (dt: number, fire: () => void): void => {
      shots.push({ at: at + dt, fire });
    };
    const volley = (): void => {
      this.events.push({ kind: "volley", x: b.x, z: b.z });
    };
    const kinds = ["ring", "spiral", "fan", "mines", "flower", "curtain"] as const;
    const kind = kinds[this.patternN % kinds.length]!;
    this.patternN++;
    let dur = 3;
    if (kind === "ring") {
      const n = Math.round(16 * k);
      for (let w = 0; w < 4; w++) {
        add(w * 0.55, () => {
          volley();
          const off = (w % 2) * (Math.PI / n) + this.rand() * 0.2;
          for (let i = 0; i < n; i++) this.fire(w === 3 ? "big" : "orb", b.x, b.z, off + (i / n) * Math.PI * 2);
        });
      }
      dur = 2.6;
    } else if (kind === "spiral") {
      const arms = k > 1.5 ? 4 : 3;
      const spin = this.rand() < 0.5 ? 2.3 : -2.3;
      for (let i = 0; i < 34; i++) {
        add(i * 0.1, () => {
          if (i % 6 === 0) volley();
          for (let a = 0; a < arms; a++) this.fire("orb", b.x, b.z, i * 0.1 * spin + (a / arms) * Math.PI * 2, 0.95);
        });
      }
      dur = 3.8;
    } else if (kind === "fan") {
      const spread = 7 + Math.round(2 * (k - 1));
      for (let w = 0; w < 5; w++) {
        add(w * 0.42, () => {
          volley();
          const base = this.aimAngle(b.x, b.z);
          const arc = 0.95;
          for (let i = 0; i < spread; i++) this.fire("needle", b.x, b.z, base - arc / 2 + (i / (spread - 1)) * arc);
        });
      }
      dur = 2.5;
    } else if (kind === "mines") {
      const count = Math.round(5 * k);
      for (let i = 0; i < count; i++) {
        add(i * 0.28, () => {
          const p = this.host.player;
          const a = this.rand() * Math.PI * 2;
          const r = 1.2 + this.rand() * 3.5;
          const m = this.clampToArena(p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, 1.5);
          this.fire("mine", m.x, m.z, 0);
        });
      }
      add(0.2, volley);
      dur = count * 0.28 + 1.8;
    } else if (kind === "flower") {
      for (let i = 0; i < 26; i++) {
        add(i * 0.12, () => {
          if (i % 5 === 0) volley();
          for (let a = 0; a < 2; a++) {
            this.fire("orb", b.x, b.z, i * 0.12 * 2 + a * Math.PI, 1.05);
            this.fire("orb", b.x, b.z, -i * 0.12 * 2 + a * Math.PI + Math.PI / 2, 1.05);
          }
        });
      }
      dur = 3.6;
    } else {
      // Curtain: a wall of needles toward you with one gap to slip through.
      for (let w = 0; w < 3; w++) {
        add(w * 0.9, () => {
          volley();
          const base = this.aimAngle(b.x, b.z);
          const n = 15;
          const gap = 3 + Math.floor(this.rand() * (n - 6));
          const px = Math.cos(base);
          const pz = -Math.sin(base);
          for (let i = 0; i < n; i++) {
            if (i === gap || i === gap + 1) continue;
            const o = (i - (n - 1) / 2) * 0.85;
            this.fire("needle", b.x + px * o, b.z + pz * o, base, 0.62);
          }
        });
      }
      dur = 3.2;
    }
    this.shots = shots;
    this.patternEnd = at + dur;
  }

  private clampToArena(x: number, z: number, inset: number): { x: number; z: number } {
    const a = this.def.arena;
    const dx = x - a.x;
    const dz = z - a.z;
    const d = Math.hypot(dx, dz);
    const max = a.radius - inset;
    return d <= max ? { x, z } : { x: a.x + (dx / d) * max, z: a.z + (dz / d) * max };
  }

  /** Blink to a new spot, preferably across the arena from the player. */
  private blink(): void {
    const a = this.def.arena;
    const p = this.host.player;
    const b = this.bossActor;
    const away = Math.atan2(a.x - p.x, a.z - p.z);
    const ang = away + (this.rand() - 0.5) * 1.6;
    const r = a.radius * (0.45 + this.rand() * 0.2);
    const to = { x: a.x + Math.sin(ang) * r, z: a.z + Math.cos(ang) * r };
    this.events.push({ kind: "blink", fromX: b.x, fromZ: b.z, toX: to.x, toZ: to.z });
    this.place(b, to.x, to.z);
    this.face(b, p.x, p.z);
  }

  private tickFight(): void {
    const d = this.def;
    const p = this.host.player;
    const b = this.bossActor;
    const f = this.falcon;
    // Falcon fights for a few seconds, until she swats him away.
    if (!this.falconSwatted) {
      this.face(f, b.x, b.z);
      if (this.t >= this.falconShotAt && this.t < 6.2) {
        this.falconShotAt += 1.1;
        f.pose = "channel";
        this.events.push({ kind: "falconShot", fromX: f.x, fromZ: f.z, toX: b.x, toZ: b.z });
      }
      if (this.t >= 6.6) {
        this.falconSwatted = true;
        this.events.push({ kind: "blast", x: b.x, z: b.z, dirX: f.x - b.x, dirZ: f.z - b.z }, { kind: "impact", x: f.x, z: f.z, size: 0.9 });
        this.hop(f, d.falconRest.x, d.falconRest.z, 0.9, 3);
        f.pose = "down";
      }
    }
    if (b.arc === null) this.face(b, p.x, p.z);
    // Patterns, with a breather and a blink between them.
    for (const s of this.shots) if (s.at <= this.t) s.fire();
    this.shots = this.shots.filter((s) => s.at > this.t);
    if (this.shots.length === 0 && this.t >= this.patternEnd) {
      if (this.patternN > 0 && this.patternN % 2 === 0) this.blink();
      this.nextPattern();
      this.patternEnd += 0.7;
    }
    if (this.host.hp() <= d.rescueHp || this.t >= FIGHT_FAILSAFE) {
      this.complete(d.quests.fight);
      // Start the next quest now, so a reload mid-rescue still knows where it was.
      const qe = this.host.quests;
      if (qe.status(d.quests.rescue.quest) === "notStarted") qe.start(d.quests.rescue.quest);
      this.enter("rescue");
    }
  }

  private tickBullets(dt: number): void {
    const p = this.host.player;
    const a = this.def.arena;
    this.grace = Math.max(0, this.grace - dt);
    const hurt = this.phase === "fight";
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const u = this.bullets[i]!;
      u.prevX = u.x;
      u.prevZ = u.z;
      u.age += dt;
      if (u.kind === "mine") {
        u.fuse -= dt;
        if (u.fuse <= 0) {
          this.bullets.splice(i, 1);
          const off = this.rand() * Math.PI;
          for (let k = 0; k < 7; k++) this.fire("orb", u.x, u.z, off + (k / 7) * Math.PI * 2, 0.8);
        }
        continue;
      }
      u.x += u.vx * dt;
      u.z += u.vz * dt;
      if (u.age > 10 || Math.hypot(u.x - a.x, u.z - a.z) > a.radius + 5) {
        this.bullets.splice(i, 1);
        continue;
      }
      if (!hurt || this.grace > 0) continue;
      if (Math.hypot(u.x - p.x, u.z - p.z) <= u.r + PLAYER_R) {
        this.bullets.splice(i, 1);
        const dmg = Math.round(this.def.bulletDamage * (u.kind === "big" ? 1.6 : 1));
        this.host.setHp(Math.max(1, this.host.hp() - dmg));
        this.grace = this.def.hitGrace;
        this.events.push({ kind: "playerHit", x: p.x, z: p.z, amount: dmg });
      }
    }
  }

  /** Keep the player inside the debris ring while it matters. */
  confine(p: { x: number; z: number; path: Vec2[] }): void {
    if (this.phase !== "fight" && this.phase !== "rescue") return;
    const a = this.def.arena;
    const dx = p.x - a.x;
    const dz = p.z - a.z;
    const d = Math.hypot(dx, dz);
    const max = a.radius - 0.6;
    if (d <= max) return;
    p.x = a.x + (dx / d) * max;
    p.z = a.z + (dz / d) * max;
    p.path = [];
  }

  // --- Rescue & farewell -----------------------------------------------------------------------

  private tickRescue(): void {
    const p = this.host.player;
    const b = this.bossActor;
    const f = this.falcon;
    this.face(b, p.x, p.z);
    if (this.crossed(RESCUE.charge)) {
      b.pose = "channel";
      this.events.push({ kind: "charge", x: b.x, z: b.z, dur: RESCUE.chargeDur });
    }
    // Falcon throws himself between you and the blast.
    const dx = b.x - p.x;
    const dz = b.z - p.z;
    const dd = Math.hypot(dx, dz) || 1;
    const shield = { x: p.x + (dx / dd) * 1.3, z: p.z + (dz / dd) * 1.3 };
    if (this.crossed(RESCUE.leap)) {
      f.pose = "stand";
      this.hop(f, shield.x, shield.z, RESCUE.leapDur, 6);
      this.face(f, b.x, b.z);
    }
    if (this.crossed(RESCUE.fire)) {
      this.events.push(
        { kind: "beam", fromX: b.x, fromZ: b.z, toX: f.x, toZ: f.z },
        { kind: "impact", x: f.x, z: f.z, size: 1.6 },
        { kind: "shake", power: 1, dur: 0.8 },
      );
      b.pose = "hover";
      // Thrown back past you.
      this.hop(f, p.x - (dx / dd) * 1.1, p.z - (dz / dd) * 1.1, 0.5, 1.5);
      f.pose = "down";
    }
    if (this.t >= RESCUE.end) {
      this.complete(this.def.quests.rescue);
      this.enter("farewell");
    }
  }

  private tickFarewell(): void {
    const p = this.host.player;
    const b = this.bossActor;
    const f = this.falcon;
    this.face(b, p.x, p.z);
    // She walks toward you, unhurried.
    const dx = p.x - b.x;
    const dz = p.z - b.z;
    const d = Math.hypot(dx, dz);
    if (d > 3.2 && this.t > 2) {
      b.x += (dx / d) * 0.9 * 0.05;
      b.z += (dz / d) * 0.9 * 0.05;
    }
    if (this.crossed(FAREWELL.portal - 0.4)) f.pose = "channel";
    if (this.crossed(FAREWELL.portal)) this.events.push({ kind: "portal", x: p.x, z: p.z, dur: FAREWELL.portalDur });
    if (this.crossed(FAREWELL.flash)) this.events.push({ kind: "flash", fadeIn: 0.6, hold: 0.5, fadeOut: 1.6 });
    if (this.crossed(FAREWELL.warp)) {
      this.host.teleport(this.def.exit.x, this.def.exit.z);
      this.complete(this.def.quests.farewell);
      if (this.def.exitMessage) this.host.message(this.def.exitMessage);
      this.finish();
    }
  }
}
