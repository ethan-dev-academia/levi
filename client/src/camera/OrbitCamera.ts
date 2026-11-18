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

/** A cutscene camera: yaw null = keep the player's own yaw. */
export interface CameraShot {
  yaw: number | null;
  pitch: number;
  distance: number;
  /** How quickly the camera settles into the shot (higher = snappier). */
  rate?: number;
}

const angleLerp = (a: number, b: number, t: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

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
  /** Cutscene framing, blended over the player's own camera. */
  private shot: CameraShot | null = null;
  private shotW = 0;
  private sYaw = 0;
  private sPitch = 0;
  private sDist = 12;
  private shakeLeft = 0;
  private shakeDur = 1;
  private shakePower = 0;

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

  /** Frame a cutscene (null = hand the camera back to the player). */
  setShot(shot: CameraShot | null): void {
    if (shot && !this.shot && this.shotW < 0.01) {
      this.sYaw = this.yaw;
      this.sPitch = this.pitch;
      this.sDist = this.distance;
    }
    this.shot = shot;
  }

  shake(power: number, dur: number): void {
    if (this.shakePower * Math.max(0, this.shakeLeft / this.shakeDur) > power) return;
    this.shakePower = power;
    this.shakeDur = this.shakeLeft = dur;
  }

  update(dt: number, focusTarget: THREE.Vector3): void {
    const s = this.shot;
    const rate = s?.rate ?? 2.6;
    if (!this.initialised) {
      this.focus.copy(focusTarget);
      this.initialised = true;
    } else {
      this.focus.lerp(focusTarget, 1 - Math.exp(-dt * (s || this.shotW > 0.05 ? rate * 1.6 : 14)));
    }
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 10));
    const k = 1 - Math.exp(-dt * rate);
    this.shotW += ((s ? 1 : 0) - this.shotW) * (1 - Math.exp(-dt * (s ? 6 : 2.2)));
    if (s) {
      this.sYaw = angleLerp(this.sYaw, s.yaw ?? this.yaw, k);
      this.sPitch += (s.pitch - this.sPitch) * k;
      this.sDist += (s.distance - this.sDist) * k;
    }
    const w = this.shotW;
    const yaw = angleLerp(this.yaw, this.sYaw, w);
    const pitch = this.pitch + (this.sPitch - this.pitch) * w;
    const distance = this.distance + (this.sDist - this.distance) * w;

    const cp = Math.cos(pitch);
    const cam = this.camera.position;
    cam.set(
      this.focus.x + Math.sin(yaw) * cp * distance,
      this.focus.y + Math.sin(pitch) * distance,
      this.focus.z + Math.cos(yaw) * cp * distance,
    );
    if (this.shakeLeft > 0) {
      this.shakeLeft -= dt;
      const a = this.shakePower * 0.45 * Math.max(0, this.shakeLeft / this.shakeDur);
      cam.x += (Math.random() - 0.5) * a;
      cam.y += (Math.random() - 0.5) * a;
      cam.z += (Math.random() - 0.5) * a;
    }

    const ground = getTerrainHeight(this.hm, cam.x, cam.z) + 0.8;
    if (cam.y < ground) cam.y = ground;

    this.camera.lookAt(this.focus);
  }
}
