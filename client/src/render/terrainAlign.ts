import * as THREE from "three";
import { getTerrainHeight, type Heightmap } from "@levi/shared";

const UP = new THREE.Vector3(0, 1, 0);
const n = new THREE.Vector3();

/** Surface normal from central differences of the shared height function. */
export function terrainNormal(hm: Heightmap, x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = hm.cellSize * 0.5;
  const dx = getTerrainHeight(hm, x + e, z) - getTerrainHeight(hm, x - e, z);
  const dz = getTerrainHeight(hm, x, z + e) - getTerrainHeight(hm, x, z - e);
  return out.set(-dx, 2 * e, -dz).normalize();
}

/** Place a flat ground decal (shadow, marker) on the terrain, tilted to the slope. */
export function placeOnGround(obj: THREE.Object3D, hm: Heightmap, x: number, z: number, lift = 0.04): void {
  obj.position.set(x, getTerrainHeight(hm, x, z) + lift, z);
  obj.quaternion.setFromUnitVectors(UP, terrainNormal(hm, x, z, n));
}
