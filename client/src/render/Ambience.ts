import * as THREE from "three";
import type { PropInstance } from "@levi/shared";
import { ParticlePool, glowTexture } from "./SpellFx.js";

type GroundAt = (x: number, z: number) => number;

/** Ley-crystal light: Tricode's lamps, pylons and clocks. */
const LEY = 0x6fe6dc;

/** Where a prop's light sits, relative to its cell centre before rotation: [x, y, z, glow size, colour?]. */
const LIGHTS: Record<string, [number, number, number, number, number?]> = {
  "lantern-post": [0.42, 1.72, 0, 1.4],
  candle: [0, 0.55, 0, 0.7],
  campfire: [0, 0.5, 0, 2.4],
  oven: [0, 0.7, 0.45, 0.9],
  "ley-lamp": [0, 2.83, 0, 1.3, LEY],
  "ley-pylon": [0, 4.6, 0, 2.6, LEY],
  "mana-pump": [0, 1.43, -0.35, 0.6, LEY],
  "mooring-mast": [0, 11.55, 0, 2.2, LEY],
  "gate-arch": [0, 6.45, 0, 1.8, LEY],
  "clock-face": [0, 3.52, 0.6, 1.3, LEY],
  "sky-barge": [0, 13.05, 2.2, 1.0, LEY],
};

const WARM = new THREE.Color(1, 0.72, 0.32);
const FLAME = new THREE.Color(1, 0.55, 0.15);
const SMOKE = new THREE.Color(0.32, 0.31, 0.3);
const MOTE = new THREE.Color(1, 0.95, 0.75);

interface Flock {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  speed: number;
  birds: Array<{ root: THREE.Group; wingL: THREE.Object3D; wingR: THREE.Object3D; phase: number; r: number; dy: number }>;
}

/**
 * Small life everywhere: lanterns and candles glow and flicker, campfires
 * burn and smoke, birds wheel over the island and the Cathedral, and motes
 * drift in the air around you. Purely visual.
 */
export class Ambience {
  readonly group = new THREE.Group();
  private readonly glows: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly lightPoints: THREE.Points;
  private readonly lightMat: THREE.PointsMaterial;
  private fires: Array<{ x: number; y: number; z: number }> = [];
  private source: readonly PropInstance[] | null = null;
  private readonly flocks: Flock[] = [];
  private t = 0;

  constructor(
    private readonly groundAt: GroundAt,
    flockCentres: ReadonlyArray<{ x: number; y: number; z: number; radius: number; count: number }>,
  ) {
    this.group.name = "ambience";
    const tex = glowTexture();
    this.glows = new ParticlePool(1400, tex);
    this.smoke = new ParticlePool(700, tex, false);
    this.lightMat = new THREE.PointsMaterial({ map: tex, vertexColors: true, size: 1.4, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.lightPoints = new THREE.Points(new THREE.BufferGeometry(), this.lightMat);
    this.lightPoints.frustumCulled = false;
    this.group.add(this.glows.points, this.smoke.points, this.lightPoints);

    const wingGeom = new THREE.BufferGeometry();
    wingGeom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -0.12, 0, 0, 0.18, 0.55, 0.02, 0.02], 3));
    wingGeom.computeVertexNormals();
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x2c2a2e, side: THREE.DoubleSide });
    for (const f of flockCentres) {
      const flock: Flock = { cx: f.x, cy: f.y, cz: f.z, radius: f.radius, speed: 0.12 + Math.random() * 0.06, birds: [] };
      for (let i = 0; i < f.count; i++) {
        const root = new THREE.Group();
        const wingL = new THREE.Mesh(wingGeom, birdMat);
        const wingR = new THREE.Mesh(wingGeom, birdMat);
        wingL.rotation.y = Math.PI;
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.4), birdMat);
        root.add(wingL, wingR, body);
        root.scale.setScalar(1.6);
        this.group.add(root);
        flock.birds.push({ root, wingL, wingR, phase: Math.random() * Math.PI * 2, r: f.radius * (0.75 + Math.random() * 0.5), dy: (Math.random() - 0.5) * 6 });
      }
      this.flocks.push(flock);
    }
  }

  setViewport(h: number): void {
    this.glows.setViewport(h);
    this.smoke.setViewport(h);
  }

  /** Find the lights among the placed props (again whenever the list changes). */
  private syncLights(props: readonly PropInstance[], storeyY: (p: PropInstance) => number): void {
    if (props === this.source) return;
    this.source = props;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    this.fires = [];
    for (const p of props) {
      const l = LIGHTS[p.prop];
      if (!l) continue;
      const a = (-p.rot * Math.PI) / 2;
      const ox = l[0] * Math.cos(a) + l[2] * Math.sin(a);
      const oz = -l[0] * Math.sin(a) + l[2] * Math.cos(a);
      const x = p.x + 0.5 + ox;
      const z = p.z + 0.5 + oz;
      const y = storeyY(p) + l[1];
      pos.push(x, y, z);
      c.set(l[4] ?? WARM);
      col.push(c.r, c.g, c.b);
      if (p.prop === "campfire") this.fires.push({ x, y: y - 0.4, z });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.lightPoints.geometry.dispose();
    this.lightPoints.geometry = g;
  }

  update(dt: number, player: { x: number; z: number }, props: readonly PropInstance[], propY: (p: PropInstance) => number): void {
    this.t += dt;
    this.syncLights(props, propY);
    // Lights breathe.
    this.lightMat.opacity = 0.72 + Math.sin(this.t * 7.3) * 0.06 + Math.sin(this.t * 13.1) * 0.04;
    this.lightMat.size = 1.35 + Math.sin(this.t * 5.7) * 0.08;

    for (const f of this.fires) {
      if (Math.abs(f.x - player.x) > 60 || Math.abs(f.z - player.z) > 60) continue;
      if (Math.random() < dt * 14) {
        this.glows.emit({ x: f.x + (Math.random() - 0.5) * 0.4, y: f.y + 0.2, z: f.z + (Math.random() - 0.5) * 0.4, vy: 1.4 + Math.random(), color: FLAME, life: 0.55, size0: 0.45, size1: 0.05, drag: 0.6 });
      }
      if (Math.random() < dt * 4) {
        this.glows.emit({ x: f.x, y: f.y + 0.6, z: f.z, vx: (Math.random() - 0.5) * 0.6, vy: 2.2, vz: (Math.random() - 0.5) * 0.6, color: WARM, life: 1.1, size0: 0.09, size1: 0, drag: 0.3 });
      }
      if (Math.random() < dt * 5) {
        this.smoke.emit({ x: f.x, y: f.y + 1, z: f.z, vx: 0.25 + Math.random() * 0.2, vy: 0.9 + Math.random() * 0.4, vz: (Math.random() - 0.5) * 0.3, color: SMOKE, alpha: 0.35, life: 3.6, size0: 0.6, size1: 2.4, drag: 0.15 });
      }
    }

    // Motes drifting in the air around you.
    if (Math.random() < dt * 7) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 11;
      const x = player.x + Math.cos(a) * r;
      const z = player.z + Math.sin(a) * r;
      this.glows.emit({ x, y: this.groundAt(x, z) + 0.4 + Math.random() * 2.5, z, vx: 0.25, vy: 0.12, vz: (Math.random() - 0.5) * 0.2, color: MOTE, alpha: 0.55, life: 4 + Math.random() * 2, size0: 0.08, size1: 0.02 });
    }

    for (const f of this.flocks) {
      for (const b of f.birds) {
        const ang = this.t * f.speed + b.phase;
        const x = f.cx + Math.cos(ang) * b.r;
        const z = f.cz + Math.sin(ang) * b.r * 0.8;
        const y = f.cy + b.dy + Math.sin(ang * 3) * 1.5;
        b.root.position.set(x, y, z);
        // Face along the circle (counter-clockwise tangent).
        b.root.rotation.y = Math.atan2(-Math.sin(ang), Math.cos(ang) * 0.8);
        const flap = Math.sin(this.t * 9 + b.phase * 3) * (0.5 + 0.5 * Math.max(0, Math.sin(this.t * 0.7 + b.phase)));
        b.wingL.rotation.z = flap * 0.7;
        b.wingR.rotation.z = -flap * 0.7;
      }
    }

    this.glows.update(dt);
    this.smoke.update(dt);
  }
}
