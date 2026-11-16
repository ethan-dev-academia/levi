import * as THREE from "three";
import { clamp, getTerrainHeight, type Heightmap, type Vec2 } from "@levi/shared";
import type { Keyboard } from "../input/Keyboard.js";
import type { CameraOverride } from "./types.js";

const LOOK_SENSITIVITY = 0.0035; // rad per px
const KEY_LOOK_SPEED = 1.8; // rad/s
const BOOST = 4;
const MIN_CLEARANCE = 0.6;
const MAX_ALTITUDE = 250;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

/**
 * Dev fly camera. Forward = (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch).
 * WASD fly along the view, Q/E (or Space) down/up, Shift boost,
 * RMB/MMB-drag or arrows to look, wheel to dolly. Never dips under terrain.
 */
export class FreeCamera implements CameraOverride {
  /** Base speed, world units per second. */
  speed = 30;
  private yaw = 0;
  private pitch = 0;
  private looking = false;
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly abort = new AbortController();
  private active = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly hm: Heightmap,
    private readonly keys: Keyboard,
    canvas: HTMLCanvasElement,
  ) {
    const opts = { signal: this.abort.signal, capture: true };
    // Capture phase on the canvas runs before the game's walk/orbit handlers,
    // which we suppress while flying. Ctrl+RMB is left for the teleport tool.
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.active || e.ctrlKey || (e.button !== 2 && e.button !== 1)) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        this.looking = true;
      },
      opts,
    );
    canvas.addEventListener(
      "pointermove",
      (e) => {
        if (!this.active || !this.looking) return;
        e.stopImmediatePropagation();
        this.yaw -= e.movementX * LOOK_SENSITIVITY;
        this.pitch = clamp(this.pitch - e.movementY * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
      },
      opts,
    );
    const stopLook = (e: PointerEvent): void => {
      if (!this.looking || (e.button !== 2 && e.button !== 1)) return;
      this.looking = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      e.stopImmediatePropagation();
    };
    canvas.addEventListener("pointerup", stopLook, opts);
    canvas.addEventListener("lostpointercapture", () => (this.looking = false), opts);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.forward(this.fwd);
        this.camera.position.addScaledVector(this.fwd, -Math.sign(e.deltaY) * this.speed * 0.15);
        this.clampToWorld();
      },
      { signal: this.abort.signal, capture: true, passive: false },
    );
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Start flying from wherever the camera currently is, looking the same way. */
  enter(): void {
    this.camera.getWorldDirection(this.fwd);
    this.pitch = Math.asin(clamp(this.fwd.y, -1, 1));
    this.yaw = Math.atan2(this.fwd.x, this.fwd.z);
    this.active = true;
  }

  exit(): void {
    this.active = false;
    this.looking = false;
  }

  private forward(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  private clampToWorld(): void {
    const p = this.camera.position;
    p.x = clamp(p.x, -50, this.hm.width + 50);
    p.z = clamp(p.z, -50, this.hm.depth + 50);
    p.y = clamp(p.y, getTerrainHeight(this.hm, p.x, p.z) + MIN_CLEARANCE, MAX_ALTITUDE);
  }

  update(dt: number): void {
    const k = this.keys;
    this.yaw += k.axis("ArrowRight", "ArrowLeft") * KEY_LOOK_SPEED * dt;
    this.pitch = clamp(this.pitch + k.axis("ArrowDown", "ArrowUp") * KEY_LOOK_SPEED * dt, -PITCH_LIMIT, PITCH_LIMIT);

    this.forward(this.fwd);
    // Right = forward × up, flattened.
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    this.move.set(0, 0, 0);
    this.move.addScaledVector(this.fwd, k.axis("KeyS", "KeyW"));
    this.move.addScaledVector(this.right, k.axis("KeyA", "KeyD"));
    this.move.y += k.axis("KeyQ", "KeyE") + (k.isDown("Space") ? 1 : 0);
    if (this.move.lengthSq() > 0) {
      const boost = k.isDown("ShiftLeft") || k.isDown("ShiftRight") ? BOOST : 1;
      this.move.normalize().multiplyScalar(this.speed * boost * dt);
      this.camera.position.add(this.move);
    }
    this.clampToWorld();

    this.target.copy(this.camera.position).add(this.fwd);
    this.camera.lookAt(this.target);
  }

  focus(): Vec2 {
    return { x: this.camera.position.x, z: this.camera.position.z };
  }

  dispose(): void {
    this.abort.abort();
  }
}
