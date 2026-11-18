import * as THREE from "three";
import type { ModelDef, ModelPalette } from "@levi/shared";
import { buildModel, type BuiltModel } from "./ModelBuilder.js";

const TURN_RATE = 14; // higher = snappier facing
const STRIDE = 2.6; // radians of gait phase per world unit travelled
const LEG_SWING = 0.65;
const ARM_SWING = 0.55;

const tmp = new THREE.Vector3();

/**
 * Every vertex of a foot mesh. Feet are tiny (~20 verts), and checking all of
 * them catches the toe tipping down mid-stride as well as the sole.
 */
function soleVertices(geom: THREE.BufferGeometry): THREE.Vector3[] {
  const pos = geom.getAttribute("position");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  return out;
}

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
  /** Cast / attack pose: seconds since it started, and which. */
  private actT = Infinity;
  private actKind: "thrust" | "swing" = "thrust";
  private lastZ = NaN;
  /** Extra height above the ground (flying, hovering, thrown through the air). */
  lift = 0;
  /** 0 = upright … 1 = flat on its back. */
  tilt = 0;
  /** Held story pose layered over the walk. */
  pose: "none" | "channel" | "kneel" = "none";
  private poseW = 0;
  /** Sole vertices of each foot mesh (mesh-local), checked against the ground. */
  private readonly soles: Array<{ mesh: THREE.Object3D; points: THREE.Vector3[] }> = [];

  constructor(def: ModelDef, palette?: ModelPalette) {
    this.model = buildModel(def, palette);
    for (const role of ["footL", "footR"] as const) {
      const mesh = this.model.joints[role]?.children[0];
      if (mesh instanceof THREE.Mesh) this.soles.push({ mesh, points: soleVertices(mesh.geometry) });
    }
    const geom = new THREE.CircleGeometry(0.42, 16);
    geom.rotateX(-Math.PI / 2);
    this.model.root.rotation.order = "YXZ";
    this.shadow = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
  }

  /** Play the cast pose: thrust the casting hand out (spells, shots) or swing the weapon arm (melee). */
  playCast(kind: "thrust" | "swing"): void {
    this.actT = 0;
    this.actKind = kind;
  }

  setVisible(v: boolean): void {
    this.model.root.visible = v;
    this.shadow.visible = v;
  }

  addTo(parent: THREE.Object3D): void {
    parent.add(this.model.root, this.shadow);
  }

  /** `heightAt` = the surface the character stands on (terrain, or a building floor). */
  update(heightAt: (x: number, z: number) => number, x: number, z: number, dirX: number, dirZ: number, dt: number): void {
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
    const ground = heightAt(x, z);
    root.position.set(x, ground + bob, z);
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
    this.actT += dt;
    if (this.actT < 0.42) this.castPose(this.actT / 0.42);
    this.storyPose(dt);
    if (this.lift <= 0 && this.tilt <= 0.01 && this.poseW < 0.05) root.position.y += this.groundPenetration(heightAt);
    root.rotation.x = -this.tilt * 1.45;
    root.position.y += this.lift + this.tilt * 0.22;

    this.shadow.position.set(x, ground + 0.04, z);
    const sh = 1 / (1 + Math.max(0, this.lift) * 0.12);
    this.shadow.scale.setScalar(sh);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.28 * sh;
  }

  /** Overlay the right arm (and a torso twist) on the walk for the cast pose. t: 0 → 1. */
  private castPose(t: number): void {
    const j = this.model.joints;
    // Snap out fast, ease back slowly.
    const k = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
    const w = k * k * (3 - 2 * k);
    if (this.actKind === "thrust") {
      if (j.armR) j.armR.rotation.x = j.armR.rotation.x * (1 - w) - 1.45 * w;
      if (j.forearmR) j.forearmR.rotation.x = j.forearmR.rotation.x * (1 - w) - 0.1 * w;
      if (j.armL) j.armL.rotation.x = j.armL.rotation.x * (1 - w) - 0.5 * w;
      if (j.torso) j.torso.rotation.y = -0.25 * w;
    } else {
      // Wind up high and behind, then cut down across the body.
      const swingA = t < 0.18 ? -2.4 * (t / 0.18) : -2.4 + 3.0 * Math.min(1, (t - 0.18) / 0.25);
      const fade = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      if (j.armR) j.armR.rotation.x = j.armR.rotation.x * (1 - fade) + swingA * fade;
      if (j.torso) j.torso.rotation.y = (t < 0.18 ? 0.3 : 0.3 - 0.6 * Math.min(1, (t - 0.18) / 0.25)) * fade;
    }
  }

  /** Channel (both hands raised toward the target) or kneel, eased in and out. */
  private storyPose(dt: number): void {
    const on = this.pose !== "none";
    this.poseW += ((on ? 1 : 0) - this.poseW) * (1 - Math.exp(-dt * 8));
    if (this.pose !== "none") this.poseKind = this.pose;
    const w = this.poseW;
    if (w < 0.01) return;
    const j = this.model.joints;
    const mix = (o: THREE.Object3D | undefined, v: number): void => {
      if (o) o.rotation.x = o.rotation.x * (1 - w) + v * w;
    };
    if (this.poseKind === "channel") {
      mix(j.armL, -1.7);
      mix(j.armR, -1.85);
      mix(j.forearmL, -0.2);
      mix(j.forearmR, -0.15);
      mix(j.torso, -0.08);
    } else {
      // One knee down, head bowed.
      mix(j.legL, -1.35);
      mix(j.shinL, 1.45);
      mix(j.legR, 0.25);
      mix(j.shinR, 1.6);
      mix(j.torso, 0.3);
      mix(j.head, 0.35);
      mix(j.armL, 0.3);
      mix(j.armR, -0.5);
      this.model.root.position.y -= 0.42 * w;
    }
  }

  private poseKind: "channel" | "kneel" = "channel";

  /** How far the lowest sole point sits below the terrain under it (≥ 0). */
  private groundPenetration(heightAt: (x: number, z: number) => number): number {
    if (this.soles.length === 0) return 0;
    this.model.root.updateMatrixWorld(true);
    let deepest = 0;
    for (const { mesh, points } of this.soles) {
      for (const p of points) {
        tmp.copy(p).applyMatrix4(mesh.matrixWorld);
        deepest = Math.max(deepest, heightAt(tmp.x, tmp.z) - tmp.y);
      }
    }
    return deepest;
  }

  dispose(): void {
    this.model.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}
