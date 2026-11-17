import * as THREE from "three";
import { lerp, type CombatEvent, type CombatWorld, type Telegraph } from "@levi/shared";
import { SpellFx, type BoltLook } from "./SpellFx.js";

const RED = 0xe0342a;
const NUMBER_LIFE = 0.9;
/** Height above the ground for ground markings. */
const LIFT = 0.06;

type GroundAt = (x: number, z: number) => number;

/**
 * A flat marking that hugs the terrain: its geometry is built finely in
 * local XZ, and every placement writes each vertex at world position with
 * the ground's height there, so it lies on slopes instead of floating.
 */
class Drape {
  readonly mesh: THREE.Mesh;
  private readonly base: Float32Array;

  constructor(geom: THREE.BufferGeometry, material: THREE.Material, renderOrder: number) {
    this.base = Float32Array.from(geom.getAttribute("position").array as ArrayLike<number>);
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  /** Put it at (cx, cz), turned to face (dirX, dirZ), scaled sx across / sz along. */
  place(groundAt: GroundAt, cx: number, cz: number, dirX: number, dirZ: number, sx = 1, sz = 1, lift = LIFT): void {
    const len = Math.hypot(dirX, dirZ) || 1;
    const s = dirX / len; // sin(yaw)
    const c = dirZ / len; // cos(yaw)
    const pos = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const b = this.base;
    for (let i = 0; i < pos.count; i++) {
      const lx = b[i * 3]! * sx;
      const lz = b[i * 3 + 2]! * sz;
      const wx = cx + lx * c + lz * s;
      const wz = cz - lx * s + lz * c;
      pos.setXYZ(i, wx, groundAt(wx, wz) + lift, wz);
    }
    pos.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const markMat = (color: number, opacity: number): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide });

/** Telegraph shapes, finely subdivided so they can follow the ground. */
function shapeGeom(t: Telegraph): THREE.BufferGeometry {
  const a = t.attack;
  if (a.shape === "circle") return new THREE.RingGeometry(0.001, a.radius, 40, Math.max(3, Math.ceil(a.radius * 2))).rotateX(-Math.PI / 2);
  if (a.shape === "line") {
    return new THREE.PlaneGeometry(a.width, a.length, Math.max(1, Math.ceil(a.width * 2)), Math.max(2, Math.ceil(a.length * 2)))
      .rotateX(-Math.PI / 2)
      .translate(0, 0, a.length / 2);
  }
  const ang = (a.angle * Math.PI) / 180;
  // Cone: a ring sector centred on +Z.
  return new THREE.RingGeometry(0.001, a.length, 32, Math.max(3, Math.ceil(a.length * 2)), Math.PI / 2 - ang, ang * 2)
    .rotateX(-Math.PI / 2)
    .scale(1, 1, -1);
}

function edgeGeom(t: Telegraph): THREE.BufferGeometry {
  const a = t.attack;
  if (a.shape === "circle") return new THREE.RingGeometry(a.radius - 0.08, a.radius, 48, 1).rotateX(-Math.PI / 2);
  // Lines and cones: the full shape, drawn faintly behind the growing fill.
  return shapeGeom(t);
}

/**
 * Combat visuals: red ground telegraphs (outline + fill that grows until it
 * strikes), projectiles, the aim line while a skill key is held, and floating
 * damage numbers. Ground markings follow the terrain. Reads the combat sim;
 * owns no game state.
 */
export class CombatFx {
  readonly group = new THREE.Group();
  private readonly tele = new Map<number, { fill: Drape; edge: Drape }>();
  /** Strike flashes: the full shape, bright, fading out quickly. */
  private readonly flashes: Array<{ d: Drape; age: number }> = [];
  private readonly bolts = new Map<number, BoltLook>();
  /** Casts, bolts and impacts. */
  readonly spells: SpellFx;
  private readonly aim: Drape;
  /** Yellow ring under the enemy you're auto-attacking. */
  private readonly target: Drape;
  private pulse = 0;
  private readonly numbers: Array<{ el: HTMLElement; pos: THREE.Vector3; age: number; dx: number }> = [];
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly groundAt: GroundAt,
    private readonly numberHost: HTMLElement,
  ) {
    this.group.name = "combat-fx";
    this.spells = new SpellFx(groundAt);
    this.group.add(this.spells.group);
    // Unit strip along +Z (scaled to width × range when shown), cut finely so it bends over hills.
    this.aim = new Drape(new THREE.PlaneGeometry(1, 1, 1, 40).rotateX(-Math.PI / 2).translate(0, 0, 0.5), markMat(0x9fd4ff, 0.32), 6);
    this.aim.mesh.visible = false;
    this.target = new Drape(new THREE.RingGeometry(0.82, 1, 32, 1).rotateX(-Math.PI / 2), markMat(0xffe14a, 0.9), 6);
    this.target.mesh.visible = false;
    this.group.add(this.aim.mesh, this.target.mesh);
  }

  // --- Telegraphs ---------------------------------------------------------------------------------

  private syncTelegraphs(world: CombatWorld): void {
    const live = new Set<number>();
    for (const t of world.telegraphs) {
      live.add(t.id);
      let m = this.tele.get(t.id);
      if (!m) {
        const edge = new Drape(edgeGeom(t), markMat(RED, t.attack.shape === "circle" ? 0.85 : 0.22), 5);
        const fill = new Drape(shapeGeom(t), markMat(RED, 0.38), 5);
        this.group.add(edge.mesh, fill.mesh);
        this.tele.set(t.id, (m = { fill, edge }));
      }
      // The fill grows from the centre (circles) or the enemy outward (lines, cones).
      const k = Math.min(1, t.t / t.attack.windup);
      const s = 0.05 + 0.95 * k;
      m.edge.place(this.groundAt, t.x, t.z, t.dirX, t.dirZ);
      if (t.attack.shape === "line") m.fill.place(this.groundAt, t.x, t.z, t.dirX, t.dirZ, 1, s, LIFT + 0.005);
      else m.fill.place(this.groundAt, t.x, t.z, t.dirX, t.dirZ, s, s, LIFT + 0.005);
      (m.fill.mesh.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.3 * k;
    }
    for (const [id, m] of this.tele) {
      if (live.has(id)) continue;
      for (const d of [m.fill, m.edge]) {
        this.group.remove(d.mesh);
        d.dispose();
      }
      this.tele.delete(id);
    }
  }

  // --- Projectiles --------------------------------------------------------------------------------

  private syncBolts(world: CombatWorld, alpha: number, dt: number): void {
    const live = new Set<number>();
    for (const p of world.projectiles) {
      live.add(p.id);
      const x = lerp(p.prevX, p.x, alpha);
      const z = lerp(p.prevZ, p.z, alpha);
      // Bolts fly at chest height, rising out of the hand over the first metre.
      const y = this.groundAt(x, z) + 0.8;
      let b = this.bolts.get(p.id);
      if (!b) this.bolts.set(p.id, (b = this.spells.makeBolt(p.visual, p.homing !== null, x, y, z)));
      this.spells.moveBolt(b, x, y, z, p.dirX, p.dirZ, dt);
    }
    for (const [id, b] of this.bolts) {
      if (live.has(id)) continue;
      this.spells.dropBolt(b);
      this.bolts.delete(id);
    }
  }

  // --- Aim line -----------------------------------------------------------------------------------

  /** Show the skillshot path from the player toward the cursor (null hides it). */
  setAim(from: { x: number; z: number } | null, to: { x: number; z: number } | null, length = 0, width = 0, pierce = false, ready = true): void {
    if (!from || !to) {
      this.aim.mesh.visible = false;
      return;
    }
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (Math.hypot(dx, dz) < 1e-3) return;
    this.aim.mesh.visible = true;
    // Thin strip = single target (stops at the first enemy); wide = hits everything in the line.
    const w = pierce ? Math.max(0.6, width) : Math.min(0.4, Math.max(0.25, width));
    this.aim.place(this.groundAt, from.x, from.z, dx, dz, w, length, 0.08);
    // Blue only when it can actually fire; red while cooling down or short on mana/energy.
    const mat = this.aim.mesh.material as THREE.MeshBasicMaterial;
    mat.color.setHex(ready ? 0x9fd4ff : 0xe0342a);
    mat.opacity = ready ? 0.32 : 0.28;
  }

  /** Ring under the auto-attack target (null hides it). */
  setTarget(t: { x: number; z: number; r: number } | null): void {
    this.target.mesh.visible = !!t;
    if (!t) return;
    this.pulse += 0.12;
    const s = t.r * (1 + Math.sin(this.pulse) * 0.06);
    this.target.place(this.groundAt, t.x, t.z, 0, 1, s, s, 0.07);
  }

  // --- Damage numbers -----------------------------------------------------------------------------

  /** Pop a number for each hit. `at(event)` gives the world point above the target. */
  showEvents(events: readonly CombatEvent[], at: (e: Extract<CombatEvent, { kind: "damage" }>) => THREE.Vector3): void {
    let swing: Extract<CombatEvent, { kind: "cast" }> | null = null;
    for (const e of events) {
      if (e.kind === "cast") {
        this.spells.cast(e.style, e.x, e.z, e.dirX, e.dirZ, e.skill, e.melee);
        if (e.melee) swing = e;
        continue;
      }
      if (e.kind === "projectileEnd") {
        this.spells.impact(e.style, e.x, e.z, e.hit, e.auto);
        continue;
      }
      if (e.kind !== "damage") continue;
      if (swing && e.target === "enemy") {
        this.spells.slash(swing.style, e.x, e.z, swing.dirX, swing.dirZ);
        swing = null;
      }
      const el = document.createElement("div");
      el.className = `dmg-num${e.crit ? " crit" : ""}${e.target === "player" ? " taken" : ""}`;
      el.textContent = String(e.amount);
      this.numberHost.append(el);
      this.numbers.push({ el, pos: at(e).clone(), age: 0, dx: (Math.random() - 0.5) * 30 });
    }
  }

  update(world: CombatWorld, camera: THREE.Camera, alpha: number, dt: number): void {
    // Every finished attack flashes where it landed, hit or miss.
    for (const t of world.struck) {
      const d = new Drape(shapeGeom(t), markMat(0xff6a4a, 0.85), 6);
      d.place(this.groundAt, t.x, t.z, t.dirX, t.dirZ, 1, 1, LIFT + 0.01);
      this.group.add(d.mesh);
      this.flashes.push({ d, age: 0 });
    }
    world.struck = [];
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]!;
      f.age += dt;
      (f.d.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - f.age / 0.25));
      if (f.age >= 0.25) {
        this.group.remove(f.d.mesh);
        f.d.dispose();
        this.flashes.splice(i, 1);
      }
    }
    this.syncTelegraphs(world);
    this.syncBolts(world, alpha, dt);
    const rect = this.numberHost.getBoundingClientRect();
    this.spells.setViewport(rect.height);
    this.spells.update(dt);
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]!;
      n.age += dt;
      if (n.age >= NUMBER_LIFE) {
        n.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      this.v.copy(n.pos).project(camera);
      const k = n.age / NUMBER_LIFE;
      n.el.style.left = `${((this.v.x + 1) / 2) * rect.width + n.dx * k}px`;
      n.el.style.top = `${((1 - this.v.y) / 2) * rect.height - 46 * k}px`;
      n.el.style.opacity = String(k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      n.el.hidden = this.v.z >= 1;
    }
  }
}
