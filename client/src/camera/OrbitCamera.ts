import * as THREE from "three";
import { clamp, getTerrainHeight, type Heightmap } from "@levi/shared";

export interface OrbitLimits {
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
}

const DEFAULT_LIMITS: OrbitLimits = { minDistance: 5, maxDistance: 42, minPitch: 0.12, maxPitch: 1.42 };
const DRAG_SENSITIVITY = 0.006;
const KEY_YAW_SPEED = 2.2; // rad/s
const KEY_PITCH_SPEED = 1.4;

/**
 * WoW-style third-person orbit around a focus point.
 *   yaw   = rotation about +Y; camera offset = (sin yaw, ·, cos yaw)
 *   pitch = elevation angle above the ground plane
 * Never dips below the terrain surface.
 */
export class OrbitCamera {
  yaw = Math.PI * 0.25;
  pitch = 0.72;
  private distance = 12;
  private targetDistance = 12;
  private readonly focus = new THREE.Vector3();
  private initialised = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly hm: Heightmap,
    private readonly limits: OrbitLimits = DEFAULT_LIMITS,
  ) {}

  /** Middle-mouse drag in pixels. Drag right → look right. */
  orbit(dxPx: number, dyPx: number): void {
    this.yaw -= dxPx * DRAG_SENSITIVITY;
    this.pitch = clamp(this.pitch + dyPx * DRAG_SENSITIVITY, this.limits.minPitch, this.limits.maxPitch);
  }

  zoom(wheelDeltaY: number): void {
    this.targetDistance = clamp(
      this.targetDistance * Math.exp(wheelDeltaY * 0.0012),
      this.limits.minDistance,
      this.limits.maxDistance,
    );
  }

  /** OSRS-style arrow-key rotation. Axes in [-1, 1]. */
  rotateByKeys(yawAxis: number, pitchAxis: number, dt: number): void {
    this.yaw += yawAxis * KEY_YAW_SPEED * dt;
    this.pitch = clamp(this.pitch + pitchAxis * KEY_PITCH_SPEED * dt, this.limits.minPitch, this.limits.maxPitch);
  }

  update(dt: number, focusTarget: THREE.Vector3): void {
    if (!this.initialised) {
      this.focus.copy(focusTarget);
      this.initialised = true;
    } else {
      this.focus.lerp(focusTarget, 1 - Math.exp(-dt * 14));
    }
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 10));

    const cp = Math.cos(this.pitch);
    const cam = this.camera.position;
    cam.set(
      this.focus.x + Math.sin(this.yaw) * cp * this.distance,
      this.focus.y + Math.sin(this.pitch) * this.distance,
      this.focus.z + Math.cos(this.yaw) * cp * this.distance,
    );

    const ground = getTerrainHeight(this.hm, cam.x, cam.z) + 0.8;
    if (cam.y < ground) cam.y = ground;

    this.camera.lookAt(this.focus);
  }
}
