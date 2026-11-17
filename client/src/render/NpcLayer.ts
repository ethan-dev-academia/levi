import * as THREE from "three";
import { propFacing, storeyY, type BuildingIndex, type Heightmap, type ModelDef, type NpcDef, type NpcSpawn } from "@levi/shared";
import type { BuildingLayer } from "./BuildingLayer.js";
import { CharacterEntity } from "./CharacterEntity.js";

/** Nametags show within this distance of the player. */
const NAMETAG_RANGE = 14;
const TAG_HEIGHT = 2.25;

interface PlacedNpc {
  spawn: NpcSpawn;
  def: NpcDef;
  entity: CharacterEntity;
  tag: HTMLElement;
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
      this.placed.push({ spawn, def, entity, tag, head: new THREE.Vector3(), yaw: Math.atan2(fx, fz) });
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
  ): void {
    const rect = this.tagHost.getBoundingClientRect();
    for (const p of this.placed) {
      const s = p.spawn;
      const live = position(s.id);
      const x = live ? live.x : s.x + 0.5;
      const z = live ? live.z : s.z + 0.5;
      const visible = s.storey === 0 || !s.building || buildings.isStoreyVisible(s.building, s.storey);
      p.entity.model.root.visible = visible;
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
      if (!p.tag.hidden) {
        p.tag.style.left = `${((this.v.x + 1) / 2) * rect.width}px`;
        p.tag.style.top = `${((1 - this.v.y) / 2) * rect.height}px`;
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
