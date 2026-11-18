import * as THREE from "three";
import { propFacing, storeyY, type BuildingIndex, type Heightmap, type ModelDef, type NpcDef, type NpcSpawn } from "@levi/shared";
import type { BuildingLayer } from "./BuildingLayer.js";
import { CharacterEntity } from "./CharacterEntity.js";

/** Townsfolk mutter to themselves when you come this close. */
const CHATTER_RANGE = 4.5;
/** Quest marks (! ?) show within this distance. */
const MARK_RANGE = 70;
/** Nametags show within this distance of the player. */
const NAMETAG_RANGE = 14;
const TAG_HEIGHT = 2.25;

interface PlacedNpc {
  spawn: NpcSpawn;
  def: NpcDef;
  entity: CharacterEntity;
  tag: HTMLElement;
  /** Floating ! / ? when a quest involves them. */
  mark: HTMLElement;
  /** Idle chatter bubble, its time left, and when they may speak again. */
  bubble: HTMLElement;
  talkLeft: number;
  quietUntil: number;
  /** World point the tag / dialogue box anchors to. */
  head: THREE.Vector3;
  yaw: number;
}

/**
 * NPCs in the world: the shared faceted body with their own palette, an
 * idle stance on their tile, and an HTML nametag (white) when you're near.
 * Turns to face the player while talking to them.
 */
export class NpcLayer {
  /** Seconds since start (chatter cooldowns). */
  private clock = 0;
  readonly group = new THREE.Group();
  private placed: PlacedNpc[] = [];
  private readonly v = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly index: BuildingIndex,
    private readonly hm: Heightmap,
    private readonly npcs: ReadonlyMap<string, NpcDef>,
    private readonly models: ReadonlyMap<string, ModelDef>,
    private readonly tagHost: HTMLElement,
  ) {
    this.group.name = "npcs";
    this.rebuild();
  }

  private baseY(s: NpcSpawn): number {
    const b = s.building ? this.index.get(s.building) : undefined;
    if (s.storey > 0 && b) return storeyY(b.def, s.storey);
    return this.index.groundHeight(this.hm, s.x + 0.5, s.z + 0.5);
  }

  /** Recreate every NPC (after placement edits or NPC definition changes). */
  rebuild(): void {
    for (const p of this.placed) {
      p.entity.dispose();
      this.group.remove(p.entity.model.root);
      p.tag.remove();
      p.mark.remove();
      p.bubble.remove();
    }
    this.group.clear();
    this.placed = [];
    for (const spawn of this.index.npcs) {
      const def = this.npcs.get(spawn.npc);
      if (!def) continue;
      // "Same person as": borrow that NPC's look (model, colours, size).
      const look = (def.looksLike && this.npcs.get(def.looksLike)) || def;
      const model = this.models.get(look.model);
      if (!model) continue;
      const entity = new CharacterEntity(model, look.palette);
      entity.model.root.scale.setScalar(look.scale);
      entity.addTo(this.group);
      entity.model.root.userData = { npcSpawn: spawn.id };
      const tag = document.createElement("div");
      tag.className = "nametag npc";
      const name = document.createElement("b");
      name.textContent = def.name;
      tag.append(name);
      if (def.title) {
        const t = document.createElement("span");
        t.textContent = def.title;
        tag.append(t);
      }
      tag.hidden = true;
      this.tagHost.append(tag);
      const [fx, fz] = propFacing(spawn.rot);
      const mark = document.createElement("div");
      mark.className = "npc-mark";
      mark.hidden = true;
      this.tagHost.append(mark);
      const bubble = document.createElement("div");
      bubble.className = "npc-bubble";
      bubble.hidden = true;
      this.tagHost.append(bubble);
      this.placed.push({ spawn, def, entity, tag, mark, bubble, talkLeft: 0, quietUntil: Math.random() * 6, head: new THREE.Vector3(), yaw: Math.atan2(fx, fz) });
    }
  }

  /**
   * Per frame: idle animation, facing, nametags. `talkingTo` = spawn id of the
   * NPC in conversation (turns toward the player).
   */
  update(
    camera: THREE.Camera,
    player: { x: number; z: number },
    talkingTo: string | null,
    buildings: BuildingLayer,
    dt: number,
    /** Live position (wandering NPCs); null = standing on their spot. */
    position: (spawnId: string) => { x: number; z: number; dirX: number; dirZ: number; home: boolean } | null,
    /** Quest-gated NPCs that aren't around right now are hidden. */
    shown: (spawnId: string) => boolean = () => true,
    /** "!" = has a quest for you, "?" = a quest wants you to talk to them. */
    marker: (spawnId: string) => "!" | "?" | null = () => null,
  ): void {
    const rect = this.tagHost.getBoundingClientRect();
    this.clock += dt;
    for (const p of this.placed) {
      const s = p.spawn;
      const live = position(s.id);
      const x = live ? live.x : s.x + 0.5;
      const z = live ? live.z : s.z + 0.5;
      const visible = shown(s.id) && (s.storey === 0 || !s.building || buildings.isStoreyVisible(s.building, s.storey));
      p.entity.setVisible(visible);
      let dirX = live && !live.home ? live.dirX : Math.sin(p.yaw);
      let dirZ = live && !live.home ? live.dirZ : Math.cos(p.yaw);
      if (talkingTo === s.id) {
        const dx = player.x - x;
        const dz = player.z - z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-3) {
          dirX = dx / d;
          dirZ = dz / d;
        }
      }
      const fixedY = s.storey > 0 ? this.baseY(s) : null;
      const heightAt = (hx: number, hz: number): number => fixedY ?? this.index.groundHeight(this.hm, hx, hz);
      const y = heightAt(x, z);
      p.entity.update(heightAt, x, z, dirX, dirZ, dt);
      p.head.set(x, y + TAG_HEIGHT * p.entity.model.root.scale.y, z);

      // Nametag: projected to screen, only when close and in front of the camera.
      const near = visible && Math.hypot(player.x - x, player.z - z) < NAMETAG_RANGE;
      this.v.copy(p.head).project(camera);
      const onScreen = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      p.tag.hidden = !(near && onScreen) || talkingTo === s.id;
      const sx = ((this.v.x + 1) / 2) * rect.width;
      const sy = ((1 - this.v.y) / 2) * rect.height;
      if (!p.tag.hidden) {
        p.tag.style.left = `${sx}px`;
        p.tag.style.top = `${sy}px`;
      }
      // Idle chatter: a line now and then when you pass close by.
      const dist = Math.hypot(player.x - x, player.z - z);
      if (p.talkLeft > 0) p.talkLeft -= dt;
      else if (visible && dist < CHATTER_RANGE && talkingTo === null && this.clock >= p.quietUntil && p.def.chatter.length > 0) {
        p.bubble.textContent = p.def.chatter[Math.floor(Math.random() * p.def.chatter.length)]!;
        p.talkLeft = 4.5;
        p.quietUntil = this.clock + 25 + Math.random() * 20;
      }
      p.bubble.hidden = !(p.talkLeft > 0 && onScreen && visible && talkingTo !== s.id);
      if (!p.bubble.hidden) {
        p.bubble.style.left = `${sx}px`;
        p.bubble.style.top = `${sy - (p.tag.hidden ? 8 : 38)}px`;
      }
      // Quest marks show from much further away than names, so you can spot who to see.
      const m = visible && onScreen && talkingTo !== s.id && Math.hypot(player.x - x, player.z - z) < MARK_RANGE ? marker(s.id) : null;
      p.mark.hidden = !m;
      if (m) {
        if (p.mark.textContent !== m) p.mark.textContent = m;
        p.mark.classList.toggle("turnin", m === "?");
        p.mark.style.left = `${sx}px`;
        p.mark.style.top = `${sy - (p.tag.hidden ? 4 : 34)}px`;
      }
    }
  }

  /** Screen position (px in the tag host) of an NPC's head, for the dialogue box. */
  headOnScreen(spawnId: string, camera: THREE.Camera): { x: number; y: number } | null {
    const p = this.placed.find((n) => n.spawn.id === spawnId);
    if (!p) return null;
    const rect = this.tagHost.getBoundingClientRect();
    this.v.copy(p.head).project(camera);
    if (this.v.z >= 1) return null;
    return { x: ((this.v.x + 1) / 2) * rect.width, y: ((1 - this.v.y) / 2) * rect.height };
  }

  /** NPC under the cursor (by its model). */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number): NpcSpawn | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const roots = this.placed.filter((p) => p.entity.model.root.visible).map((p) => p.entity.model.root);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o.userData["npcSpawn"] === undefined) o = o.parent;
    const id = o?.userData["npcSpawn"] as string | undefined;
    return this.placed.find((p) => p.spawn.id === id)?.spawn ?? null;
  }

  def(spawn: NpcSpawn): NpcDef | undefined {
    return this.npcs.get(spawn.npc);
  }
}
