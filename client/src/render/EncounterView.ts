import * as THREE from "three";
import { TICK_SEC, lerp, type Actor, type Arc, type EncounterEvent, type ModelDef, type ModelPalette, type StoryEncounter } from "@levi/shared";
import { CharacterEntity } from "./CharacterEntity.js";
import { ParticlePool, glowTexture } from "./SpellFx.js";

type GroundAt = (x: number, z: number) => number;

const MAX_BULLETS = 900;
const SHADOW = new THREE.Color(0.55, 0.25, 1);
const SHADOW_HOT = new THREE.Color(0.85, 0.65, 1);
const SMOKE = new THREE.Color(0.09, 0.05, 0.14);
const DUST = new THREE.Color(0.55, 0.5, 0.44);
const GOLD = new THREE.Color(1, 0.75, 0.3);
const WHITE = new THREE.Color(1, 0.97, 0.9);
const HALO_SIZE: Record<string, number> = { orb: 1.6, needle: 1.7, big: 1.45, mine: 1.9 };

/** A short-lived effect mesh (rings, flashes, beams). */
interface Fx {
  mesh: THREE.Object3D;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  grow: number;
  s0: number;
  opacity: number;
  /** Ground rings scale in x/z only. */
  flat: boolean;
}

/** Something moving through the air that leaves a trail (the comet, Falcon's bolts). */
interface Flyer {
  from: THREE.Vector3;
  to: THREE.Vector3;
  age: number;
  life: number;
  kind: "comet" | "bolt";
  mesh: THREE.Mesh;
}

const additive = (color: THREE.Color, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });

/**
 * Draws a story encounter: Falcon, the boss's shadow aura, the bullet-hell
 * orbs, the crash, shockwaves, the beam and the teleport. Reads the shared
 * StoryEncounter state; it never changes it.
 */
export class EncounterView {
  readonly group = new THREE.Group();
  private readonly falcon: CharacterEntity;
  private readonly glows: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly fx: Fx[] = [];
  private readonly flyers: Flyer[] = [];
  private readonly cores: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly ringGeom = new THREE.RingGeometry(0.82, 1, 48, 1).rotateX(-Math.PI / 2);
  private readonly ballGeom = new THREE.IcosahedronGeometry(1, 1);
  /** Last drawn bullet positions (to burst them when the fight clears). */
  private lastBullets: Array<{ x: number; z: number }> = [];
  private charge: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number } | null = null;
  private portal: { group: THREE.Group; mats: THREE.MeshBasicMaterial[]; x: number; z: number; age: number; life: number } | null = null;
  private falconTilt = 0;
  private time = 0;

  constructor(
    private readonly groundAt: GroundAt,
    falconModel: ModelDef,
    falconPalette: ModelPalette,
    falconScale: number,
  ) {
    this.group.name = "encounter";
    this.falcon = new CharacterEntity(falconModel, falconPalette);
    this.falcon.model.root.scale.setScalar(falconScale);
    this.falcon.addTo(this.group);
    this.falcon.setVisible(false);
    const tex = glowTexture();
    this.glows = new ParticlePool(2600, tex);
    this.smoke = new ParticlePool(900, tex, false);
    this.smoke.points.renderOrder = 7;
    this.group.add(this.glows.points, this.smoke.points);
    // Shadow orbs: a near-black core inside a translucent violet shell (reads on bright grass too).
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.06, 0.01, 0.1), fog: false });
    const shellMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.2, 0.95), transparent: true, opacity: 0.5, depthWrite: false, fog: false });
    this.cores = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), coreMat, MAX_BULLETS);
    this.halos = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), shellMat, MAX_BULLETS);
    for (const im of [this.cores, this.halos]) {
      im.frustumCulled = false;
      im.count = 0;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.halos.renderOrder = 6;
    this.group.add(this.cores, this.halos);
  }

  setViewport(height: number): void {
    this.glows.setViewport(height);
    this.smoke.setViewport(height);
  }

  // --- Heights -----------------------------------------------------------------------------------

  /** Render-time encounter clock (the sim's clock is one tick ahead of what's drawn). */
  private clockAt(enc: StoryEncounter, alpha: number): number {
    return enc.clock - (1 - alpha) * TICK_SEC;
  }

  private arcLift(a: Arc | null, clock: number, x: number, z: number): number {
    if (!a) return 0;
    const s = Math.min(1, Math.max(0, (clock - a.t0) / a.dur));
    const y = lerp(this.groundAt(a.fromX, a.fromZ), this.groundAt(a.toX, a.toZ), s) + a.peak * 4 * s * (1 - s);
    return Math.max(0, y - this.groundAt(x, z));
  }

  /** How high the player is flying (the knock-back off the mountain). */
  playerLift(enc: StoryEncounter | null, alpha: number, x: number, z: number): number {
    return enc ? this.arcLift(enc.flight, this.clockAt(enc, alpha), x, z) : 0;
  }

  /** Height and pose of the boss (she hovers, glides down from the cliff, channels). */
  bossLook(enc: StoryEncounter | null, alpha: number): (id: string, x: number, z: number) => { lift: number; pose: "none" | "channel" } | null {
    return (id, x, z) => {
      if (!enc || id !== enc.bossId) return null;
      const b = enc.bossActor;
      const hover = b.pose === "hover" || b.pose === "channel" ? 0.55 + Math.sin(this.time * 2.1) * 0.12 : 0;
      return { lift: this.arcLift(b.arc, this.clockAt(enc, alpha), x, z) + hover, pose: b.pose === "channel" ? "channel" : "none" };
    };
  }

  private actorPos(a: Actor, alpha: number): { x: number; z: number } {
    return { x: lerp(a.prevX, a.x, alpha), z: lerp(a.prevZ, a.z, alpha) };
  }

  // --- Events ------------------------------------------------------------------------------------

  private addFx(mesh: THREE.Object3D, mat: THREE.MeshBasicMaterial, life: number, grow: number, opacity: number, flat = false): void {
    this.group.add(mesh);
    this.fx.push({ mesh, mat, age: 0, life, grow, s0: mesh.scale.x, opacity, flat });
  }

  private ring(x: number, z: number, color: THREE.Color, from: number, to: number, life: number, opacity = 0.9): void {
    const mat = additive(color, opacity);
    const mesh = new THREE.Mesh(this.ringGeom, mat);
    mesh.position.set(x, this.groundAt(x, z) + 0.12, z);
    mesh.scale.setScalar(from);
    mesh.renderOrder = 6;
    this.addFx(mesh, mat, life, to, opacity, true);
  }

  private ball(x: number, y: number, z: number, color: THREE.Color, from: number, to: number, life: number, opacity = 0.9): void {
    const mat = additive(color, opacity);
    const mesh = new THREE.Mesh(this.ballGeom, mat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(from);
    mesh.renderOrder = 6;
    this.addFx(mesh, mat, life, to, opacity);
  }

  private burst(x: number, y: number, z: number, color: THREE.Color, n: number, speed: number, size: number, life = 0.6): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 2 - 0.4;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.glows.emit({ x, y, z, vx: Math.cos(a) * sp, vy: up * sp * 0.6, vz: Math.sin(a) * sp, color, life: life * (0.6 + Math.random() * 0.7), size0: size, size1: 0, drag: 2.5, gravity: 2 });
    }
  }

  private dust(x: number, z: number, n: number, spread: number, color = DUST): void {
    const y = this.groundAt(x, z);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.5 + Math.random());
      this.smoke.emit({ x, y: y + 0.3, z, vx: Math.cos(a) * sp, vy: 0.6 + Math.random() * 1.5, vz: Math.sin(a) * sp, color, alpha: 0.55, life: 1.2 + Math.random() * 1.2, size0: 0.8, size1: 2.6, drag: 1.8 });
    }
  }

  handle(events: readonly EncounterEvent[], hooks: {
    shake: (power: number, dur: number) => void;
    debris: (dur: number) => void;
    playerHit: () => void;
    flash: (fadeIn: number, hold: number, fadeOut: number) => void;
    player: () => { x: number; z: number };
  }): void {
    for (const e of events) {
      switch (e.kind) {
        case "comet": {
          const gy = this.groundAt(e.x, e.z);
          const mesh = new THREE.Mesh(this.ballGeom, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.03, 0.14), fog: false }));
          mesh.scale.setScalar(0.9);
          this.group.add(mesh);
          this.flyers.push({ from: new THREE.Vector3(e.x + 18, gy + 75, e.z - 26), to: new THREE.Vector3(e.x, gy + 0.6, e.z), age: 0, life: e.dur, kind: "comet", mesh });
          break;
        }
        case "impact": {
          const gy = this.groundAt(e.x, e.z);
          this.ball(e.x, gy + 0.6, e.z, SHADOW, 0.3, 0.9 * e.size, 0.35, 0.55);
          this.ring(e.x, e.z, SHADOW, 0.5, 7 * e.size, 0.8, 0.9);
          this.ring(e.x, e.z, SHADOW_HOT, 0.3, 4 * e.size, 0.5, 0.5);
          this.burst(e.x, gy + 0.8, e.z, SHADOW_HOT, Math.round(40 * e.size), 9 * e.size, 0.45);
          this.dust(e.x, e.z, Math.round(26 * e.size), 3.2 * e.size);
          break;
        }
        case "blast": {
          const d = Math.hypot(e.dirX, e.dirZ) || 1;
          const gy = this.groundAt(e.x, e.z);
          this.ring(e.x, e.z, SHADOW_HOT, 0.6, 14, 0.9, 1);
          for (let i = 0; i < 70; i++) {
            const spread = (Math.random() - 0.5) * 1.3;
            const ca = Math.cos(spread);
            const sa = Math.sin(spread);
            const dx = (e.dirX / d) * ca - (e.dirZ / d) * sa;
            const dz = (e.dirX / d) * sa + (e.dirZ / d) * ca;
            const sp = 10 + Math.random() * 14;
            this.glows.emit({ x: e.x, y: gy + 0.6 + Math.random() * 1.6, z: e.z, vx: dx * sp, vy: Math.random() * 3, vz: dz * sp, color: i % 3 ? SHADOW : SHADOW_HOT, life: 0.5 + Math.random() * 0.4, size0: 0.6, size1: 0.1, drag: 1.5 });
          }
          break;
        }
        case "debris":
          hooks.debris(e.dur);
          break;
        case "blink": {
          for (const [x, z] of [[e.fromX, e.fromZ], [e.toX, e.toZ]] as const) {
            const gy = this.groundAt(x, z);
            this.burst(x, gy + 1, z, SHADOW, 22, 4, 0.5);
            for (let i = 0; i < 10; i++) this.smoke.emit({ x: x + (Math.random() - 0.5), y: gy + 0.5 + Math.random() * 1.5, z: z + (Math.random() - 0.5), vy: 1.2, color: SMOKE, alpha: 0.8, life: 0.9, size0: 1, size1: 2, drag: 1 });
          }
          break;
        }
        case "volley": {
          const gy = this.groundAt(e.x, e.z);
          this.ball(e.x, gy + 1.5, e.z, SHADOW_HOT, 0.2, 0.9, 0.25, 0.9);
          this.ring(e.x, e.z, SHADOW, 0.4, 2.6, 0.4, 0.7);
          break;
        }
        case "falconShot": {
          const fy = this.groundAt(e.fromX, e.fromZ) + 1.4;
          const ty = this.groundAt(e.toX, e.toZ) + 1.6;
          const mesh = new THREE.Mesh(this.ballGeom, additive(GOLD, 1));
          mesh.scale.setScalar(0.22);
          this.group.add(mesh);
          this.flyers.push({ from: new THREE.Vector3(e.fromX, fy, e.fromZ), to: new THREE.Vector3(e.toX, ty, e.toZ), age: 0, life: 0.32, kind: "bolt", mesh });
          break;
        }
        case "charge": {
          const mat = additive(SHADOW, 0.75);
          const mesh = new THREE.Mesh(this.ballGeom, mat);
          mesh.position.set(e.x, this.groundAt(e.x, e.z) + 1.9, e.z);
          mesh.scale.setScalar(0.05);
          this.group.add(mesh);
          this.charge = { mesh, mat, age: 0, life: e.dur };
          break;
        }
        case "beam": {
          if (this.charge) {
            this.group.remove(this.charge.mesh);
            this.charge.mat.dispose();
            this.charge = null;
          }
          const a = new THREE.Vector3(e.fromX, this.groundAt(e.fromX, e.fromZ) + 1.9, e.fromZ);
          const b = new THREE.Vector3(e.toX, this.groundAt(e.toX, e.toZ) + 1.2, e.toZ);
          const len = a.distanceTo(b);
          for (const [w, c, o] of [[0.55, SHADOW, 0.85], [0.22, WHITE, 1]] as const) {
            const mat = additive(c, o);
            const mesh = new THREE.Mesh(new THREE.CylinderGeometry(w, w, len, 10, 1, true), mat);
            mesh.position.copy(a).add(b).multiplyScalar(0.5);
            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.v.copy(b).sub(a).normalize());
            mesh.renderOrder = 7;
            this.addFx(mesh, mat, 0.55, 1, o);
          }
          this.burst(b.x, b.y, b.z, WHITE, 40, 8, 0.5);
          break;
        }
        case "playerHit": {
          const gy = this.groundAt(e.x, e.z);
          this.burst(e.x, gy + 1.1, e.z, SHADOW_HOT, 12, 4, 0.35, 0.4);
          hooks.playerHit();
          break;
        }
        case "clearBullets":
          for (const b of this.lastBullets) this.burst(b.x, this.groundAt(b.x, b.z) + 0.9, b.z, SHADOW, 3, 2.5, 0.3, 0.4);
          break;
        case "portal":
          this.pillar(e.x, e.z, e.dur);
          break;
        case "flash":
          hooks.flash(e.fadeIn, e.hold, e.fadeOut);
          break;
        case "shake":
          hooks.shake(e.power, e.dur);
          break;
        case "bark":
        case "cinematic":
          break;
      }
    }
  }

  /** A column of light with turning rings (Falcon's teleport, the arrival). */
  pillar(x: number, z: number, life: number): void {
    const g = new THREE.Group();
    const gy = this.groundAt(x, z);
    g.position.set(x, gy, z);
    const mats: THREE.MeshBasicMaterial[] = [];
    const col = additive(WHITE, 0);
    mats.push(col);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.1, 14, 20, 1, true), col);
    column.position.y = 7;
    const r1 = additive(GOLD, 0);
    mats.push(r1);
    const ring1 = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.55, 6, 1).rotateX(-Math.PI / 2), r1);
    ring1.position.y = 0.1;
    const r2 = additive(GOLD, 0);
    mats.push(r2);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(1.75, 1.85, 40, 1).rotateX(-Math.PI / 2), r2);
    ring2.position.y = 0.12;
    g.add(column, ring1, ring2);
    for (const o of g.children) o.renderOrder = 7;
    this.group.add(g);
    this.portal = { group: g, mats, x, z, age: 0, life };
  }

  // --- Frame -------------------------------------------------------------------------------------

  update(enc: StoryEncounter | null, alpha: number, dt: number): void {
    this.time += dt;
    const clock = enc ? this.clockAt(enc, alpha) : 0;

    // Falcon.
    const f = enc?.falcon;
    const showFalcon = !!enc && !!f && f.visible;
    this.falcon.setVisible(showFalcon);
    if (enc && f && showFalcon) {
      const p = this.actorPos(f, alpha);
      this.falconTilt += ((f.pose === "down" ? 1 : 0) - this.falconTilt) * (1 - Math.exp(-dt * 9));
      this.falcon.tilt = this.falconTilt;
      this.falcon.lift = this.arcLift(f.arc, clock, p.x, p.z);
      this.falcon.pose = f.pose === "channel" ? "channel" : f.pose === "kneel" ? "kneel" : "none";
      this.falcon.update(this.groundAt, p.x, p.z, f.dirX, f.dirZ, dt);
      if (f.pose === "channel" && Math.random() < dt * 30) {
        const gy = this.groundAt(p.x, p.z) + this.falcon.lift;
        this.glows.emit({ x: p.x + f.dirX * 0.5, y: gy + 1.3, z: p.z + f.dirZ * 0.5, vy: 0.6, color: GOLD, life: 0.5, size0: 0.35, size1: 0, drag: 1 });
      }
    }

    // The boss's shadow aura.
    const b = enc?.bossActor;
    if (enc && b && b.visible) {
      const p = this.actorPos(b, alpha);
      const lift = this.bossLook(enc, alpha)(enc.bossId, p.x, p.z)?.lift ?? 0;
      const gy = this.groundAt(p.x, p.z) + lift;
      const n = Math.random() < dt * 40 ? 1 : 0;
      for (let i = 0; i < n + 1; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.25 + Math.random() * 0.35;
        this.smoke.emit({ x: p.x + Math.cos(a) * r, y: gy + 0.1 + Math.random() * 0.6, z: p.z + Math.sin(a) * r, vx: Math.cos(a) * 0.3, vy: 0.5 + Math.random() * 0.6, vz: Math.sin(a) * 0.3, color: SMOKE, alpha: 0.75, life: 1 + Math.random() * 0.6, size0: 0.5, size1: 1.1, drag: 0.6 });
      }
      if (Math.random() < dt * 14) this.glows.emit({ x: p.x + (Math.random() - 0.5) * 0.7, y: gy + Math.random() * 1.4, z: p.z + (Math.random() - 0.5) * 0.7, vy: 0.8, color: SHADOW, life: 0.8, size0: 0.22, size1: 0, drag: 0.5 });
      // Eyes under the hood.
      const ex = p.x + b.dirX * 0.17;
      const ez = p.z + b.dirZ * 0.17;
      for (const side of [-1, 1]) {
        this.glows.emit({ x: ex + b.dirZ * 0.06 * side, y: gy + 1.31, z: ez - b.dirX * 0.06 * side, color: SHADOW_HOT, life: 0.06, size0: 0.14, size1: 0.14, alpha: 0.9 });
      }
    }

    this.drawBullets(enc, alpha, dt);
    this.updateFlyers(dt);
    this.updateFx(dt);
    if (this.charge) {
      const c = this.charge;
      c.age += dt;
      const t = Math.min(1, c.age / c.life);
      c.mesh.scale.setScalar(0.1 + t * 1.1 + Math.sin(this.time * 30) * 0.05);
      if (Math.random() < dt * 60) {
        const a = Math.random() * Math.PI * 2;
        const r = 2.5 + Math.random();
        const o = c.mesh.position;
        this.glows.emit({ x: o.x + Math.cos(a) * r, y: o.y + (Math.random() - 0.5) * 2, z: o.z + Math.sin(a) * r, vx: -Math.cos(a) * r * 1.8, vz: -Math.sin(a) * r * 1.8, color: SHADOW_HOT, life: 0.5, size0: 0.25, size1: 0.05 });
      }
      if (!enc || enc.phase !== "rescue") {
        this.group.remove(c.mesh);
        c.mat.dispose();
        this.charge = null;
      }
    }
    if (this.portal) {
      const pt = this.portal;
      pt.age += dt;
      const t = pt.age / pt.life;
      const k = Math.min(1, t * 3) * (t > 1 ? Math.max(0, 1 - (t - 1) * 3) : 1);
      pt.mats[0]!.opacity = 0.35 * k + t * 0.4 * k;
      pt.mats[1]!.opacity = 0.9 * k;
      pt.mats[2]!.opacity = 0.7 * k;
      pt.group.children[1]!.rotation.y += dt * 1.6;
      pt.group.children[2]!.rotation.y -= dt * 0.8;
      if (Math.random() < dt * 50 * k) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 1.2;
        this.glows.emit({ x: pt.x + Math.cos(a) * r, y: pt.group.position.y + Math.random(), z: pt.z + Math.sin(a) * r, vy: 3 + Math.random() * 4, color: Math.random() < 0.5 ? GOLD : WHITE, life: 1.2, size0: 0.3, size1: 0, drag: 0.2 });
      }
      if (t > 1.4) {
        this.group.remove(pt.group);
        for (const m of pt.mats) m.dispose();
        this.portal = null;
      }
    }
    this.glows.update(dt);
    this.smoke.update(dt);
  }

  private drawBullets(enc: StoryEncounter | null, alpha: number, dt: number): void {
    const list = enc?.bullets ?? [];
    const n = Math.min(MAX_BULLETS, list.length);
    this.lastBullets = [];
    for (let i = 0; i < n; i++) {
      const u = list[i]!;
      const x = lerp(u.prevX, u.x, alpha);
      const z = lerp(u.prevZ, u.z, alpha);
      this.lastBullets.push({ x, z });
      const y = this.groundAt(x, z) + (u.kind === "mine" ? 0.35 : 0.95);
      const pulse = u.kind === "mine" ? 1 + Math.sin(this.time * 18) * 0.25 * (1.3 - u.fuse) : 1;
      if (u.kind === "needle") {
        const ang = Math.atan2(u.vx, u.vz);
        this.q.setFromEuler(new THREE.Euler(0, ang, 0));
        this.sc.set(u.r * 0.8, u.r * 0.8, u.r * 2.4);
      } else {
        this.q.identity();
        this.sc.setScalar(u.r * pulse);
      }
      this.v.set(x, y, z);
      this.m.compose(this.v, this.q, this.sc);
      this.cores.setMatrixAt(i, this.m);
      this.sc.multiplyScalar(HALO_SIZE[u.kind] ?? 2);
      this.m.compose(this.v, this.q, this.sc);
      this.halos.setMatrixAt(i, this.m);
      if (u.kind !== "mine" && Math.random() < dt * 9) {
        this.glows.emit({ x, y, z, color: SHADOW, life: 0.3, size0: u.r * 1.6, size1: 0, alpha: 0.6 });
      }
    }
    this.cores.count = n;
    this.halos.count = n;
    this.cores.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
  }

  private updateFlyers(dt: number): void {
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i]!;
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      const s = f.kind === "comet" ? t * t : t;
      f.mesh.position.lerpVectors(f.from, f.to, s);
      const p = f.mesh.position;
      if (f.kind === "comet") {
        for (let k = 0; k < 6; k++) {
          this.smoke.emit({ x: p.x + (Math.random() - 0.5) * 0.8, y: p.y + (Math.random() - 0.5) * 0.8, z: p.z + (Math.random() - 0.5) * 0.8, color: SMOKE, alpha: 0.9, life: 0.9, size0: 1.6, size1: 2.8, drag: 2 });
        }
        for (let k = 0; k < 4; k++) this.glows.emit({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, color: k % 2 ? SHADOW : SHADOW_HOT, life: 0.5, size0: 1.2, size1: 0, drag: 1 });
      } else {
        this.glows.emit({ x: p.x, y: p.y, z: p.z, color: GOLD, life: 0.25, size0: 0.4, size1: 0 });
      }
      if (t >= 1) {
        if (f.kind === "bolt") {
          this.burst(p.x, p.y, p.z, GOLD, 10, 3, 0.3, 0.35);
          // Shrugged off: a little shadow ripple where it lands.
          this.ball(p.x, p.y, p.z, SHADOW, 0.2, 0.9, 0.25, 0.6);
        }
        this.group.remove(f.mesh);
        (f.mesh.material as THREE.Material).dispose();
        this.flyers.splice(i, 1);
      }
    }
  }

  private updateFx(dt: number): void {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]!;
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) {
        this.group.remove(f.mesh);
        f.mat.dispose();
        this.fx.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - t) * (1 - t);
      const s = f.s0 + (f.grow - f.s0) * ease;
      if (f.flat) f.mesh.scale.set(s, 1, s);
      else if (f.grow !== 1 || f.s0 !== 1) f.mesh.scale.setScalar(s);
      f.mat.opacity = f.opacity * (1 - t);
    }
  }

  /** Where rocks land: dust and a thump. */
  rockLanded(x: number, z: number): void {
    this.dust(x, z, 7, 1.6);
  }
}
