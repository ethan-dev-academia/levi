import * as THREE from "three";
import { storeyY, type BuildingIndex, type Heightmap, type ModelDef, type PropDef, type PropInstance } from "@levi/shared";
import type { BuildingLayer } from "./BuildingLayer.js";
import { buildModel, type BuiltModel } from "./ModelBuilder.js";

interface PlacedProp {
  inst: PropInstance;
  model: BuiltModel;
}

/**
 * Every placed prop as a 3D model. Props on a building's upper storeys hide
 * with that storey (OSRS-style cutaway), and readable ones can be picked.
 */
export class PropLayer {
  readonly group = new THREE.Group();
  private placed: PlacedProp[] = [];
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly index: BuildingIndex,
    private readonly hm: Heightmap,
    private readonly models: ReadonlyMap<string, ModelDef>,
    private readonly defs: ReadonlyMap<string, PropDef>,
  ) {
    this.group.name = "props";
    this.rebuild();
  }

  /** World height a prop stands at. */
  baseY(p: PropInstance): number {
    const b = p.building ? this.index.get(p.building) : undefined;
    if (p.storey > 0 && b) return storeyY(b.def, p.storey);
    return this.index.groundHeight(this.hm, p.x + 0.5, p.z + 0.5);
  }

  /** Re-create all prop meshes (after edits or terrain changes). */
  rebuild(): void {
    for (const p of this.placed) {
      this.group.remove(p.model.root);
      p.model.dispose();
    }
    this.placed = [];
    for (const inst of this.index.props) {
      const def = this.defs.get(inst.prop);
      const modelDef = def && this.models.get(def.model);
      if (!modelDef) continue;
      const model = buildModel(modelDef);
      model.root.position.set(inst.x + 0.5, this.baseY(inst), inst.z + 0.5);
      model.root.rotation.y = (-inst.rot * Math.PI) / 2;
      model.root.userData = { propId: inst.id };
      this.group.add(model.root);
      this.placed.push({ inst, model });
    }
  }

  /** Hide props on storeys the building layer has cut away. */
  update(buildings: BuildingLayer): void {
    for (const { inst, model } of this.placed) {
      model.root.visible = inst.storey === 0 || !inst.building || buildings.isStoreyVisible(inst.building, inst.storey);
    }
  }

  /** Visible prop under the cursor. */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number): PropInstance | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const roots = this.placed.filter((p) => p.model.root.visible).map((p) => p.model.root);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData["propId"] === undefined) o = o.parent;
    const id = o?.userData["propId"] as string | undefined;
    return this.placed.find((p) => p.inst.id === id)?.inst ?? null;
  }

  def(inst: PropInstance): PropDef | undefined {
    return this.defs.get(inst.prop);
  }
}
