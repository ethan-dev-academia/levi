import {
  advanceAlongPath,
  CombatWorld,
  StoryEncounter,
  type EncounterDef,
  type Respawn,
  NpcWalker,
  WEAPON_STYLE,
  type CombatEvent,
  type EnemyDef,
  type HitPayload,
  propFacing,
  QuestEngine,
  DISCIPLINE_NAMES,
  DISCIPLINES,
  MAX_PINNED,
  type Discipline,
  type QuestBanner,
  findPath,
  PLAYER_MOVE_SPEED,
  propFrontCell,
  stairLanding,
  TICK_SEC,
  type BuildingIndex,
  type Character,
  type ClimbIntent,
  type Result,
  type AbilitySlot,
  type CombatStyle,
  type SkillDef,
  type DialogueNode,
  type GroundItem,
  type Intent,
  type NpcDef,
  type NpcSpawn,
  type PropDef,
  type QuestDef,
  type PropInstance,
  type Mover,
  type Vec2,
  type WalkGrid,
} from "@levi/shared";

export interface PlayerState extends Mover {
  /** Position at the previous tick, for render interpolation. */
  prevX: number;
  prevZ: number;
  /** 0 = ground level (terrain + building ground floors). */
  storey: number;
  /** Building the player is inside when storey > 0. */
  building: string | null;
}

/** A big centred announcement: quest started/complete, or a level gained. */
export type Banner = QuestBanner | { kind: "level"; title: string; detail: string };

export interface SimEvents {
  message(text: string, kind?: "quest" | "system"): void;
  banner?(b: Banner): void;
}

/** A place on the map a pinned quest wants you to go. */
export interface QuestTarget {
  quest: string;
  x: number;
  z: number;
  /** What's there ("Falcon", "Mouse Meadow"). */
  label: string;
}

/** What the world around the sim provides (static content + map lookups). */
export interface SimWorld {
  map: string;
  propDefs: ReadonlyMap<string, PropDef>;
  npcs: ReadonlyMap<string, NpcDef>;
  quests: ReadonlyMap<string, QuestDef>;
  enemies: ReadonlyMap<string, EnemyDef>;
  /** Scripted story fights (content/encounters). */
  encounters: ReadonlyMap<string, EncounterDef>;
  /** Where you wake up after being knocked out (when no respawn point applies). */
  respawn: Vec2;
  /** Story-gated respawn points (the Cathedral after the prologue). Read live. */
  respawns?: () => readonly Respawn[];
  /** Region id at a point (for "reach" objectives). */
  regionAt(x: number, z: number): string | null;
  /** Every region containing a point (a town and the island around it): all count as discovered. */
  regionsAt?(x: number, z: number): string[];
}

/** An open conversation. */
export interface TalkState {
  spawn: NpcSpawn;
  npc: NpcDef;
  node: DialogueNode;
}

const MAX_FRIENDS = 200;

/** What you can't do while a cutscene plays. */
const LOCKED_OUT: ReadonlySet<Intent["type"]> = new Set(["move", "climb", "cast", "attack", "talk", "useItem", "pickup", "lootTake"]);


/** Within this distance of a stair's access cell centre counts as "there". */
const CLIMB_REACH = 0.75;

interface PendingClimb {
  building: string;
  storey: number;
  access: Vec2;
  arrive: Vec2;
  verb: string;
}

/**
 * Offline stand-in for the server's simulation. Consumes the SAME validated
 * intents and runs the SAME shared movement/pathing code at TICK_RATE.
 * Step 2 moves this logic into the Colyseus room and the client switches to
 * rendering interpolated server snapshots.
 */
export class LocalSim {
  readonly player: PlayerState;
  private climb: PendingClimb | null = null;
  private ticks = 0;
  private combatUntil = 0;
  /** Bumped on every change to the character (UI redraws on change). */
  version = 0;
  readonly quests: QuestEngine;
  /** The conversation in progress, if any. */
  talk: TalkState | null = null;
  private region: string | null = null;
  /** Live NPC positions (wandering ones move; others stay on their tile). */
  private walkers = new Map<string, NpcWalker>();
  private walkerSource: readonly NpcSpawn[] | null = null;
  readonly combat: CombatWorld;
  /** Things the client shows (damage numbers...). Drained each frame. */
  combatEvents: CombatEvent[] = [];
  /** Auto-attack target (enemy spawn id). */
  attackTarget: string | null = null;
  private attackCd = 0;
  private attackRepath = 0;
  /** Skill id → tick it's ready again. */
  private readyAt = new Map<string, number>();
  /** Sprint: running faster until this tick, by this fraction. */
  private sprintUntil = 0;
  private sprintBoost = 0;
  /** Cooldown length (ticks) of each skill's last use, for the HUD sweep. */
  private cdLength = new Map<string, number>();
  /** Scripted story fights (the prologue's Alpha fight). */
  readonly encounters: StoryEncounter[] = [];
  /** Last known level per discipline (to announce level-ups from any source). */
  private readonly levels = new Map<Discipline, number>();
  private markerCache: { version: number; marks: Map<string, "!" | "?" | null> } = { version: -1, marks: new Map() };

  constructor(
    private readonly ground: WalkGrid,
    private readonly buildings: BuildingIndex,
    spawn: Vec2,
    private readonly events: SimEvents,
    readonly character: Character,
    private readonly world: SimWorld,
  ) {
    this.quests = new QuestEngine(character, { quests: world.quests, npcs: world.npcs }, (t, k, b) => {
      events.message(t, k);
      if (b) events.banner?.(b);
    });
    for (const d of DISCIPLINES) this.levels.set(d, character.level(d));
    // Sprint and friends start on their keys (once; unbinding is respected).
    character.ensureAdventuringKit();
    // Older saves: put active quests on the tracker if nothing is pinned.
    if (character.save.pinned.length === 0) {
      character.save.pinned = Object.keys(character.save.quests).filter((id) => this.quests.status(id) === "active" && world.quests.has(id)).slice(-MAX_PINNED).reverse();
    }
    this.combat = new CombatWorld(world.enemies, 7);
    this.player = {
      x: spawn.x, z: spawn.z, prevX: spawn.x, prevZ: spawn.z, path: [], dirX: 0, dirZ: 1, storey: 0, building: null,
    };
    for (const def of world.encounters.values()) {
      this.encounters.push(
        new StoryEncounter(def, {
          player: this.player,
          quests: this.quests,
          flags: () => character.save.worldFlags,
          hp: () => character.save.vitals.hp,
          setHp: (v) => {
            character.save.vitals.hp = v;
            this.enterCombat(8);
          },
          combat: this.combat,
          boss: world.enemies.get(def.boss),
          npcPos: (npc) => {
            const s = this.buildings.npcs.find((n) => n.npc === npc);
            return s ? { x: s.x, z: s.z } : null;
          },
          talking: () => this.talk !== null,
          teleport: (x, z) => this.teleport(x, z),
          message: (t) => events.message(t, "system"),
        }),
      );
    }
  }

  /** A cutscene beat is playing: the player can't act. */
  get locked(): boolean {
    return this.encounters.some((e) => e.locked);
  }

  /** The story encounter playing right now, if any. */
  get encounter(): StoryEncounter | null {
    return this.encounters.find((e) => e.active) ?? null;
  }

  /** Walk grid of the storey the player is on. */
  private grid(): WalkGrid {
    const p = this.player;
    if (p.storey === 0 || !p.building) return this.ground;
    return this.buildings.get(p.building)?.grids[p.storey] ?? this.ground;
  }

  apply(intent: Intent): void {
    if (this.locked && LOCKED_OUT.has(intent.type)) return;
    switch (intent.type) {
      case "move": {
        this.climb = null;
        this.attackTarget = null;
        if (this.talk) this.endTalk(false);
        const path = findPath(this.grid(), this.player, { x: intent.targetX, z: intent.targetZ });
        if (path.length === 0) this.events.message("I can't reach that!");
        this.player.path = path;
        break;
      }
      case "climb":
        this.startClimb(intent);
        break;
      case "stop":
        this.climb = null;
        this.player.path = [];
        break;
      case "cast":
        this.cast(intent.slot, intent.aimX, intent.aimZ);
        break;
      case "attack":
        this.attackTarget = this.combat.enemies.has(intent.enemy) ? intent.enemy : null;
        this.climb = null;
        if (this.talk) this.endTalk(false);
        break;
      case "useItem":
        this.report(this.character.use({ area: "hot", index: intent.slot - 1 }));
        break;
      case "useSlot":
        this.report(this.character.use(intent.from, intent.discipline));
        break;
      case "moveItem":
        this.report(this.character.move(intent.from, intent.to, this.inCombat));
        break;
      case "equip":
        this.report(this.character.equip(intent.from, this.inCombat));
        break;
      case "unequip":
        this.report(this.character.unequip(intent.slot, this.inCombat));
        break;
      case "unlockSkill":
        this.report(this.character.unlockSkill(intent.style, intent.skill, this.inCombat));
        break;
      case "resetSkills":
        this.report(this.character.resetTree(intent.style, this.inCombat));
        break;
      case "setLoadout":
        this.report(this.character.setLoadout(intent.style, intent.key, intent.skill, this.inCombat));
        break;
      case "lootTake":
        this.report(this.takeLoot(intent.prop, intent.index));
        break;
      case "talk":
        this.startTalk(intent.npc);
        break;
      case "talkNext":
        this.talkNext(intent.option);
        break;
      case "talkEnd":
        this.endTalk(false);
        break;
      case "pickup":
        this.report(this.pickup(intent.item));
        break;
      case "pinQuest":
        this.report(this.pin(intent.quest, intent.pinned));
        break;
      case "beat": {
        const flag = `seen-${intent.beat}`;
        if (!this.character.save.worldFlags.includes(flag)) this.character.save.worldFlags.push(flag);
        this.version++;
        break;
      }
      case "addFriend":
      case "removeFriend":
        this.report(this.friend(intent.type === "addFriend", intent.name));
        break;
    }
  }

  /** Container prop + its slot count, if `id` is one. */
  container(id: string): { prop: PropInstance; slots: number; key: string } | null {
    const prop = this.buildings.props.find((p) => p.id === id);
    const def = prop ? this.world.propDefs.get(prop.prop) : undefined;
    if (!prop || !def?.container) return null;
    return { prop, slots: def.container.slots, key: `${this.world.map}:${prop.id}` };
  }

  /** Next to it (8 neighbours or on it) and on the same storey/building. */
  isBeside(prop: PropInstance): boolean {
    const p = this.player;
    if (p.storey !== prop.storey) return false;
    if (prop.storey > 0 && p.building !== prop.building) return false;
    return Math.max(Math.abs(Math.floor(p.x) - prop.x), Math.abs(Math.floor(p.z) - prop.z)) <= 1;
  }

  /**
   * Where to stand to use a container: the cell in front of it. If that cell
   * can't be stood on (walled in), any neighbouring cell will do.
   */
  useCell(prop: PropInstance): [number, number] | null {
    const front = propFrontCell(prop);
    return this.grid().isWalkable(front[0], front[1]) ? front : null;
  }

  /** In position to use this container (front cell, or beside it when the front is blocked). */
  canUse(prop: PropInstance): boolean {
    if (!this.isBeside(prop)) return false;
    const front = this.useCell(prop);
    return !front || (Math.floor(this.player.x) === front[0] && Math.floor(this.player.z) === front[1]);
  }

  /** Turn to look at a cell (cosmetic; e.g. when opening a chest). */
  faceCell(cx: number, cz: number): void {
    const p = this.player;
    const dx = cx + 0.5 - p.x;
    const dz = cz + 0.5 - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) {
      p.dirX = dx / d;
      p.dirZ = dz / d;
    }
  }

  private takeLoot(id: string, index: number): Result {
    const c = this.container(id);
    if (!c) return { ok: false, msg: "There's nothing to take." };
    if (!this.canUse(c.prop)) return { ok: false, msg: "Open it from the front." };
    if (index >= c.slots) return { ok: false, msg: "There's nothing there." };
    const r = this.character.takeFromContainer(c.key, c.prop.loot ?? [], c.slots, index);
    if (r.ok) this.quests.event({ kind: "use", prop: c.prop.prop });
    return r;
  }

  /** The character was changed from outside the intent pipeline: redraw. */
  markChanged(): void {
    this.version++;
  }

  /** Content changed under us (dev item editor): stats and menus re-derive. */
  contentChanged(): void {
    this.character.invalidate();
    this.version++;
  }

  // --- NPCs & dialogue -----------------------------------------------------------------------

  /** Next to a placed thing (8 neighbours or on it), same storey/building. */
  private near(t: { x: number; z: number; storey: number; building?: string | undefined }, reach = 1): boolean {
    const p = this.player;
    if (p.storey !== t.storey) return false;
    if (t.storey > 0 && p.building !== t.building) return false;
    return Math.max(Math.abs(Math.floor(p.x) - t.x), Math.abs(Math.floor(p.z) - t.z)) <= reach;
  }

  /** NPC walkers, rebuilt whenever the placed NPCs change (dev edits). */
  npcWalkers(): ReadonlyMap<string, NpcWalker> {
    const list = this.buildings.npcs;
    if (list !== this.walkerSource) {
      const old = this.walkers;
      this.walkers = new Map();
      for (const s of list) {
        const prev = old.get(s.id);
        const w = new NpcWalker(s, propFacing(s.rot));
        // Keep walking from where they were if only settings changed.
        if (prev && prev.spawn.storey === s.storey && s.wander !== "none") {
          w.x = w.prevX = prev.x;
          w.z = w.prevZ = prev.z;
        }
        this.walkers.set(s.id, w);
      }
      this.walkerSource = list;
    }
    return this.walkers;
  }

  /** Where an NPC stands right now, as a tile target. */
  npcTarget(spawn: NpcSpawn): { x: number; z: number; storey: number; building?: string | undefined } {
    const w = this.npcWalkers().get(spawn.id);
    const [x, z] = w ? w.cell() : [spawn.x, spawn.z];
    return { x, z, storey: spawn.storey, building: spawn.building };
  }

  /** NPC standing on a cell right now (wanderers included). */
  npcOnCell(cx: number, cz: number, storey: number, building: string | null): NpcSpawn | undefined {
    for (const w of this.npcWalkers().values()) {
      const s = w.spawn;
      if (!this.npcShown(s)) continue;
      if (s.storey !== storey || (storey > 0 && s.building !== building)) continue;
      const [x, z] = w.cell();
      if (x === cx && z === cz) return s;
    }
    return undefined;
  }

  private tickNpcs(): void {
    const p = this.player;
    const walkers = this.npcWalkers();
    const pcx = Math.floor(p.x);
    const pcz = Math.floor(p.z);
    for (const w of walkers.values()) {
      const s = w.spawn;
      const grid = s.storey > 0 && s.building ? this.buildings.get(s.building)?.grids[s.storey] ?? this.ground : this.ground;
      const held = this.talk?.spawn.id === s.id;
      w.tick(TICK_SEC, grid, held, (cx, cz) => {
        if (cx === pcx && cz === pcz && p.storey === s.storey) return true;
        for (const o of walkers.values()) {
          if (o === w || o.spawn.storey !== s.storey || !this.npcShown(o.spawn)) continue;
          const [ox, oz] = o.cell();
          if (ox === cx && oz === cz) return true;
        }
        return false;
      });
    }
  }

  private startTalk(spawnId: string): void {
    const spawn = this.buildings.npcs.find((n) => n.id === spawnId);
    const npc = spawn ? this.world.npcs.get(spawn.npc) : undefined;
    if (!spawn || !npc || !this.npcShown(spawn)) return;
    if (!this.near(this.npcTarget(spawn))) {
      this.events.message("You need to be next to them.");
      return;
    }
    const node = this.quests.entryNode(npc);
    if (!node) {
      this.events.message(`${npc.name} has nothing to say right now.`);
      return;
    }
    this.player.path = [];
    this.climb = null;
    this.talk = { spawn, npc, node };
    this.enterNode(node);
  }

  private enterNode(node: DialogueNode): void {
    const t = this.talk;
    if (!t) return;
    t.node = node;
    for (const e of node.effects) this.quests.apply(e);
    this.quests.event({ kind: "talk", npc: t.npc.id, node: node.id });
    this.version++;
  }

  /** option = index into node.options, or -1 for "continue". */
  private talkNext(option: number): void {
    const t = this.talk;
    if (!t) return;
    const visible = this.quests.options(t.node);
    let next: string | null;
    if (visible.length > 0) {
      const pick = visible.find((v) => v.index === option);
      if (!pick) return; // must choose one of the offered options
      for (const e of pick.option.effects) this.quests.apply(e);
      next = pick.option.next;
    } else {
      next = t.node.next;
    }
    const node = next ? t.npc.nodes.find((n) => n.id === next) : undefined;
    if (!node) this.endTalk(true);
    else this.enterNode(node);
  }

  /** `finished` = the conversation reached its end (counts for "talk" objectives). */
  private endTalk(finished: boolean): void {
    const t = this.talk;
    if (!t) return;
    this.talk = null;
    if (finished) this.quests.event({ kind: "talk", npc: t.npc.id, ended: true });
    this.version++;
  }

  // --- Ground items ------------------------------------------------------------------------------

  private groundKey(g: GroundItem): string {
    return `${this.world.map}:${g.id}`;
  }

  /** Still lying there for this player? */
  /**
   * What floats over an NPC: "?" = a quest wants you to talk to them now,
   * "!" = they have a quest for you. Recomputed only when something changed.
   */
  npcMarker(spawn: NpcSpawn): "!" | "?" | null {
    if (this.markerCache.version !== this.version) this.markerCache = { version: this.version, marks: new Map() };
    const cached = this.markerCache.marks.get(spawn.npc);
    if (cached !== undefined) return cached;
    const mark = this.computeMarker(spawn.npc);
    this.markerCache.marks.set(spawn.npc, mark);
    return mark;
  }

  private computeMarker(npcId: string): "!" | "?" | null {
    const q = this.quests;
    for (const id of Object.keys(this.character.save.quests)) {
      const def = this.world.quests.get(id);
      const step = def ? q.step(def) : null;
      if (!def || !step) continue;
      for (const o of step.objectives) if (o.kind === "talk" && o.npc === npcId && !q.objectiveDone(def, o)) return "?";
    }
    const npc = this.world.npcs.get(npcId);
    const start = npc ? q.entryNode(npc) : null;
    if (!npc || !start) return null;
    // Walk the conversation that would open: does it offer a quest you can take?
    const seen = new Set<string>();
    const todo = [start.id];
    while (todo.length && seen.size < 40) {
      const next = todo.pop();
      const node = npc.nodes.find((n) => n.id === next);
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      const effects = [...node.effects, ...node.options.filter((o) => q.checkAll(o.when)).flatMap((o) => o.effects)];
      for (const e of effects) {
        if (e.kind !== "startQuest" || q.status(e.quest) !== "notStarted") continue;
        const def = this.world.quests.get(e.quest);
        if (def && q.missing(def).length === 0) return "!";
      }
      if (node.next) todo.push(node.next);
      for (const o of node.options) if (o.next && q.checkAll(o.when)) todo.push(o.next);
    }
    return null;
  }

  /** Where the pinned quests' current objectives point (minimap / world map markers). */
  questTargets(): QuestTarget[] {
    const out: QuestTarget[] = [];
    const q = this.quests;
    for (const id of this.character.save.pinned) {
      const def = this.world.quests.get(id);
      const step = def ? q.step(def) : null;
      if (!def || !step) continue;
      for (const o of step.objectives) {
        if (q.objectiveDone(def, o)) continue;
        if (o.kind === "talk") {
          const s = this.buildings.npcs.find((n) => n.npc === o.npc && this.npcShown(n));
          if (s) {
            const t = this.npcTarget(s);
            out.push({ quest: id, x: t.x + 0.5, z: t.z + 0.5, label: this.world.npcs.get(o.npc)?.name ?? o.npc });
          }
        } else if (o.kind === "defeat") {
          for (const zn of this.buildings.zones) {
            if (!zn.mobs.some((m) => m.enemy === o.enemy) || zn.cells.length === 0) continue;
            let sx = 0, sz = 0;
            for (const [cx, cz] of zn.cells) { sx += cx; sz += cz; }
            out.push({ quest: id, x: sx / zn.cells.length + 0.5, z: sz / zn.cells.length + 0.5, label: zn.name });
          }
          for (const e of this.buildings.enemies) if (e.enemy === o.enemy) out.push({ quest: id, x: e.x + 0.5, z: e.z + 0.5, label: this.world.enemies.get(o.enemy)?.name ?? o.enemy });
        } else if (o.kind === "pickup" || o.kind === "collect") {
          for (const g of this.buildings.groundItems) if (g.item === o.item && this.isGroundItemAvailable(g)) out.push({ quest: id, x: g.x + 0.5, z: g.z + 0.5, label: this.character.def(o.item)?.name ?? o.item });
        } else if (o.kind === "use") {
          for (const p of this.buildings.props) if (p.prop === o.prop) out.push({ quest: id, x: p.x + 0.5, z: p.z + 0.5, label: this.world.propDefs.get(o.prop)?.name ?? o.prop });
        }
      }
    }
    return out;
  }

  /** Is this placed prop in the world right now (quest-gated rubble...)? */
  propShown(p: PropInstance): boolean {
    return !p.visibleWhen?.length || this.quests.checkAll(p.visibleWhen);
  }

  isGroundItemAvailable(g: GroundItem): boolean {
    return !this.character.save.pickedUp.includes(this.groundKey(g)) && this.quests.checkAll(g.visibleWhen);
  }

  /** Is this placed NPC in the world right now (quest-gated placements)? */
  npcShown(spawn: NpcSpawn): boolean {
    if (this.encounters.some((e) => e.ownsFalcon && e.def.falconNpc === spawn.npc)) return false;
    return spawn.visibleWhen.length === 0 || this.quests.checkAll(spawn.visibleWhen);
  }

  private pickup(id: string): Result {
    const g = this.buildings.groundItems.find((x) => x.id === id);
    if (!g || !this.isGroundItemAvailable(g)) return { ok: false, msg: "There's nothing there." };
    if (!this.near(g)) return { ok: false, msg: "You need to be closer." };
    const def = this.character.def(g.item);
    if (!def) return { ok: false, msg: "There's nothing there." };
    const left = this.character.addItem(g.item, g.qty);
    if (left === g.qty) return { ok: false, msg: "Your bag is full." };
    this.character.save.pickedUp.push(this.groundKey(g));
    this.quests.event({ kind: "pickup", item: g.item, qty: g.qty - left });
    return { ok: true, msg: `You pick up ${g.qty - left > 1 ? `${g.qty - left}× ` : "the "}${def.name}.${left ? " (Bag full: some was left.)" : ""}` };
  }

  // --- Quest tracker pins ------------------------------------------------------------------------

  private pin(questId: string, pinned: boolean): Result {
    const list = this.character.save.pinned;
    if (!pinned) {
      this.character.save.pinned = list.filter((q) => q !== questId);
      return { ok: true };
    }
    if (list.includes(questId)) return { ok: true };
    if (this.quests.status(questId) !== "active") return { ok: false, msg: "Only active quests can be pinned." };
    if (list.length >= MAX_PINNED) return { ok: false, msg: `You can pin ${MAX_PINNED} quests at a time. Unpin one first.` };
    list.push(questId);
    return { ok: true };
  }

  // --- Combat ------------------------------------------------------------------------------------------

  /** Which stat a style's hits scale with. */
  private payload(style: CombatStyle, base: number, ratio: number, scaling: "attack" | "magic" | "none"): HitPayload {
    const st = this.character.stats;
    const stat = scaling === "magic" ? st.magicDamage : scaling === "attack" ? st.attackDamage : 0;
    return { base, ratio, stat, critChance: st.critChance, critMultiplier: st.critMultiplier, style };
  }

  /** Seconds → ticks, after cooldown reduction. */
  private cdTicks(seconds: number): number {
    return Math.round((seconds * (1 - this.character.stats.cooldownReduction / 100)) / TICK_SEC);
  }

  /** 0 = ready … 1 = just used, for the skill on a key. */
  cooldownFraction(slot: AbilitySlot): number {
    const b = this.character.barSlot(slot);
    if (!b) return 0;
    const ready = this.readyAt.get(b.skill.id) ?? 0;
    const len = this.cdLength.get(b.skill.id) ?? 1;
    return Math.max(0, Math.min(1, (ready - this.ticks) / len));
  }

  private cast(slot: AbilitySlot, aimX: number, aimZ: number): void {
    const c = this.character;
    const b = c.barSlot(slot);
    const weapon = { mage: "a staff or wand", ranger: "a bow or gun", brawler: "a sword or dagger" } as const;
    if (!b) return this.events.message(`Nothing is on ${slot}. Drag a skill there from a skill tree.`);
    const s = b.skill;
    const style = b.style;
    if (style === "adventuring") return this.castAdventuring(s);
    if (!b.usable) return this.events.message(`${b.skill.name} needs ${weapon[style]}.`);
    if (s.cast.kind !== "line") return this.events.message(`${s.name} isn't ready to use yet (coming soon).`);
    if ((this.readyAt.get(s.id) ?? 0) > this.ticks) return; // still cooling down: silent, the HUD shows it
    const pool = c.poolFor(style);
    if (c.save.vitals[pool] < s.cost) return this.events.message(`Not enough ${pool}.`);
    const p = this.player;
    const dx = aimX - p.x;
    const dz = aimZ - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    c.save.vitals[pool] -= s.cost;
    const len = this.cdTicks(s.cooldown);
    this.readyAt.set(s.id, this.ticks + len);
    this.cdLength.set(s.id, Math.max(1, len));
    p.dirX = dx / d;
    p.dirZ = dz / d;
    const speed = style === "mage" ? 18 : style === "ranger" ? 26 : 32;
    this.combatEvents.push({ kind: "cast", style, x: p.x, z: p.z, dirX: p.dirX, dirZ: p.dirZ, skill: true, melee: false });
    this.combat.fire({
      x: p.x + p.dirX * 0.4, z: p.z + p.dirZ * 0.4, dirX: p.dirX, dirZ: p.dirZ, speed,
      left: s.cast.range, width: Math.max(0.3, s.cast.width), pierce: s.cast.pierce, homing: null,
      payload: this.payload(style, s.cast.damage, s.cast.ratio, s.cast.scaling), visual: style,
    });
    this.version++;
  }

  /** Adventuring skills: no weapon needed, paid from whichever pool your weapon uses. */
  private castAdventuring(s: SkillDef): void {
    if ((this.readyAt.get(s.id) ?? 0) > this.ticks) return;
    if (s.cast.kind !== "sprint") return this.events.message(`${s.name} isn't ready to use yet (coming soon).`);
    if (this.locked) return;
    const c = this.character;
    const pool = c.poolFor("adventuring");
    if (c.save.vitals[pool] < s.cost) return this.events.message(`Not enough ${pool}.`);
    c.save.vitals[pool] -= s.cost;
    const len = this.cdTicks(s.cooldown);
    this.readyAt.set(s.id, this.ticks + len);
    this.cdLength.set(s.id, Math.max(1, len));
    this.sprintUntil = this.ticks + Math.round(s.cast.duration / TICK_SEC);
    this.sprintBoost = s.cast.amount / 100;
    this.version++;
  }

  /** Seconds of sprint left (0 = walking). */
  get sprintLeft(): number {
    return Math.max(0, (this.sprintUntil - this.ticks) * TICK_SEC);
  }

  /** Auto-attack range: ranged weapons (staff, wand, bow, gun) reach further. */
  private attackRange(): number {
    const w = this.character.save.equipment.weapon;
    const t = w ? this.character.def(w.item)?.weaponType : undefined;
    return t === "staff" || t === "wand" || t === "bow" || t === "gun" ? 7 : 1.7;
  }

  private tickAttack(): void {
    this.attackCd = Math.max(0, this.attackCd - TICK_SEC);
    const id = this.attackTarget;
    const e = id ? this.combat.enemies.get(id) : undefined;
    const p = this.player;
    if (!e || e.mode === "dead" || p.storey !== 0) {
      this.attackTarget = null;
      return;
    }
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    const range = this.attackRange() + this.combat.radius(e);
    if (d > range) {
      this.attackRepath -= TICK_SEC;
      if (this.attackRepath <= 0 || p.path.length === 0) {
        p.path = findPath(this.ground, p, { x: e.x, z: e.z }, { maxExpansions: 6000, snapRadius: 2 });
        this.attackRepath = 0.3;
      }
      return;
    }
    p.path = [];
    p.dirX = (e.x - p.x) / (d || 1);
    p.dirZ = (e.z - p.z) / (d || 1);
    if (this.attackCd > 0) return;
    this.attackCd = 1.2;
    const style = this.character.style;
    const pay = this.payload(style, 3, 0.6, style === "mage" ? "magic" : "attack");
    this.combatEvents.push({ kind: "cast", style, x: p.x, z: p.z, dirX: p.dirX, dirZ: p.dirZ, skill: false, melee: this.attackRange() <= 2 });
    if (this.attackRange() > 2) {
      this.combat.fire({ x: p.x, z: p.z, dirX: p.dirX, dirZ: p.dirZ, speed: 16, left: 99, width: 0.3, pierce: false, homing: e.spawn.id, payload: pay, visual: style });
    } else {
      this.combat.hitEnemy(e, pay);
    }
  }

  private tickCombat(): void {
    const p = this.player;
    const c = this.character;
    this.combat.sync(this.buildings.enemies, this.buildings.zones, this.ground);
    this.tickAttack();
    this.combat.tick(
      TICK_SEC,
      this.ground,
      { x: p.x, z: p.z, onGround: p.storey === 0, alive: c.save.vitals.hp > 0, armour: c.stats.armour },
      (amount) => {
        c.save.vitals.hp = Math.max(0, c.save.vitals.hp - amount);
        this.enterCombat(8);
      },
    );
    for (const ev of this.combat.drainEvents()) {
      this.combatEvents.push(ev);
      if (ev.kind === "damage" && ev.target === "enemy") this.enterCombat(8);
      if (ev.kind === "dummyHit") {
        // Dummies teach the basics only: no XP past level 2, so they can't be farmed.
        if (c.level(ev.style) < 3 && c.addXp(ev.style, 2) > 0) this.events.message(`${DISCIPLINE_NAMES[ev.style]} level ${c.level(ev.style)}!`, "quest");
        this.version++;
      }
      if (ev.kind === "kill") {
        const gained = c.addXp(ev.style, ev.enemy.xp);
        this.events.message(`You defeat the ${ev.enemy.name}. +${ev.enemy.xp} ${DISCIPLINE_NAMES[ev.style]} XP`);
        if (gained > 0) this.events.message(`${DISCIPLINE_NAMES[ev.style]} level ${c.level(ev.style)}!`, "quest");
        this.quests.event({ kind: "defeat", enemy: ev.enemy.id });
        if (this.attackTarget === ev.spawn) this.attackTarget = null;
        this.version++;
      }
    }
    if (c.save.vitals.hp <= 0 && this.encounter) c.save.vitals.hp = 1; // story fights end on their own terms
    if (c.save.vitals.hp <= 0) {
      // Knocked out: wake at the respawn point, nothing lost.
      const wake = this.respawnPoint();
      this.events.message(`You're knocked out... and wake up at ${wake.name}.`, "system");
      this.teleport(wake.x, wake.z);
      const st = c.stats;
      c.save.vitals.hp = st.maxHp;
      c.save.vitals.mana = st.maxMana;
      c.save.vitals.energy = st.maxEnergy;
      this.combat.calmAll();
      this.attackTarget = null;
      this.version++;
    }
  }

  /** Where you'd wake up right now: the first respawn point whose conditions pass. */
  respawnPoint(): { x: number; z: number; name: string } {
    for (const r of this.world.respawns?.() ?? []) if (this.quests.checkAll(r.when)) return r;
    return { ...this.world.respawn, name: "the Landing" };
  }

  /** In combat: gear, hotbar and skills are locked. */
  get inCombat(): boolean {
    return this.ticks < this.combatUntil;
  }

  /** Seconds of combat lock left (0 = free). */
  get combatSecondsLeft(): number {
    return Math.max(0, (this.combatUntil - this.ticks) * TICK_SEC);
  }

  /** Called by combat (next step) whenever you deal or take damage. */
  enterCombat(seconds: number): void {
    this.combatUntil = Math.max(this.combatUntil, this.ticks + Math.round(seconds / TICK_SEC));
    this.version++;
  }

  private report(r: Result): void {
    if (r.msg) this.events.message(r.msg);
    if (r.ok) {
      this.quests.event({ kind: "inventory" });
      this.version++;
    }
  }

  private friend(add: boolean, name: string): Result {
    const list = this.character.save.friends;
    const key = name.trim().toLowerCase();
    const i = list.findIndex((f) => f.toLowerCase() === key);
    if (!add) {
      if (i < 0) return { ok: false, msg: `${name} isn't on your friends list.` };
      list.splice(i, 1);
      return { ok: true, msg: `${name} was removed from your friends list.` };
    }
    if (key === this.character.save.name.toLowerCase()) return { ok: false, msg: "You can't add yourself." };
    if (i >= 0) return { ok: false, msg: `${name} is already on your friends list.` };
    if (list.length >= MAX_FRIENDS) return { ok: false, msg: "Your friends list is full." };
    list.push(name.trim());
    return { ok: true, msg: `${name.trim()} was added to your friends list.` };
  }

  /** Validate a climb, then walk to the stair's access cell (climbs on arrival). */
  private startClimb(intent: ClimbIntent): void {
    const p = this.player;
    const info = this.buildings.get(intent.building);
    const stair = info?.def.stairs.find((s) => s.id === intent.stair);
    if (!info || !stair) return;
    if (p.storey > 0 && p.building !== info.def.id) return;

    const canUp = p.storey >= stair.from && p.storey < stair.to;
    const canDown = p.storey > stair.from && p.storey <= stair.to;
    // The clicked half is a preference; fall back to the only possible way.
    const dir = intent.dir === "up" ? (canUp ? "up" : canDown ? "down" : null) : canDown ? "down" : canUp ? "up" : null;
    if (!dir) {
      this.events.message("You can't climb that from here.");
      return;
    }

    const grid = this.grid();
    const target = p.storey + (dir === "up" ? 1 : -1);
    const targetGrid = target === 0 ? this.ground : info.grids[target];
    const from = stairLanding(grid, stair, dir === "up" ? "bottom" : "top");
    const to = targetGrid ? stairLanding(targetGrid, stair, dir === "up" ? "top" : "bottom") : null;
    if (!from || !to) {
      this.events.message(dir === "up" ? "There's nowhere to stand up there." : "There's nowhere to stand down there.");
      return;
    }
    const access = grid.cellCenter(from[0], from[1]);
    const path = findPath(grid, p, access);
    if (path.length === 0 && Math.hypot(p.x - access.x, p.z - access.z) > CLIMB_REACH) {
      this.events.message("I can't reach that!");
      return;
    }
    p.path = path;
    const thing = stair.kind === "ladder" ? "ladder" : "stairs";
    this.climb = {
      building: info.def.id,
      storey: target,
      access,
      arrive: grid.cellCenter(to[0], to[1]),
      verb: `You climb ${dir} the ${thing}.`,
    };
  }

  /** Dev-only helper (the real server exposes this as an admin command). */
  teleport(x: number, z: number): void {
    const p = this.player;
    p.x = p.prevX = x;
    p.z = p.prevZ = z;
    p.path = [];
    p.storey = 0;
    p.building = null;
    this.climb = null;
  }

  tick(): void {
    const p = this.player;
    this.ticks++;
    if (this.ticks === this.combatUntil) this.version++; // combat lock just ended
    this.character.regen(TICK_SEC);
    p.prevX = p.x;
    p.prevZ = p.z;
    if (this.locked) p.path = [];
    advanceAlongPath(p, PLAYER_MOVE_SPEED * (this.ticks < this.sprintUntil ? 1 + this.sprintBoost : 1) * TICK_SEC);
    for (const e of this.encounters) e.confine(p);
    this.tickNpcs();
    this.tickCombat();
    for (const d of DISCIPLINES) {
      const lvl = this.character.level(d);
      const was = this.levels.get(d) ?? lvl;
      if (lvl > was) this.events.banner?.({ kind: "level", title: `${DISCIPLINE_NAMES[d]} level ${lvl}`, detail: "" });
      this.levels.set(d, lvl);
    }
    for (const e of this.encounters) {
      const wasLocked = e.locked;
      e.tick(TICK_SEC);
      if (wasLocked !== e.locked) {
        this.attackTarget = null;
        this.version++;
      }
    }
    if (this.talk && (p.path.length > 0 || !this.near(this.npcTarget(this.talk.spawn)))) this.endTalk(false);
    const region = this.world.regionAt(p.x, p.z);
    if (region !== this.region) {
      this.region = region;
      if (region) {
        this.quests.event({ kind: "reach", region });
        for (const id of this.world.regionsAt?.(p.x, p.z) ?? [region]) {
          const key = `${this.world.map}:${id}`;
          if (!this.character.save.discovered.includes(key)) this.character.save.discovered.push(key);
        }
        this.version++;
      }
    }
    const loc = this.character.save.location;
    loc.x = p.x;
    loc.z = p.z;
    loc.storey = p.storey;
    if (p.building) loc.building = p.building;
    else delete loc.building;

    const c = this.climb;
    if (c && p.path.length === 0) {
      this.climb = null;
      if (Math.hypot(p.x - c.access.x, p.z - c.access.z) <= CLIMB_REACH) {
        p.storey = c.storey;
        p.building = c.storey > 0 ? c.building : null;
        p.x = p.prevX = c.arrive.x;
        p.z = p.prevZ = c.arrive.z;
        this.events.message(c.verb);
      } else {
        this.events.message("I can't reach that!");
      }
    }
  }

  /** Remaining waypoints' final point, if moving. */
  destination(): Vec2 | null {
    return this.player.path[this.player.path.length - 1] ?? null;
  }
}
