import * as THREE from "three";
import type { CombatStyle } from "@levi/shared";

type GroundAt = (x: number, z: number) => number;

/** Look of each combat style's shots. Colours are linear-ish RGB for additive blending. */
interface StylePalette {
  core: THREE.Color;
  glow: THREE.Color;
  spark: THREE.Color;
}

const PALETTE: Record<CombatStyle, StylePalette> = {
  // Golden arcane light: white-hot core, gold body, pale blue sparks.
  mage: { core: new THREE.Color(1, 0.98, 0.85), glow: new THREE.Color(1, 0.58, 0.12), spark: new THREE.Color(0.55, 0.8, 1) },
  // Wind-cut arrows: pale green streaks.
  ranger: { core: new THREE.Color(1, 1, 0.9), glow: new THREE.Color(0.55, 0.95, 0.55), spark: new THREE.Color(0.85, 1, 0.75) },
  // Steel edge: white crescent, hot orange sparks.
  brawler: { core: new THREE.Color(1, 1, 1), glow: new THREE.Color(0.75, 0.85, 1), spark: new THREE.Color(1, 0.62, 0.25) },
};

/** Soft round glow, drawn once onto a canvas. */
export function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.22, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size0: number; size1: number;
  r: number; g: number; b: number;
  alpha: number;
  gravity: number;
  drag: number;
}

/**
 * Additive glow particles with per-particle size, colour and fade, all in
 * one draw call. Fixed capacity; the oldest are recycled when it's full.
 */
export class ParticlePool {
  readonly points: THREE.Points;
  private readonly list: Particle[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly geom = new THREE.BufferGeometry();

  /** `additive` false = normal blending (smoke, dust) instead of glowing light. */
  constructor(private readonly cap: number, tex: THREE.Texture, additive = true) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute("size", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 400 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec4 color;
        uniform float scale;
        varying vec4 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec4 vColor;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          ${additive ? "gl_FragColor = vec4(vColor.rgb * t.a * vColor.a, 1.0);" : "gl_FragColor = vec4(vColor.rgb, t.a * vColor.a);"}
        }`,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(this.geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
  }

  /** Pixel scale = half the viewport height (so size is in world units). */
  setViewport(h: number): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    (this.points.material as THREE.ShaderMaterial).uniforms["scale"]!.value = (h * dpr) / 2 / Math.tan((50 * Math.PI) / 360);
  }

  emit(p: Partial<Particle> & { x: number; y: number; z: number; color: THREE.Color }): void {
    const q: Particle = {
      x: p.x, y: p.y, z: p.z,
      vx: p.vx ?? 0, vy: p.vy ?? 0, vz: p.vz ?? 0,
      age: 0, life: p.life ?? 0.4,
      size0: p.size0 ?? 0.4, size1: p.size1 ?? 0,
      r: p.color.r, g: p.color.g, b: p.color.b,
      alpha: p.alpha ?? 1,
      gravity: p.gravity ?? 0,
      drag: p.drag ?? 0,
    };
    if (this.list.length >= this.cap) this.list.shift();
    this.list.push(q);
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.list.splice(i, 1);
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy *= k; p.vz *= k;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
    for (const p of this.list) {
      const t = p.age / p.life;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      // Quick fade in, long fade out.
      const a = p.alpha * Math.min(1, t * 12) * (1 - t) * (1 - t * 0.3);
      this.col[n * 4] = p.r; this.col[n * 4 + 1] = p.g; this.col[n * 4 + 2] = p.b; this.col[n * 4 + 3] = a;
      this.size[n] = p.size0 + (p.size1 - p.size0) * t;
      n++;
    }
    this.geom.setDrawRange(0, n);
    for (const name of ["position", "color", "size"]) (this.geom.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Short-lived meshes: ground rings, slash crescents, flashes. */
interface Flash {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  grow: number;
  opacity: number;
  /** Moves along this direction (world units / s). */
  vx: number;
  vz: number;
}

const additive = (color: THREE.Color, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });

/** A projectile's look while it flies. */
export interface BoltLook {
  root: THREE.Group;
  style: CombatStyle;
  auto: boolean;
  lastX: number;
  lastY: number;
  lastZ: number;
  spin: number;
  age: number;
  trail: number;
}

/**
 * Spell and weapon visuals: a glowing charge at the hand when you cast,
 * bolts with a bright core, halo and a trail of light, and a burst where
 * they land. Each combat style has its own look (gold arcane bolts, wind-cut
 * arrows, steel crescents). Visual only; the sim decides what hits.
 */
export class SpellFx {
  readonly group = new THREE.Group();
  private readonly glowTex = glowTexture();
  private readonly glows: ParticlePool;
  private readonly flashes: Flash[] = [];
  private readonly ringGeom = new THREE.RingGeometry(0.75, 1, 40, 1).rotateX(-Math.PI / 2);
  private readonly glyphGeom: THREE.BufferGeometry;
  private readonly crescentGeom = new THREE.RingGeometry(0.55, 1, 24, 1, Math.PI * 0.18, Math.PI * 0.64).rotateX(-Math.PI / 2);
  private readonly coreGeom = new THREE.IcosahedronGeometry(1, 1);
  private readonly arrowParts: Array<{ geom: THREE.BufferGeometry; color: number }>;

  constructor(private readonly groundAt: GroundAt) {
    this.group.name = "spell-fx";
    this.glows = new ParticlePool(1600, this.glowTex);
    this.group.add(this.glows.points);
    this.glyphGeom = this.makeGlyph();
    // Arrow along +Z: shaft, head, fletching.
    this.arrowParts = [
      { geom: new THREE.CylinderGeometry(0.025, 0.025, 0.9, 4).rotateX(Math.PI / 2), color: 0x8a5a35 },
      { geom: new THREE.ConeGeometry(0.07, 0.2, 4).rotateX(Math.PI / 2).translate(0, 0, 0.53), color: 0xd8dde2 },
      { geom: new THREE.BoxGeometry(0.16, 0.01, 0.18).translate(0, 0, -0.38), color: 0xe9e4d4 },
      { geom: new THREE.BoxGeometry(0.01, 0.16, 0.18).translate(0, 0, -0.38), color: 0xe9e4d4 },
    ];
  }

  /** A rune circle: two rings with a star of ticks, flat on the ground. */
  private makeGlyph(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [new THREE.RingGeometry(0.88, 1, 48, 1), new THREE.RingGeometry(0.58, 0.64, 48, 1)];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tick = new THREE.PlaneGeometry(0.05, 0.3).translate(0, 0.76, 0).rotateZ(a);
      parts.push(tick);
    }
    const merged = mergeGeoms(parts);
    merged.rotateX(-Math.PI / 2);
    return merged;
  }

  setViewport(height: number): void {
    this.glows.setViewport(height);
  }

  // --- Casting ------------------------------------------------------------------------------------

  /** The player cast (skill) or attacked (auto) from (x, z) toward (dirX, dirZ). */
  cast(style: CombatStyle, x: number, z: number, dirX: number, dirZ: number, skill: boolean, melee = false): void {
    if (melee) return; // melee swings show where they land (slash)
    const pal = PALETTE[style];
    const gy = this.groundAt(x, z);
    const hx = x + dirX * 0.55;
    const hz = z + dirZ * 0.55;
    const hy = gy + 1.05;
    // Gathering flash at the hand.
    this.glows.emit({ x: hx, y: hy, z: hz, color: pal.glow, size0: skill ? 1.4 : 0.8, size1: 0.2, life: 0.22 });
    this.glows.emit({ x: hx, y: hy, z: hz, color: pal.core, size0: skill ? 0.7 : 0.4, size1: 0.1, life: 0.16 });
    const n = skill ? 14 : 6;
    for (let i = 0; i < n; i++) {
      // A cone of sparks thrown forward.
      const spread = (Math.random() - 0.5) * 1.6;
      const s = 3 + Math.random() * 4;
      const dx = dirX * Math.cos(spread) - dirZ * Math.sin(spread);
      const dz = dirZ * Math.cos(spread) + dirX * Math.sin(spread);
      this.glows.emit({ x: hx, y: hy, z: hz, vx: dx * s, vy: (Math.random() - 0.2) * 2.5, vz: dz * s, drag: 5, color: pal.spark, size0: 0.16, size1: 0, life: 0.3 + Math.random() * 0.2 });
    }
    if (!skill) return;
    // Skills also flare a rune circle at your feet.
    const glyph = new THREE.Mesh(this.glyphGeom, additive(pal.glow, 0.85));
    glyph.position.set(x, gy + 0.08, z);
    glyph.rotation.y = Math.atan2(dirX, dirZ);
    glyph.renderOrder = 7;
    this.addFlash(glyph, 0.45, 0.9, 0.85);
    glyph.scale.setScalar(0.6);
  }

  /** Melee swing landing on an enemy at (x, z), coming from direction (dirX, dirZ). */
  slash(style: CombatStyle, x: number, z: number, dirX: number, dirZ: number): void {
    const pal = PALETTE[style];
    const gy = this.groundAt(x, z);
    const m = new THREE.Mesh(this.crescentGeom, additive(pal.core, 0.95));
    m.position.set(x - dirX * 0.3, gy + 0.9, z - dirZ * 0.3);
    m.rotation.order = "YXZ";
    m.rotation.set(0.5, Math.atan2(dirX, dirZ) + Math.PI, Math.random() < 0.5 ? 0.6 : -0.6);
    m.scale.setScalar(0.7);
    m.renderOrder = 8;
    this.addFlash(m, 0.18, 0.6, 0.95);
    this.burst(style, x, gy + 0.9, z, 0.6);
  }

  // --- Bolts --------------------------------------------------------------------------------------

  /** Create the look for a new projectile. */
  makeBolt(style: CombatStyle, auto: boolean, x: number, y: number, z: number): BoltLook {
    const pal = PALETTE[style];
    const root = new THREE.Group();
    if (style === "ranger") {
      for (const p of this.arrowParts) root.add(new THREE.Mesh(p.geom, new THREE.MeshLambertMaterial({ color: p.color, flatShading: true })));
      const streak = new THREE.Mesh(this.coreGeom, additive(pal.glow, 0.5));
      streak.scale.set(0.06, 0.06, 0.7);
      streak.position.z = -0.2;
      root.add(streak);
    } else if (style === "brawler") {
      const c = new THREE.Mesh(this.crescentGeom, additive(pal.core, 0.95));
      c.rotation.y = Math.PI; // open side trails behind
      c.scale.setScalar(auto ? 0.5 : 0.9);
      c.position.z = -0.75 * (auto ? 0.5 : 0.9);
      const c2 = new THREE.Mesh(this.crescentGeom, additive(pal.glow, 0.45));
      c2.rotation.y = Math.PI;
      c2.scale.setScalar(auto ? 0.6 : 1.1);
      c2.position.z = -0.75 * (auto ? 0.6 : 1.1) - 0.12;
      root.add(c, c2);
    } else {
      const core = new THREE.Mesh(this.coreGeom, additive(pal.core, 1));
      core.scale.set(auto ? 0.11 : 0.16, auto ? 0.11 : 0.16, auto ? 0.2 : 0.42);
      const shell = new THREE.Mesh(this.coreGeom, additive(pal.glow, 0.55));
      shell.scale.set(auto ? 0.2 : 0.3, auto ? 0.2 : 0.3, auto ? 0.32 : 0.75);
      shell.position.z = -0.08;
      root.add(core, shell);
    }
    root.position.set(x, y, z);
    this.group.add(root);
    return { root, style, auto, lastX: x, lastY: y, lastZ: z, spin: 0, age: 0, trail: 0 };
  }

  /** Move a bolt's look and shed its trail. */
  moveBolt(b: BoltLook, x: number, y: number, z: number, dirX: number, dirZ: number, dt: number): void {
    const pal = PALETTE[b.style];
    b.age += dt;
    b.root.position.set(x, y, z);
    b.root.rotation.set(0, Math.atan2(dirX, dirZ), 0);
    b.spin += dt * 14;
    if (b.style === "mage") {
      // A wobbling shell and a pulsing halo read as living light, not a ball.
      const shell = b.root.children[1]!;
      shell.rotation.z = b.spin;
      const pulse = 1 + Math.sin(b.age * 40) * 0.12;
      shell.scale.x = shell.scale.y = (b.auto ? 0.2 : 0.3) * pulse;
    } else if (b.style === "brawler") {
      const k = Math.min(1, b.age / 0.08);
      b.root.scale.setScalar(0.5 + 0.5 * k);
    }
    // Trail: glow puffs laid densely along the path since last frame.
    const dx = x - b.lastX, dy = y - b.lastY, dz = z - b.lastZ;
    const dist = Math.hypot(dx, dy, dz);
    const spacing = b.style === "mage" ? (b.auto ? 0.12 : 0.09) : b.style === "ranger" ? 0.14 : 0.1;
    b.trail += dist;
    while (b.trail >= spacing) {
      b.trail -= spacing;
      const f = dist > 0 ? 1 - b.trail / dist : 1;
      const px = b.lastX + dx * f, py = b.lastY + dy * f, pz = b.lastZ + dz * f;
      if (b.style === "mage") {
        this.glows.emit({ x: px, y: py, z: pz, color: pal.glow, size0: b.auto ? 0.4 : 0.62, size1: 0.05, life: b.auto ? 0.16 : 0.28, alpha: b.auto ? 0.35 : 0.3 });
        if (Math.random() < (b.auto ? 0.15 : 0.35)) {
          this.glows.emit({ x: px, y: py, z: pz, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.3) * 2, vz: (Math.random() - 0.5) * 2, drag: 3, color: pal.spark, size0: 0.14, size1: 0, life: 0.35 + Math.random() * 0.25 });
        }
      } else if (b.style === "ranger") {
        this.glows.emit({ x: px, y: py, z: pz, color: pal.glow, size0: b.auto ? 0.16 : 0.3, size1: 0, life: 0.16, alpha: 0.6 });
      } else {
        // Steel shimmer at both horns of the crescent.
        const sx = -dirZ, sz = dirX;
        for (const side of [-1, 1]) {
          this.glows.emit({ x: px + sx * side * 0.7 * (b.auto ? 0.5 : 1), y: py, z: pz + sz * side * 0.7 * (b.auto ? 0.5 : 1), color: pal.glow, size0: 0.3, size1: 0, life: 0.14, alpha: 0.7 });
        }
      }
    }
    b.lastX = x; b.lastY = y; b.lastZ = z;
  }

  /** Remove a bolt's look (the impact is shown separately). */
  dropBolt(b: BoltLook): void {
    this.group.remove(b.root);
    for (const c of b.root.children) {
      if (c instanceof THREE.Mesh) (c.material as THREE.Material).dispose();
    }
  }

  // --- Impacts ------------------------------------------------------------------------------------

  /** A projectile ended at (x, z): a burst on a hit, a small puff on a wall or at full range. */
  impact(style: CombatStyle, x: number, z: number, hit: boolean, auto: boolean): void {
    const gy = this.groundAt(x, z);
    const y = gy + (style === "ranger" ? 0.7 : 0.75);
    if (!hit) {
      this.burst(style, x, y, z, 0.35);
      return;
    }
    const big = auto ? 0.6 : 1;
    this.burst(style, x, y, z, big);
    const pal = PALETTE[style];
    const ring = new THREE.Mesh(this.ringGeom, additive(pal.glow, 0.8));
    ring.position.set(x, gy + 0.1, z);
    ring.renderOrder = 7;
    ring.scale.setScalar(0.2);
    this.addFlash(ring, 0.3, auto ? 1.1 : 1.8, 0.8);
  }

  /** Flash + a sphere of sparks. */
  private burst(style: CombatStyle, x: number, y: number, z: number, size: number): void {
    const pal = PALETTE[style];
    this.glows.emit({ x, y, z, color: pal.glow, size0: 2.2 * size, size1: 0.4, life: 0.2 });
    this.glows.emit({ x, y, z, color: pal.core, size0: 1.1 * size, size1: 0.1, life: 0.12 });
    const n = Math.round(16 * size);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9 + 0.1;
      const s = (3 + Math.random() * 5) * (0.6 + size * 0.4);
      this.glows.emit({
        x, y, z,
        vx: Math.cos(th) * s * (1 - up * 0.5), vy: up * s, vz: Math.sin(th) * s * (1 - up * 0.5),
        gravity: 12, drag: 2.5, color: i % 3 === 0 ? pal.core : pal.spark,
        size0: 0.18, size1: 0, life: 0.35 + Math.random() * 0.3,
      });
    }
  }

  private addFlash(mesh: THREE.Mesh, life: number, grow: number, opacity: number, vx = 0, vz = 0): void {
    this.group.add(mesh);
    this.flashes.push({ mesh, age: 0, life, grow, opacity, vx, vz });
  }

  update(dt: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]!;
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) {
        this.group.remove(f.mesh);
        (f.mesh.material as THREE.Material).dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - t) * (1 - t);
      const s0 = (f.mesh.userData["s0"] as number | undefined) ?? f.mesh.scale.x;
      f.mesh.userData["s0"] = s0;
      f.mesh.scale.setScalar(s0 + (f.grow - s0) * ease);
      f.mesh.position.x += f.vx * dt;
      f.mesh.position.z += f.vz * dt;
      f.mesh.rotation.y += dt * 1.5;
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = f.opacity * (1 - t);
    }
    this.glows.update(dt);
  }
}

/** Merge non-indexed copies of simple geometries (positions only). */
function mergeGeoms(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out: number[] = [];
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    const p = ng.getAttribute("position");
    for (let i = 0; i < p.count; i++) out.push(p.getX(i), p.getY(i), p.getZ(i));
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return m;
}
