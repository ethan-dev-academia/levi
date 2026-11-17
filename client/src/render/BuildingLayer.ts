import * as THREE from "three";
import type { BuildingIndex, BuildingInfo, Heightmap } from "@levi/shared";
import { buildBuildingView, MaterialCache, type BuildingView, type StairPick } from "./BuildingMesh.js";

/** Roof opacity while the player is inside (top storey). */
const INSIDE_ROOF_OPACITY = 0.14;
const FADE_RATE = 9;

export interface ViewerState {
  x: number;
  z: number;
  storey: number;
  building: string | null;
}

/** Dev build mode: show one building cut away down to the storey being edited. */
export interface EditView {
  building: string | null;
  storey: number;
}

function containsCell(info: BuildingInfo, cx: number, cz: number): boolean {
  const b = info.bounds;
  return cx >= b.cx0 && cz >= b.cz0 && cx <= b.cx1 && cz <= b.cz1;
}

/**
 * All building meshes. Each frame it cuts buildings away for the viewer:
 * inside a building, storeys above yours are hidden and the roof fades,
 * so you can always see yourself (OSRS-style).
 */
export class BuildingLayer {
  readonly group = new THREE.Group();
  private readonly views = new Map<string, BuildingView>();
  private readonly mats = new MaterialCache();
  private readonly raycaster = new THREE.Raycaster();
  private readonly roofAlpha = new Map<string, number>();
  /** Highest visible storey per building this frame (Infinity = all). */
  private readonly shownUpTo = new Map<string, number>();
  editView: EditView | null = null;

  constructor(
    private readonly index: BuildingIndex,
    private readonly hm: Heightmap,
  ) {
    this.group.name = "buildings";
    this.rebuildAll();
  }

  rebuildAll(): void {
    for (const id of [...this.views.keys()]) this.drop(id);
    for (const info of this.index.all()) this.add(info);
  }

  /** Rebuild one building after an edit (or remove it if it's gone). */
  rebuild(id: string): void {
    this.drop(id);
    const info = this.index.get(id);
    if (info) this.add(info);
  }

  private add(info: BuildingInfo): void {
    const view = buildBuildingView(info, this.hm, this.mats);
    this.views.set(info.def.id, view);
    this.group.add(view.group);
  }

  private drop(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.group);
    v.dispose();
    this.views.delete(id);
  }

  /**
   * `camera` is the eye position: inside a building, wall lines on the
   * camera's side of the player are cut down so the player stays visible.
   */
  update(viewer: ViewerState, camera: THREE.Vector3, dt: number): void {
    const cx = Math.floor(viewer.x);
    const cz = Math.floor(viewer.z);
    for (const [id, view] of this.views) {
      const info = this.index.get(id);
      if (!info) continue;
      let showUpTo = Infinity;
      let roofTarget = 1;
      let cutStorey = -1;
      const edit = this.editView;
      if (edit && edit.building === id) {
        showUpTo = edit.storey;
        roofTarget = 0;
      } else if (viewer.building === id || (viewer.storey === 0 && containsCell(info, cx, cz))) {
        showUpTo = viewer.storey;
        cutStorey = viewer.storey;
        // Below the top storey the roof would float over hidden floors: hide it.
        roofTarget = viewer.storey >= view.topStorey ? INSIDE_ROOF_OPACITY : 0;
      }
      view.storeys.forEach((g, k) => (g.visible = k <= showUpTo));
      this.shownUpTo.set(id, showUpTo);
      view.wallLines.forEach((lines, k) => {
        for (const l of lines) {
          const between =
            k === cutStorey &&
            (l.axis === "x" ? (l.coord - viewer.z) * (camera.z - viewer.z) > 0 : (l.coord - viewer.x) * (camera.x - viewer.x) > 0);
          l.full.visible = !between;
          l.cut.visible = between;
        }
      });

      const prev = this.roofAlpha.get(id) ?? 1;
      const a = prev + (roofTarget - prev) * (1 - Math.exp(-dt * FADE_RATE));
      this.roofAlpha.set(id, a);
      view.roof.visible = a > 0.02;
      for (const m of view.roofMaterials) {
        m.opacity = a;
        const fading = a < 0.995;
        if (m.transparent !== fading) {
          m.transparent = fading;
          m.depthWrite = !fading;
          m.needsUpdate = true;
        }
      }
    }
  }

  isStoreyVisible(building: string, storey: number): boolean {
    return storey <= (this.shownUpTo.get(building) ?? Infinity);
  }

  /** First visible stair/ladder flight under the cursor, with the hit point. */
  pickStair(camera: THREE.Camera, ndcX: number, ndcY: number): (StairPick & { point: THREE.Vector3 }) | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const meshes: THREE.Object3D[] = [];
    for (const v of this.views.values()) {
      if (!v.group.visible) continue;
      for (const m of v.stairMeshes) if (m.parent?.visible) meshes.push(m);
    }
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    return { ...(hit.object.userData as StairPick), point: hit.point.clone() };
  }

  /** Ray hit on the floor plane of `storey` of a building (for walking upstairs). */
  pickFloor(camera: THREE.Camera, ndcX: number, ndcY: number, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.drop(id);
    this.mats.dispose();
  }
}
