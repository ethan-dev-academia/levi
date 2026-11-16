import * as THREE from "three";
import { getTerrainHeight, type Heightmap, type ModelDef } from "@levi/shared";
import { buildModel, type BuiltModel } from "./ModelBuilder.js";
import { placeOnGround } from "./terrainAlign.js";

const TURN_RATE = 14; // higher = snappier facing
const STRIDE = 2.6; // radians of gait phase per world unit travelled
const LEG_SWING = 0.65;
const ARM_SWING = 0.55;

/**
 * A 3D primitive-built character standing on the terrain, with a
 * procedural walk cycle driven by distance travelled (never foot-slides).
 */
export class CharacterEntity {
  readonly model: BuiltModel;
  private readonly shadow: THREE.Mesh;
  private yaw = 0;
  private phase = 0;
  private gait = 0; // 0 = idle, 1 = full walk, eased
  private idleTime = 0;
  private lastX = NaN;
  private lastZ = NaN;

  constructor(def: ModelDef) {
    this.model = buildModel(def);
    const geom = new THREE.CircleGeometry(0.42, 16);
    geom.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.model.root, this.shadow);
  }

  update(hm: Heightmap, x: number, z: number, dirX: number, dirZ: number, dt: number): void {
    const moved = Number.isNaN(this.lastX) ? 0 : Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x;
    this.lastZ = z;
    const moving = moved > 1e-4;

    // Face movement direction, turning along the shortest arc.
    if (dirX !== 0 || dirZ !== 0) {
      const target = Math.atan2(dirX, dirZ);
      let d = target - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (1 - Math.exp(-dt * TURN_RATE));
    }

    this.phase += moved * STRIDE;
    this.gait += ((moving ? 1 : 0) - this.gait) * (1 - Math.exp(-dt * 10));
    this.idleTime += dt;

    const root = this.model.root;
    const swing = Math.sin(this.phase) * this.gait;
    const bob = Math.abs(Math.cos(this.phase)) * 0.05 * this.gait;
    root.position.set(x, getTerrainHeight(hm, x, z) + bob, z);
    root.rotation.y = this.yaw;

    const j = this.model.joints;
    const legL = swing * LEG_SWING;
    const legR = -swing * LEG_SWING;
    const armL = -swing * ARM_SWING;
    const armR = swing * ARM_SWING;
    if (j.legL) j.legL.rotation.x = legL;
    if (j.legR) j.legR.rotation.x = legR;
    if (j.armL) j.armL.rotation.x = armL;
    if (j.armR) j.armR.rotation.x = armR;
    // Knee bends while the thigh is behind the body (push-off); elbows stay soft
    // and bend more on the forward swing. +X rotation swings a limb's end backward.
    if (j.shinL) j.shinL.rotation.x = Math.max(0, legL) * 1.3;
    if (j.shinR) j.shinR.rotation.x = Math.max(0, legR) * 1.3;
    if (j.forearmL) j.forearmL.rotation.x = -0.25 - Math.max(0, -armL) * 0.7;
    if (j.forearmR) j.forearmR.rotation.x = -0.25 - Math.max(0, -armR) * 0.7;
    if (j.torso) {
      // Lean into the walk; breathe when idle.
      j.torso.rotation.x = 0.08 * this.gait;
      j.torso.scale.y = 1 + Math.sin(this.idleTime * 2.2) * 0.012 * (1 - this.gait);
    }
    if (j.head) j.head.rotation.x = -0.06 * this.gait;

    placeOnGround(this.shadow, hm, x, z);
  }

  dispose(): void {
    this.model.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
