import type { CombatStyle, FacetRing, ITEM_ICONS, ModelPart, SkillDef } from "@levi/shared";
import type { IconModel } from "./IconRenderer.js";

/**
 * Item and skill icons as tiny low-poly models, built from the same faceted
 * lathe every prop and character in the world is made of, so the bag and
 * the skill bar look like they belong to the game.
 */

type V3 = [number, number, number];
type V2 = [number, number];
interface Opts {
  sides?: number;
  pos?: V3;
  rot?: V3;
  twist?: boolean;
  phase?: number;
}

const DEG = 180 / Math.PI;

function hexRgb(h: string): V3 {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as V3;
}
const toHex = (c: V3): string => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
/** Brighten (k > 0) or darken (k < 0). */
export function shade(hex: string, k: number): string {
  return toHex(hexRgb(hex).map((c) => (k >= 0 ? c + (255 - c) * k : c * (1 + k))) as V3);
}
function mix(a: string, b: string, t: number): string {
  const x = hexRgb(a), y = hexRgb(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as V3);
}

/** Collects parts for one model. */
class Kit {
  readonly parts: ModelPart[] = [];

  lathe(color: string, rings: FacetRing[], o: Opts = {}): this {
    this.parts.push({
      id: `p${this.parts.length}`,
      color,
      sides: o.sides ?? 6,
      rings,
      pos: o.pos ?? [0, 0, 0],
      offset: [0, 0, 0],
      rot: o.rot ?? [0, 0, 0],
      twist: o.twist ?? true,
      phase: o.phase ?? 0,
      scale: 1,
    });
    return this;
  }

  /** Box centred on `pos`. */
  box(color: string, w: number, h: number, d: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0]): this {
    const k = Math.SQRT1_2;
    return this.lathe(color, [[-h / 2, w * k, d * k], [h / 2, w * k, d * k]], { sides: 4, twist: false, phase: 45, pos, rot });
  }

  /** A rod from a to b in the picture plane (radius r0 → r1). */
  seg(color: string, a: V2, b: V2, r0: number, r1 = r0, sides = 6, z = 0): this {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    return this.lathe(color, [[0, r0, r0], [len, r1, r1]], { sides, pos: [a[0], a[1], z], rot: [0, 0, Math.atan2(-dx, dy) * DEG], twist: false });
  }

  /** A pointed shard from a to b (blades, spikes, arrowheads): diamond cross-section. */
  shard(color: string, a: V2, b: V2, w: number, thick = w * 0.35, at = 0.3, z = 0): this {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    return this.lathe(color, [[0, 0, 0], [len * at, w, thick], [len, 0, 0]], { sides: 4, pos: [a[0], a[1], z], rot: [0, 0, Math.atan2(-dx, dy) * DEG], twist: false });
  }

  /** Round blob (gems, orbs, heads). */
  ball(color: string, c: V3, r: number, sides = 8, squash = 1): this {
    return this.lathe(color, [[-r * squash, 0, 0], [-r * 0.7 * squash, r * 0.72, r * 0.72], [0, r, r], [r * 0.7 * squash, r * 0.72, r * 0.72], [r * squash, 0, 0]], { sides, pos: c });
  }

  /** A loop of short rods (key bows, chain links, halos). */
  loop(color: string, c: V2, R: number, r: number, n = 8): this {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      this.seg(color, [c[0] + Math.cos(a0) * R, c[1] + Math.sin(a0) * R], [c[0] + Math.cos(a1) * R, c[1] + Math.sin(a1) * R], r, r, 5);
    }
    return this;
  }

  done(view: Omit<IconModel, "parts"> = {}): IconModel {
    return { parts: this.parts, ...view };
  }
}

const STEEL = "#c4cad3";
const STEEL_DARK = "#7d848f";
const WOOD = "#7a5234";
const LEATHER = "#5b3f2a";
const GOLD = "#d9b44a";
const PAPER = "#efe6cf";
const RED = "#b8402f";
const INK = "#3a2e22";

type ItemIcon = (typeof ITEM_ICONS)[number];

/** The model for an item glyph, tinted by the item's colour. */
export function itemModel(icon: ItemIcon, main: string): IconModel {
  const dark = shade(main, -0.38);
  const light = shade(main, 0.35);
  const k = new Kit();
  switch (icon) {
    case "sword":
      k.lathe(main, [[0, 0.27, 0.08], [1.9, 0.27, 0.08], [2.45, 0, 0]], { sides: 4, twist: false, pos: [0, 0.3, 0] });
      k.box(GOLD, 1.25, 0.2, 0.34, [0, 0.25, 0]);
      k.lathe(LEATHER, [[-0.5, 0.12, 0.12], [0.18, 0.12, 0.12]]);
      k.lathe(GOLD, [[-0.8, 0, 0], [-0.66, 0.2, 0.2], [-0.5, 0.12, 0.12]]);
      return k.done({ tilt: -45, yaw: 30 });
    case "dagger":
      k.lathe(main, [[0, 0.26, 0.08], [0.95, 0.22, 0.08], [1.45, 0, 0]], { sides: 4, twist: false, pos: [0, 0.25, 0] });
      k.box(dark, 0.95, 0.18, 0.3, [0, 0.2, 0]);
      k.lathe(LEATHER, [[-0.42, 0.12, 0.12], [0.14, 0.12, 0.12]]);
      k.ball(dark, [0, -0.52, 0], 0.17, 6);
      return k.done({ tilt: -45, yaw: 30 });
    case "bow": {
      const R = 1.8, tip = (55 * Math.PI) / 180, c = R * Math.cos(tip);
      const pt = (t: number): V2 => [c - R * Math.cos(t), R * Math.sin(t)];
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t0 = -tip + (2 * tip * i) / n, t1 = -tip + (2 * tip * (i + 1)) / n;
        const mid = 1 - Math.abs((i + 0.5) / n - 0.5) * 2;
        k.seg(main, pt(t0), pt(t1), 0.08 + mid * 0.08, 0.08 + mid * 0.08, 5);
      }
      k.seg(LEATHER, [c - R - 0.02, -0.28], [c - R - 0.02, 0.3], 0.19, 0.19, 6);
      k.seg("#ece6d6", pt(-tip), pt(tip), 0.04, 0.04, 4);
      k.shard(STEEL, [0.15, -0.2], [0.15, 0.2], 0.01); // arrow nock glint
      return k.done({ tilt: -45, yaw: 18 });
    }
    case "gun":
      k.lathe(main, [[0, 0.11, 0.11], [1.55, 0.1, 0.1]], { pos: [-0.2, 0.36, 0], rot: [0, 0, -90], sides: 7 });
      k.lathe(dark, [[1.5, 0.13, 0.13], [1.6, 0.13, 0.13]], { pos: [-0.2, 0.36, 0], rot: [0, 0, -90], sides: 7 });
      k.box(WOOD, 1.0, 0.3, 0.26, [-0.35, 0.24, 0]);
      k.box(WOOD, 0.36, 0.85, 0.26, [-0.86, -0.18, 0], [0, 0, 28]);
      k.box(dark, 0.14, 0.26, 0.12, [-0.6, 0.5, 0], [0, 0, -20]);
      k.seg(dark, [-0.45, 0.1], [-0.3, -0.12], 0.04, 0.04, 4);
      k.ball(GOLD, [-1.02, -0.56, 0], 0.13, 6);
      return k.done({ yaw: 20 });
    case "staff": {
      const crystal = mix(light, "#a8dcff", 0.45);
      k.lathe(main, [[-1.6, 0.12, 0.12], [1.25, 0.15, 0.15]], { sides: 6 });
      for (const y of [-0.6, 0.9]) k.lathe(GOLD, [[y, 0.18, 0.18], [y + 0.14, 0.18, 0.18]], { sides: 6, twist: false });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        k.lathe(GOLD, [[0, 0.08, 0.08], [0.6, 0, 0]], { sides: 3, pos: [Math.cos(a) * 0.17, 1.2, Math.sin(a) * 0.17], rot: [Math.sin(a) * 22, 0, -Math.cos(a) * 22] });
      }
      k.lathe(crystal, [[0, 0, 0], [0.36, 0.36, 0.36], [0.95, 0, 0]], { sides: 4, pos: [0, 1.3, 0] });
      return k.done({ tilt: -45, yaw: 30 });
    }
    case "wand":
      k.lathe(main, [[-0.5, 0.1, 0.1], [1.0, 0.12, 0.12]], { sides: 6 });
      k.lathe(LEATHER, [[-1.1, 0.13, 0.13], [-0.45, 0.135, 0.135]], { sides: 6 });
      k.ball(GOLD, [0, -1.1, 0], 0.17, 6);
      k.lathe(light, [[0, 0, 0], [0.22, 0.3, 0.3], [0.55, 0, 0]], { sides: 4, pos: [0, 0.98, 0] });
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        k.shard(GOLD, [Math.cos(a) * 0.12, 1.2 + Math.sin(a) * 0.12], [Math.cos(a) * 0.5, 1.2 + Math.sin(a) * 0.5], 0.1);
      }
      return k.done({ tilt: -45, yaw: 25 });
    case "helm":
      k.lathe(main, [[0, 0.78, 0.8], [0.45, 0.8, 0.82], [0.85, 0.62, 0.64], [1.1, 0.3, 0.3], [1.18, 0, 0]], { sides: 8 });
      k.lathe(dark, [[-0.02, 0.84, 0.86], [0.14, 0.84, 0.86]], { sides: 8, twist: false });
      k.box(dark, 0.13, 0.62, 0.1, [0, 0.3, 0.8]);
      k.box(dark, 0.12, 0.22, 1.0, [0, 1.15, 0]);
      return k.done({ yaw: 32, pitch: 10 });
    case "chest":
      k.lathe(main, [[0, 0.55, 0.32], [0.5, 0.6, 0.35], [1.0, 0.78, 0.42], [1.25, 0.62, 0.36], [1.34, 0.26, 0.22]], { sides: 6 });
      for (const s of [-1, 1]) k.lathe(dark, [[-0.2, 0, 0], [-0.05, 0.28, 0.28], [0.15, 0.22, 0.22]], { sides: 5, pos: [s * 0.72, 1.12, 0] });
      k.box(LEATHER, 1.18, 0.16, 0.72, [0, 0.18, 0]);
      k.box(GOLD, 0.2, 0.18, 0.1, [0, 0.18, 0.36]);
      k.lathe(dark, [[1.28, 0.32, 0.26], [1.42, 0.22, 0.18]], { sides: 6 });
      return k.done({ yaw: 25 });
    case "legs":
      k.box(dark, 1.15, 0.26, 0.6, [0, 1.72, 0]);
      for (const s of [-1, 1]) {
        k.lathe(main, [[0, 0.2, 0.22], [0.8, 0.24, 0.26], [1.62, 0.31, 0.3]], { sides: 6, pos: [s * 0.29, 0, 0], rot: [0, 0, s * 4] });
        k.lathe(dark, [[0.7, 0.27, 0.29], [0.9, 0.27, 0.29]], { sides: 6, pos: [s * 0.32, 0, 0], rot: [0, 0, s * 4] });
      }
      return k.done({ yaw: 22 });
    case "boots":
      k.lathe(main, [[0.3, 0.25, 0.27], [1.15, 0.27, 0.29], [1.32, 0.31, 0.33]], { sides: 6, pos: [-0.18, 0, 0] });
      k.box(main, 1.05, 0.38, 0.52, [0.18, 0.22, 0]);
      k.box(dark, 1.14, 0.12, 0.58, [0.2, 0.04, 0]);
      k.lathe(dark, [[1.18, 0.31, 0.33], [1.32, 0.33, 0.35]], { sides: 6, twist: false, pos: [-0.18, 0, 0] });
      return k.done({ yaw: 30 });
    case "shield":
      k.lathe(dark, [[-0.05, 1.0, 1.2], [0.1, 1.0, 1.2]], { sides: 6, twist: false, rot: [90, 0, 0] });
      k.lathe(main, [[0, 0.9, 1.1], [0.14, 0.9, 1.1], [0.24, 0.7, 0.88], [0.27, 0, 0]], { sides: 6, twist: false, rot: [90, 0, 0] });
      k.lathe(GOLD, [[0.22, 0.24, 0.24], [0.36, 0.18, 0.18], [0.44, 0, 0]], { sides: 6, rot: [90, 0, 0] });
      return k.done({ yaw: 22 });
    case "orb":
      k.lathe(GOLD, [[0, 0.5, 0.5], [0.14, 0.46, 0.46], [0.22, 0.24, 0.24], [0.36, 0.42, 0.42]], { sides: 6 });
      k.ball(main, [0, 1.15, 0], 0.85, 8);
      return k.done({ yaw: 15 });
    case "talisman":
      for (const s of [-1, 1]) k.seg(GOLD, [0, 0.12], [s * 0.5, 0.95], 0.035, 0.035, 4);
      k.lathe(GOLD, [[-0.1, 0, 0], [0.56, 0.56, 0.14], [1.32, 0, 0]], { sides: 4, pos: [0, -1.28, -0.02], twist: false });
      k.lathe(main, [[0, 0, 0], [0.56, 0.44, 0.2], [1.2, 0, 0]], { sides: 4, pos: [0, -1.2, 0], twist: false });
      k.ball(GOLD, [0, 0.08, 0], 0.1, 6);
      return k.done({ yaw: 25 });
    case "potion":
      k.lathe(main, [[0, 0.35, 0.35], [0.1, 0.55, 0.55], [0.55, 0.62, 0.62], [0.85, 0.4, 0.4], [1.05, 0.18, 0.18], [1.42, 0.18, 0.18]], { sides: 8 });
      k.lathe("#dbeef3", [[1.38, 0.24, 0.24], [1.5, 0.24, 0.24]], { sides: 8, twist: false });
      k.lathe(WOOD, [[1.48, 0.15, 0.15], [1.74, 0.17, 0.17]], { sides: 6 });
      return k.done({ yaw: 20 });
    case "bottle":
      k.lathe(main, [[0, 0.42, 0.42], [1.0, 0.45, 0.45], [1.25, 0.25, 0.25], [1.35, 0.13, 0.13], [1.85, 0.13, 0.13]], { sides: 7 });
      k.lathe(WOOD, [[1.82, 0.11, 0.11], [2.05, 0.13, 0.13]], { sides: 6 });
      k.box(PAPER, 0.58, 0.42, 0.06, [0, 0.52, 0.42]);
      return k.done({ yaw: 15 });
    case "bread":
      k.lathe(main, [[-1.1, 0, 0], [-0.95, 0.35, 0.42], [-0.5, 0.48, 0.55], [0.5, 0.48, 0.55], [0.95, 0.35, 0.42], [1.1, 0, 0]], { sides: 7, rot: [0, 0, 90] });
      for (const x of [-0.45, 0, 0.45]) k.box(light, 0.08, 0.06, 0.55, [x, 0.46, 0], [0, 35, 0]);
      return k.done({ yaw: 20, pitch: 30 });
    case "fish":
      k.lathe(main, [[-0.9, 0.06, 0.04], [-0.5, 0.32, 0.14], [0.2, 0.46, 0.18], [0.75, 0.3, 0.14], [1.0, 0, 0]], { sides: 6, rot: [0, 0, -90] });
      k.lathe(dark, [[0, 0.03, 0.02], [0.55, 0.46, 0.04]], { sides: 4, twist: false, pos: [-0.82, 0, 0], rot: [0, 0, 90] });
      k.lathe(dark, [[0, 0.02, 0.02], [0.3, 0.28, 0.03]], { sides: 4, twist: false, pos: [0, 0.4, 0], rot: [0, 0, 10] });
      k.ball(INK, [0.68, 0.1, 0.13], 0.06, 5);
      return k.done({ yaw: 12, tilt: 8 });
    case "ore":
      k.lathe("#7d7468", [[0, 0.62, 0.55], [0.35, 0.85, 0.76], [0.78, 0.6, 0.62], [1.05, 0, 0]], { sides: 5 });
      for (const [x, y, z, rz] of [[-0.35, 0.7, 0.45, 30], [0.4, 0.55, 0.5, -40], [0.05, 0.95, 0.15, 5]] as const) {
        k.lathe(main, [[0, 0, 0], [0.16, 0.19, 0.19], [0.42, 0, 0]], { sides: 4, pos: [x, y, z], rot: [25, 0, rz] });
      }
      return k.done({ yaw: 30 });
    case "log":
      k.lathe(main, [[-1.1, 0.45, 0.45], [1.1, 0.45, 0.45]], { sides: 7, rot: [0, 0, 90], twist: false });
      k.lathe(shade(main, 0.45), [[1.1, 0.42, 0.42], [1.14, 0.4, 0.4]], { sides: 7, rot: [0, 0, -90], twist: false });
      k.lathe(shade(main, 0.15), [[1.14, 0.22, 0.22], [1.16, 0.22, 0.22]], { sides: 7, rot: [0, 0, -90], twist: false });
      k.lathe(main, [[0, 0.12, 0.12], [0.4, 0.07, 0.07]], { sides: 5, pos: [-0.3, 0.38, 0], rot: [0, 0, -30] });
      return k.done({ yaw: -35, pitch: 18 });
    case "herb":
      k.seg(shade(main, -0.3), [0, -1], [0, 0.4], 0.04, 0.03, 4);
      for (const [a, len] of [[-38, 0.95], [0, 1.15], [38, 0.95], [-70, 0.7], [70, 0.7]] as const) {
        k.lathe(main, [[0, 0.02, 0.02], [len * 0.4, 0.24, 0.05], [len, 0, 0]], { sides: 4, twist: false, pos: [0, -0.6 + Math.abs(a) * 0.004, 0], rot: [0, 0, a] });
      }
      k.ball(light, [0, 0.55, 0], 0.12, 5);
      return k.done({ yaw: 20 });
    case "tome":
      k.box(main, 1.25, 1.6, 0.38);
      k.box(PAPER, 1.12, 1.48, 0.3, [0.1, 0, 0]);
      k.box(dark, 0.14, 1.64, 0.42, [-0.62, 0, 0]);
      k.box(GOLD, 0.12, 0.3, 0.42, [0.66, 0, 0]);
      for (const y of [-0.6, 0.6]) k.box(GOLD, 0.62, 0.06, 0.4, [-0.05, y, 0.0]);
      k.box(GOLD, 0.4, 0.4, 0.02, [0, 0, 0.2], [0, 0, 45]);
      return k.done({ yaw: -28 });
    case "arrow":
      k.lathe(main, [[-1.4, 0.08, 0.08], [1.1, 0.08, 0.08]], { sides: 5, twist: false });
      k.lathe(STEEL, [[1.0, 0.26, 0.08], [1.6, 0, 0]], { sides: 4, twist: false });
      for (const r of [0, 90]) k.lathe("#ece6d6", [[-1.5, 0, 0], [-1.3, 0.28, 0.02], [-0.8, 0.14, 0.02], [-0.65, 0, 0]], { sides: 4, twist: false, rot: [0, r, 0] });
      return k.done({ tilt: -45, yaw: 30 });
    case "key":
      k.loop(main, [0, 0.95], 0.38, 0.12, 8);
      k.lathe(main, [[-1.0, 0.11, 0.11], [0.6, 0.11, 0.11]], { sides: 6 });
      k.box(main, 0.4, 0.17, 0.17, [0.2, -0.88, 0]);
      k.box(main, 0.3, 0.17, 0.17, [0.15, -0.58, 0]);
      return k.done({ tilt: -45, yaw: 20 });
    case "scroll":
      k.box(main, 1.6, 1.1, 0.04, [0, 0, 0]);
      for (const y of [-0.62, 0.62]) {
        k.lathe(shade(main, -0.1), [[-0.9, 0.16, 0.16], [0.9, 0.16, 0.16]], { sides: 7, rot: [0, 0, 90], pos: [0, y, 0], twist: false });
        for (const s of [-1, 1]) k.lathe(WOOD, [[0, 0.09, 0.09], [0.18, 0.11, 0.11]], { sides: 6, rot: [0, 0, s * -90], pos: [s * 0.88, y, 0] });
      }
      for (const y of [-0.25, 0, 0.25]) k.box(INK, 1.0 - Math.abs(y), 0.05, 0.02, [-0.05, y, 0.03]);
      return k.done({ yaw: 18 });
    case "gem":
      k.lathe(main, [[0, 0, 0], [0.7, 0.85, 0.85], [1.0, 0.55, 0.55]], { sides: 6 });
      return k.done({ yaw: 15, pitch: 30 });
    case "envelope":
      k.box(main, 1.8, 1.2, 0.08);
      k.lathe(shade(main, -0.12), [[0, 0.9, 0.6], [0.04, 0.9, 0.6]], { sides: 3, twist: false, rot: [90, 0, 0], pos: [0, 0.3, 0.04] });
      k.lathe(RED, [[0, 0.17, 0.17], [0.07, 0.15, 0.15]], { sides: 7, twist: false, rot: [90, 0, 0], pos: [0, -0.22, 0.08] });
      return k.done({ yaw: 15 });
    case "feather":
      k.lathe(main, [[0, 0.04, 0.03], [0.4, 0.42, 0.03], [1.35, 0.32, 0.03], [2.0, 0, 0]], { sides: 4, twist: false, pos: [0, -0.85, 0] });
      k.seg(shade(main, -0.35), [0, -1.25], [0, 1.1], 0.035, 0.02, 4, 0.02);
      return k.done({ tilt: -35, yaw: 20 });
    case "map":
      for (let i = 0; i < 3; i++) k.box(i % 2 ? shade(main, -0.12) : main, 0.62, 1.3, 0.03, [-0.6 + 0.6 * i, 0, 0], [0, i % 2 ? -14 : 14, 0]);
      for (const r of [45, -45]) k.box(RED, 0.32, 0.06, 0.03, [0.6, 0.3, 0.1], [0, 0, r]);
      for (let i = 0; i < 4; i++) k.box(INK, 0.08, 0.08, 0.02, [-0.75 + i * 0.32, -0.35 + i * 0.16, 0.12]);
      return k.done({ yaw: 10 });
  }
}

/** Base colours per path: light (mage), the vigil's green, the oath's red. */
const SKILL_COLOURS: Record<CombatStyle, { main: string; accent: string }> = {
  mage: { main: "#f2d77a", accent: "#fff6d6" },
  ranger: { main: "#5fb04a", accent: "#c9e8a0" },
  brawler: { main: "#c9473a", accent: "#e8b0a0" },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A skill's icon model, coloured by its path; sibling skills come out mirrored. */
export function skillModel(skill: SkillDef, style: CombatStyle): IconModel {
  const { main, accent } = SKILL_COLOURS[style];
  const v = hash(skill.id);
  const k = new Kit();
  const view = { mirror: v % 2 === 1, yaw: 18 + (v % 5) * 6 };
  switch (skill.cast.kind) {
    case "basic":
      if (style === "mage") {
        k.ball(main, [0, 0, 0], 0.8, 8);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.4;
          k.shard(accent, [Math.cos(a) * 0.95, Math.sin(a) * 0.95], [Math.cos(a) * 1.45, Math.sin(a) * 1.45], 0.14);
        }
        return k.done(view);
      }
      if (style === "ranger") {
        k.lathe("#a07a4a", [[-1.4, 0.09, 0.09], [1.1, 0.09, 0.09]], { sides: 5, twist: false });
        k.lathe(main, [[1.0, 0.34, 0.1], [1.75, 0, 0]], { sides: 4, twist: false });
        for (const r of [0, 90]) k.lathe(accent, [[-1.5, 0, 0], [-1.3, 0.34, 0.02], [-0.75, 0.16, 0.02], [-0.6, 0, 0]], { sides: 4, twist: false, rot: [0, r, 0] });
        return k.done({ ...view, tilt: -45 });
      }
      k.lathe("#d0d4da", [[0, 0.3, 0.09], [1.8, 0.3, 0.09], [2.4, 0, 0]], { sides: 4, twist: false, pos: [0, 0.3, 0] });
      k.box(main, 1.35, 0.22, 0.36, [0, 0.25, 0]);
      k.lathe(shade(main, -0.4), [[-0.55, 0.13, 0.13], [0.18, 0.13, 0.13]]);
      k.ball(main, [0, -0.66, 0], 0.2, 6);
      return k.done({ ...view, tilt: -45 });
    case "line":
      k.shard(main, [0, -1.6], [0, 1.7], 0.55, 0.22, 0.68);
      k.shard(accent, [0, -1.6], [0, 0.3], 0.26, 0.1, 0.3, 0.12);
      for (const s of [-1, 1]) k.shard(accent, [s * 0.75, -1.5], [s * 0.4, -0.2], 0.14, 0.05, 0.5);
      return k.done({ ...view, tilt: -45 });
    case "multi":
      for (const [ox, rz, len] of [[-0.55, 22, 2.6], [0, 0, 3], [0.55, -22, 2.6]] as const) {
        const a = (rz * Math.PI) / 180;
        k.shard(ox === 0 ? accent : main, [ox, -1.2], [ox - Math.sin(a) * len, -1.2 + Math.cos(a) * len], 0.34, 0.12, 0.72);
      }
      return k.done({ ...view, tilt: -30 });
    case "cone":
      for (let i = 0; i < 5; i++) {
        const a = ((-36 + i * 18) * Math.PI) / 180;
        const len = i === 2 ? 2.6 : 2.2 - Math.abs(i - 2) * 0.15;
        k.shard(i % 2 ? accent : main, [0, -1.2], [-Math.sin(a) * len, -1.2 + Math.cos(a) * len], 0.32, 0.12, 0.7);
      }
      return k.done({ ...view, tilt: -45 });
    case "circle":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        k.shard(main, [Math.cos(a) * 0.65, Math.sin(a) * 0.65], [Math.cos(a) * 1.55, Math.sin(a) * 1.55], 0.26, 0.1, 0.4);
      }
      k.lathe(accent, [[-0.4, 0, 0], [0, 0.42, 0.42], [0.4, 0, 0]], { sides: 6, rot: [90, 0, 0] });
      return k.done(view);
    case "charge":
      k.shard(main, [0, -1.5], [0, 1.9], 0.62, 0.24, 0.7);
      for (const s of [-1, 1]) k.shard(accent, [s * 0.75, -1.9], [s * 0.3, -0.4], 0.22, 0.08, 0.5);
      return k.done({ ...view, tilt: -45 });
    case "shield":
      k.lathe(shade(main, -0.35), [[-0.05, 1.0, 1.2], [0.1, 1.0, 1.2]], { sides: 6, twist: false, rot: [90, 0, 0] });
      k.lathe(main, [[0, 0.9, 1.1], [0.14, 0.9, 1.1], [0.26, 0.68, 0.86], [0.3, 0, 0]], { sides: 6, twist: false, rot: [90, 0, 0] });
      k.lathe(accent, [[0.24, 0.3, 0.3], [0.4, 0.22, 0.22], [0.5, 0, 0]], { sides: 6, rot: [90, 0, 0] });
      return k.done(view);
    case "dash":
      for (const [x, c] of [[-0.75, accent], [0.45, main]] as const) {
        k.shard(c, [x - 0.6, 1.0], [x + 0.55, 0], 0.22, 0.1, 0.5);
        k.shard(c, [x - 0.6, -1.0], [x + 0.55, 0], 0.22, 0.1, 0.5);
      }
      return k.done({ ...view, yaw: 12 });
    case "buff":
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 2;
        k.shard(main, [0, 0], [Math.cos(a) * 1.5, Math.sin(a) * 1.5], 0.32, 0.14, 0.25);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        k.shard(accent, [0, 0], [Math.cos(a) * 0.8, Math.sin(a) * 0.8], 0.2, 0.08, 0.3);
      }
      return k.done({ ...view, yaw: 20 });
    case "aura":
      k.lathe(accent, [[-0.45, 0, 0], [0, 0.45, 0.45], [0.45, 0, 0]], { sides: 4, rot: [0, 0, 0] });
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        const p: V2 = [Math.cos(a) * 1.15, Math.sin(a) * 1.15];
        k.ball(main, [p[0], p[1], 0], 0.36, 6);
      }
      k.loop(shade(main, -0.25), [0, 0], 1.15, 0.05, 12);
      return k.done({ ...view, pitch: 20 });
    case "summon":
      k.lathe("#8a6a4a", [[-1.6, 0.14, 0.14], [0.6, 0.16, 0.16]], { sides: 6 });
      k.loop(shade(main, -0.25), [0, 1.15], 0.55, 0.1, 8);
      k.lathe(main, [[0, 0, 0], [0.38, 0.4, 0.4], [0.95, 0, 0]], { sides: 4, pos: [0, 0.68, 0] });
      return k.done({ ...view, tilt: -30 });
  }
}
