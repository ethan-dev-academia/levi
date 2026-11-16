import * as THREE from "three";
import type { FacetRing, ModelDef, PartRole } from "@levi/shared";

export interface BuiltModel {
  /** Origin at the feet, facing +Z. */
  root: THREE.Group;
  /** Joint groups by animation role, for the animator. */
  joints: Partial<Record<PartRole, THREE.Group>>;
  dispose(): void;
}

const DEG = Math.PI / 180;

/**
 * Faceted lathe: `sides` vertices per ring, each ring rotated half a step
 * from the previous one so the wall is all triangles (antiprism), plus flat
 * caps on open ends. Flat-shaded by the material.
 */
export function facetGeometry(sides: number, rings: readonly FacetRing[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const step = (Math.PI * 2) / sides;

  rings.forEach(([y, rx, rz], r) => {
    const twist = (r % 2) * step * 0.5;
    for (let s = 0; s < sides; s++) {
      const a = s * step + twist;
      pos.push(Math.sin(a) * rx, y, Math.cos(a) * rz);
    }
  });
  const v = (r: number, s: number): number => r * sides + (((s % sides) + sides) % sides);

  for (let r = 0; r < rings.length - 1; r++) {
    // Even ring → next ring is offset by +half step; odd ring → by −half step.
    const fwd = r % 2 === 0;
    for (let s = 0; s < sides; s++) {
      if (fwd) {
        idx.push(v(r, s), v(r, s + 1), v(r + 1, s));
        idx.push(v(r + 1, s), v(r, s + 1), v(r + 1, s + 1));
      } else {
        idx.push(v(r, s), v(r, s + 1), v(r + 1, s + 1));
        idx.push(v(r, s), v(r + 1, s + 1), v(r + 1, s));
      }
    }
  }

  const capBottom = rings[0]!;
  if (capBottom[1] > 0 || capBottom[2] > 0) {
    const c = pos.length / 3;
    pos.push(0, capBottom[0], 0);
    for (let s = 0; s < sides; s++) idx.push(c, v(0, s + 1), v(0, s));
  }
  const last = rings.length - 1;
  const capTop = rings[last]!;
  if (capTop[1] > 0 || capTop[2] > 0) {
    const c = pos.length / 3;
    pos.push(0, capTop[0], 0);
    for (let s = 0; s < sides; s++) idx.push(c, v(last, s), v(last, s + 1));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Turn a ModelDef into a Three.js hierarchy.
 * Each part = joint Group (pos/rot) → Mesh (offset). Materials shared per colour.
 */
export function buildModel(def: ModelDef): BuiltModel {
  const root = new THREE.Group();
  root.name = `model:${def.id}`;
  const scaled = new THREE.Group();
  scaled.scale.setScalar(def.scale);
  root.add(scaled);

  const materials = new Map<string, THREE.MeshLambertMaterial>();
  const geometries: THREE.BufferGeometry[] = [];
  const jointsById = new Map<string, THREE.Group>();
  const joints: BuiltModel["joints"] = {};

  for (const part of def.parts) {
    const joint = new THREE.Group();
    joint.name = part.id;
    joint.position.set(...part.pos);
    joint.rotation.set(part.rot[0] * DEG, part.rot[1] * DEG, part.rot[2] * DEG);

    let mat = materials.get(part.color);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color: part.color, flatShading: true });
      materials.set(part.color, mat);
    }
    const geom = facetGeometry(part.sides, part.rings);
    geometries.push(geom);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(...part.offset);
    joint.add(mesh);

    (part.parent ? jointsById.get(part.parent) ?? scaled : scaled).add(joint);
    jointsById.set(part.id, joint);
    if (part.role) joints[part.role] = joint;
  }

  return {
    root,
    joints,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
