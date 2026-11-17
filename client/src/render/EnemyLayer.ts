import * as THREE from "three";
import { lerp, type BuildingIndex, type CombatWorld, type EnemyState, type Heightmap, type ModelDef } from "@levi/shared";
import { CharacterEntity } from "./CharacterEntity.js";

const TAG_RANGE = 16;

interface Shown {
  entity: CharacterEntity;
  tag: HTMLElement;
  hpFill: HTMLElement;
  head: THREE.Vector3;
  defId: string;
}

/**
 * Enemies as 3D characters with a nametag (name + level) and an HP bar that
 * appears once they're hurt or fighting. Positions come from the combat
 * sim, interpolated between ticks.
 */
export class EnemyLayer {
  readonly group = new THREE.Group();
  private readonly shown = new Map<string, Shown>();
  private readonly v = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly index: BuildingIndex,
    private readonly hm: Heightmap,
    private readonly models: ReadonlyMap<string, ModelDef>,
    private readonly tagHost: HTMLElement,
  ) {
    this.group.name = "enemies";
  }

  private make(e: EnemyState): Shown | null {
    const model = this.models.get(e.def.model);
    if (!model) return null;
    const entity = new CharacterEntity(model, e.def.palette);
    entity.model.root.scale.setScalar(e.def.scale);
    entity.model.root.userData = { enemy: e.spawn.id };
    entity.addTo(this.group);
    const tag = document.createElement("div");
    tag.className = "nametag enemy";
    const name = document.createElement("b");
    name.textContent = e.def.name;
    const lvl = document.createElement("span");
    lvl.textContent = e.def.dummy ? "Training" : `Level ${e.def.level}`;
    const bar = document.createElement("div");
    bar.className = "hpbar";
    const hpFill = document.createElement("div");
    bar.append(hpFill);
    tag.append(name, lvl, bar);
    this.tagHost.append(tag);
    return { entity, tag, hpFill, head: new THREE.Vector3(), defId: e.def.id };
  }

  private drop(id: string): void {
    const s = this.shown.get(id);
    if (!s) return;
    this.group.remove(s.entity.model.root);
    s.entity.dispose();
    s.tag.remove();
    this.shown.delete(id);
  }

  /** Recreate every enemy model (after definitions change). */
  rebuild(): void {
    for (const id of [...this.shown.keys()]) this.drop(id);
  }

  update(world: CombatWorld, camera: THREE.Camera, player: { x: number; z: number }, alpha: number, dt: number): void {
    for (const id of [...this.shown.keys()]) {
      const e = world.enemies.get(id);
      if (!e || e.def.id !== this.shown.get(id)!.defId) this.drop(id);
    }
    const rect = this.tagHost.getBoundingClientRect();
    for (const e of world.enemies.values()) {
      let s = this.shown.get(e.spawn.id);
      if (!s) {
        const made = this.make(e);
        if (!made) continue;
        this.shown.set(e.spawn.id, (s = made));
      }
      const alive = e.mode !== "dead";
      s.entity.setVisible(alive);
      if (!alive) {
        s.tag.hidden = true;
        continue;
      }
      const x = lerp(e.prevX, e.x, alpha);
      const z = lerp(e.prevZ, e.z, alpha);
      const heightAt = (hx: number, hz: number): number => this.index.groundHeight(this.hm, hx, hz);
      s.entity.update(heightAt, x, z, e.dirX, e.dirZ, dt);
      const top = (e.def.dummy ? 2.05 : 1.2 + 0.9 * e.def.scale) * (e.def.model === "humanoid" ? 1.45 : 1);
      s.head.set(x, heightAt(x, z) + top, z);

      const hurt = e.hp < e.def.stats.maxHp || e.mode === "chase" || e.mode === "windup";
      const near = Math.hypot(player.x - x, player.z - z) < TAG_RANGE;
      this.v.copy(s.head).project(camera);
      const onScreen = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      s.tag.hidden = !onScreen || !(near || hurt);
      if (!s.tag.hidden) {
        s.tag.style.left = `${((this.v.x + 1) / 2) * rect.width}px`;
        s.tag.style.top = `${((1 - this.v.y) / 2) * rect.height}px`;
        s.tag.classList.toggle("hurt", hurt);
        s.hpFill.style.width = `${Math.max(0, (e.hp / e.def.stats.maxHp) * 100)}%`;
      }
    }
  }

  /** Living enemy under the cursor (by its model). */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number): string | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const roots = [...this.shown.values()].filter((s) => s.entity.model.root.visible).map((s) => s.entity.model.root);
    let o: THREE.Object3D | null = this.raycaster.intersectObjects(roots, true)[0]?.object ?? null;
    while (o && o.userData["enemy"] === undefined) o = o.parent;
    return (o?.userData["enemy"] as string | undefined) ?? null;
  }

  /**
   * Living enemy nearest the cursor on screen, within `px` pixels of its
   * body: small or far-away enemies are still easy to click.
   */
  pickNear(camera: THREE.Camera, ndcX: number, ndcY: number, px = 40): string | null {
    const rect = this.tagHost.getBoundingClientRect();
    const cx = ((ndcX + 1) / 2) * rect.width;
    const cy = ((1 - ndcY) / 2) * rect.height;
    let best: string | null = null;
    let bd = px;
    for (const [id, s] of this.shown) {
      const root = s.entity.model.root;
      if (!root.visible) continue;
      // Test a few points up the body so tall and short enemies both work.
      for (const h of [0.15, 0.5, 0.9]) {
        this.v.copy(root.position);
        this.v.y += h * (s.head.y - root.position.y);
        this.v.project(camera);
        if (this.v.z >= 1) continue;
        const d = Math.hypot(((this.v.x + 1) / 2) * rect.width - cx, ((1 - this.v.y) / 2) * rect.height - cy);
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
    }
    return best;
  }

  /** Screen point of an enemy's head (damage numbers start here). */
  headOf(id: string): THREE.Vector3 | null {
    return this.shown.get(id)?.head ?? null;
  }
}
