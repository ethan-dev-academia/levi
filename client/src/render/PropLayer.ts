import * as THREE from "three";
import { storeyY, type BuildingIndex, type Heightmap, type ModelDef, type PropDef, type PropInstance } from "@levi/shared";
import type { BuildingLayer } from "./BuildingLayer.js";
import { buildModel, type BuiltModel } from "./ModelBuilder.js";

interface PlacedProp {
  inst: PropInstance;
  model: BuiltModel;
  /** Trees: current opacity and their own material (faded per tree). */
  fade?: { mat: THREE.MeshLambertMaterial; alpha: number; radius: number; height: number } | undefined;
  /** Falling into place (rockfall): seconds to wait, then seconds into the fall. */
  drop?: { wait: number; t: number; spin: number } | undefined;
}

/** How high dropped props start, and how long the fall takes. */
const DROP_HEIGHT = 26;
const DROP_TIME = 0.7;

/** Opacity of a tree you're standing under or that hides you. Much lower than roofs: you barely see it. */
const UNDER_TREE_OPACITY = 0.08;
const FADE_RATE = 8;

/** Stable 0..1 hash of a string (+ salt), for per-placement variety. */
function hash01(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * This placement's own version of a nature model: canopy lumps shift and
 * resize, the whole tree stretches taller or squatter, and each colour slot
 * drifts a little in hue and lightness. Same species, never the same tree.
 */
function varyModel(def: ModelDef, seed: string): ModelDef {
  let n = 0;
  const r = (): number => hash01(seed, 100 + n++);
  const palette: Record<string, string> = {};
  const c = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  for (const [slot, hex] of Object.entries(def.palette)) {
    c.set(hex).getHSL(hsl);
    c.setHSL((hsl.h + (r() - 0.5) * 0.06 + 1) % 1, Math.min(1, Math.max(0, hsl.s * (0.85 + r() * 0.3))), Math.min(1, Math.max(0, hsl.l * (0.88 + r() * 0.24))));
    palette[slot] = `#${c.getHexString()}`;
  }
  const stretch = 0.85 + r() * 0.4;
  const parts = def.parts.map((p) => {
    // Anything sitting up off the ground (canopy lumps, upper tiers, branches) wanders a bit.
    const high = p.pos[1] > 0.6;
    const k = high ? 0.8 + r() * 0.45 : 0.92 + r() * 0.16;
    const j = high ? 0.35 : 0;
    return {
      ...p,
      pos: [p.pos[0] * 1.1 + (r() - 0.5) * j, p.pos[1] * stretch, p.pos[2] * 1.1 + (r() - 0.5) * j] as [number, number, number],
      rings: p.rings.map(([y, rx, rz]) => [y * (high ? 1 : stretch), rx * k, rz * k] as [number, number, number]),
      rot: [p.rot[0] + (r() - 0.5) * (high ? 14 : 4), p.rot[1] + r() * 360 * (high ? 1 : 0), p.rot[2] + (r() - 0.5) * (high ? 14 : 4)] as [number, number, number],
      phase: p.phase + r() * 60,
    };
  });
  return { ...def, palette, parts };
}

/** A whole model baked into one vertex-coloured geometry (one draw call per placement). */
function bakeModel(def: ModelDef): THREE.BufferGeometry {
  const built = buildModel(def);
  built.root.updateMatrixWorld(true);
  const pos: number[] = [];
  const col: number[] = [];
  built.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = (o.geometry as THREE.BufferGeometry).toNonIndexed().applyMatrix4(o.matrixWorld);
    const c = (o.material as THREE.MeshLambertMaterial).color;
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
  });
  built.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  out.computeBoundingBox();
  return out;
}

/**
 * Every placed prop as a 3D model. Props on a building's upper storeys hide
 * with that storey (OSRS-style cutaway), and readable ones can be picked.
 */
export class PropLayer {
  readonly group = new THREE.Group();
  private placed: PlacedProp[] = [];
  private readonly raycaster = new THREE.Raycaster();
  /** Baked nature models, shared by every placement of that model. */
  private readonly baked = new Map<string, THREE.BufferGeometry>();

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
    // Forget the baked shapes of props that are gone.
    const live = new Set(this.index.props.map((p) => `${p.id}|${this.models.get(this.defs.get(p.prop)?.model ?? "")?.id}`));
    for (const [k, g] of this.baked) {
      if (live.has(k)) continue;
      g.dispose();
      this.baked.delete(k);
    }
    for (const inst of this.index.props) {
      const def = this.defs.get(inst.prop);
      const modelDef = def && this.models.get(def.model);
      if (!modelDef) continue;
      if (def.category === "nature") {
        this.placeNature(inst, def, modelDef);
        continue;
      }
      const model = buildModel(modelDef);
      model.root.position.set(inst.x + 0.5, this.baseY(inst), inst.z + 0.5);
      model.root.rotation.y = (-inst.rot * Math.PI) / 2;
      model.root.userData = { propId: inst.id };
      this.group.add(model.root);
      this.placed.push({ inst, model });
    }
  }

  /**
   * Trees, rocks, flowers: one merged mesh each, with a random turn, size and
   * tint per placement so a grove never looks copy-pasted.
   */
  private placeNature(inst: PropInstance, def: PropDef, modelDef: ModelDef): void {
    // Each placement gets its own shape and colours (cached by placement + model, so rebuilds are cheap).
    const key = `${inst.id}|${modelDef.id}`;
    let geom = this.baked.get(key);
    if (!geom) this.baked.set(key, (geom = bakeModel(varyModel(modelDef, inst.id))));
    const tint = 0.92 + hash01(inst.id, 3) * 0.14;
    const warm = (hash01(inst.id, 4) - 0.5) * 0.08;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, color: new THREE.Color(tint + warm, tint, tint - warm) });
    const mesh = new THREE.Mesh(geom, mat);
    const root = new THREE.Group();
    root.add(mesh);
    const scale = 0.82 + hash01(inst.id, 1) * 0.4;
    root.scale.setScalar(scale);
    // Small offset inside the cell too, so rows of trees don't line up on the grid.
    const ox = (hash01(inst.id, 5) - 0.5) * 0.35;
    const oz = (hash01(inst.id, 6) - 0.5) * 0.35;
    root.position.set(inst.x + 0.5 + ox, this.baseY(inst) - 0.05, inst.z + 0.5 + oz);
    root.rotation.y = hash01(inst.id, 2) * Math.PI * 2 + (-inst.rot * Math.PI) / 2;
    root.userData = { propId: inst.id };
    this.group.add(root);
    const model: BuiltModel = { root, joints: {}, dispose: () => mat.dispose() };
    const height = (geom.boundingBox?.max.y ?? 3) * scale;
    this.placed.push({ inst, model, fade: def.fade ? { mat, alpha: 1, radius: def.canopy * scale, height } : undefined });
  }

  /**
   * Hide props on storeys the building layer has cut away, and fade trees
   * that you're standing under or that stand between you and the camera.
   */
  update(
    buildings: BuildingLayer,
    viewer?: { x: number; z: number; y: number },
    camera?: THREE.Vector3,
    dt = 0,
    shown?: (inst: PropInstance) => boolean,
  ): void {
    for (const p of this.placed) {
      const { inst, model } = p;
      model.root.visible =
        (inst.storey === 0 || !inst.building || buildings.isStoreyVisible(inst.building, inst.storey)) && (!inst.visibleWhen?.length || !shown || shown(inst));
      if (p.drop) this.tickDrop(p, dt);
      const f = p.fade;
      if (!f || !viewer || !camera) continue;
      const tx = model.root.position.x;
      const tz = model.root.position.z;
      const dx = viewer.x - tx;
      const dz = viewer.z - tz;
      let hide = dx * dx + dz * dz < (f.radius + 0.6) * (f.radius + 0.6);
      if (!hide) {
        // Between you and the camera: the camera→you ray passes through the canopy.
        const cx = camera.x - viewer.x, cy = camera.y - viewer.y, cz = camera.z - viewer.z;
        const len2 = cx * cx + cy * cy + cz * cz;
        const ty = model.root.position.y + f.height * 0.65;
        const t = Math.max(0, Math.min(1, ((tx - viewer.x) * cx + (ty - viewer.y) * cy + (tz - viewer.z) * cz) / (len2 || 1)));
        const qx = viewer.x + cx * t - tx, qy = viewer.y + cy * t - ty, qz = viewer.z + cz * t - tz;
        hide = t > 0.02 && qx * qx + qz * qz + qy * qy * 0.4 < f.radius * f.radius;
      }
      const target = hide ? UNDER_TREE_OPACITY : 1;
      f.alpha += (target - f.alpha) * (1 - Math.exp(-dt * FADE_RATE));
      const fading = f.alpha < 0.995;
      f.mat.opacity = f.alpha;
      if (f.mat.transparent !== fading) {
        f.mat.transparent = fading;
        f.mat.depthWrite = !fading;
        f.mat.needsUpdate = true;
      }
    }
  }

  /**
   * Rockfall: the matching props fall out of the sky over `spread` seconds
   * (each lands with `onLand`, for dust and shake).
   */
  dropIn(match: (inst: PropInstance) => boolean, spread: number, onLand?: (x: number, z: number, y: number) => void): void {
    this.onLand = onLand ?? null;
    for (const p of this.placed) {
      if (match(p.inst)) p.drop = { wait: hash01(p.inst.id, 9) * spread, t: 0, spin: (hash01(p.inst.id, 10) - 0.5) * 6 };
    }
  }

  private onLand: ((x: number, z: number, y: number) => void) | null = null;

  private tickDrop(p: PlacedProp, dt: number): void {
    const d = p.drop!;
    const root = p.model.root;
    const base = this.baseY(p.inst) - (p.fade !== undefined || this.defs.get(p.inst.prop)?.category === "nature" ? 0.05 : 0);
    if (d.wait > 0) {
      d.wait -= dt;
      root.visible = false;
      root.position.y = base + DROP_HEIGHT;
      return;
    }
    d.t += dt;
    const s = Math.min(1, d.t / DROP_TIME);
    root.position.y = base + DROP_HEIGHT * (1 - s * s);
    root.rotation.x = (1 - s) * d.spin * 0.3;
    root.rotation.z = (1 - s) * d.spin * 0.2;
    if (s >= 1) {
      p.drop = undefined;
      root.rotation.x = root.rotation.z = 0;
      root.position.y = base;
      this.onLand?.(root.position.x, root.position.z, base);
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
