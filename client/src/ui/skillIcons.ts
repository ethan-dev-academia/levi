import type { CombatStyle, SkillDef, SkillSource } from "@levi/shared";
import { iconElement, iconImage } from "../render/IconRenderer.js";
import { skillModel } from "../render/iconModels.js";

const SVG_NS = "http://www.w3.org/2000/svg";
type P = [number, number];

/** Base colours per path: light (mage), the vigil's green, the oath's red. */
const PALETTE: Record<CombatStyle, { main: string; accent: string }> = {
  mage: { main: "#f2d77a", accent: "#fff6d6" },
  ranger: { main: "#5fb04a", accent: "#c9e8a0" },
  brawler: { main: "#c9473a", accent: "#e8b0a0" },
};
/** Light comes from the upper left, like the world's sun. */
const LIGHT = Math.atan2(-1, -1);

function hexToRgb(h: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Brighten (k > 0) or darken (k < 0) a colour. */
function shade(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number): number => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/**
 * A polygon cut into triangles from its centre, each lit by which way its
 * outer edge faces: a cut-gem / flat-shaded look matching the 3D models.
 */
function facets(svg: SVGSVGElement, pts: P[], color: string, strength = 0.42): void {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const ang = Math.atan2((a[1] + b[1]) / 2 - cy, (a[0] + b[0]) / 2 - cx);
    const lit = Math.cos(ang - LIGHT); // 1 facing the light, -1 away
    const tri = document.createElementNS(SVG_NS, "polygon");
    tri.setAttribute("points", `${cx},${cy} ${a[0]},${a[1]} ${b[0]},${b[1]}`);
    tri.setAttribute("fill", shade(color, lit * strength));
    tri.setAttribute("stroke", shade(color, lit * strength));
    tri.setAttribute("stroke-width", "0.3");
    tri.setAttribute("stroke-linejoin", "round");
    svg.append(tri);
  }
}

const ring = (cx: number, cy: number, r: number, n: number, rot = 0): P[] =>
  Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as P;
  });

/** Long diamond from a to b with half-width w (blades, lances, arrows). */
function diamond(a: P, b: P, w: number, at = 0.5): P[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const nx = (-dy / len) * w, ny = (dx / len) * w;
  const m: P = [a[0] + dx * at, a[1] + dy * at];
  return [a, [m[0] + nx, m[1] + ny], b, [m[0] - nx, m[1] - ny]];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A skill's icon: a little faceted 3D model, coloured by its path (flat fallback without WebGL). */
export function skillIcon(skill: SkillDef, style: SkillSource): Element {
  const url = iconImage(`skill:${style}:${skill.id}:${skill.cast.kind}`, () => skillModel(skill, style));
  return url ? iconElement(url, "skill-icon") : flatSkillIcon(skill, style === "adventuring" ? "ranger" : style);
}

/** Faceted, triangle-built flat icon for a skill (fallback). */
function flatSkillIcon(skill: SkillDef, style: CombatStyle): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("class", "skill-icon");
  const { main, accent } = PALETTE[style];
  const v = hash(skill.id);
  const g = document.createElementNS(SVG_NS, "g");
  // Second option at a tier gets mirrored so siblings never look identical.
  if (v % 2) g.setAttribute("transform", "translate(32 0) scale(-1 1)");
  const add = (pts: P[], c = main, s?: number): void => facets(g as unknown as SVGSVGElement, pts, c, s);

  switch (skill.cast.kind) {
    case "basic":
      if (style === "mage") {
        add(ring(16, 16, 9, 8, Math.PI / 8), main);
        add(ring(16, 16, 4, 6), accent, 0.2);
      } else if (style === "ranger") {
        add(diamond([5, 27], [27, 5], 1.6, 0.5), "#a07a4a", 0.25);
        add([[27, 5], [17, 9], [23, 15]], main);
        add([[5, 27], [5, 21], [9, 25]], accent, 0.2);
        add([[5, 27], [11, 27], [7, 23]], accent, 0.2);
      } else {
        add(diamond([7, 25], [27, 5], 3.2, 0.62), "#d0d4da");
        add(diamond([4, 19], [13, 28], 1.6), main);
      }
      break;
    case "line":
      add(diamond([4, 28], [28, 4], 3.4, 0.7), main);
      add(diamond([4, 28], [14, 18], 1.4), accent, 0.2);
      break;
    case "multi":
      for (const [a, b] of [[[6, 26], [16, 4]], [[10, 28], [26, 8]], [[4, 20], [28, 14]]] as Array<[P, P]>) add(diamond(a, b, 2.2, 0.75), main);
      break;
    case "cone":
      add([[5, 27], [28, 8], [24, 27]], main);
      add([[5, 27], [24, 14], [20, 27]], accent, 0.3);
      break;
    case "circle":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const c: P = [16 + Math.cos(a) * 9, 16 + Math.sin(a) * 9];
        add(ring(c[0], c[1], 4, 3, a), main);
      }
      add(ring(16, 16, 3.5, 6), accent, 0.2);
      break;
    case "charge":
      add(diamond([3, 29], [29, 3], 4, 0.72), main);
      add([[6, 20], [12, 26], [3, 29]], accent, 0.25);
      break;
    case "shield":
      add(ring(16, 16, 12, 6, Math.PI / 6), main);
      add(ring(16, 16, 5.5, 6, Math.PI / 6), accent, 0.25);
      break;
    case "dash":
      add([[4, 6], [14, 16], [4, 26], [9, 16]], accent, 0.3);
      add([[14, 6], [27, 16], [14, 26], [19, 16]], main);
      break;
    case "buff":
      add([[16, 2], [20, 12], [30, 16], [20, 20], [16, 30], [12, 20], [2, 16], [12, 12]], main);
      break;
    case "aura":
      add(ring(16, 16, 5, 4, Math.PI / 4), accent, 0.25);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        add(ring(16 + Math.cos(a) * 11, 16 + Math.sin(a) * 11, 4, 3, a), main);
      }
      break;
    case "summon":
      add([[14, 30], [18, 30], [17, 12], [15, 12]], "#8a6a4a", 0.25);
      add(ring(16, 9, 7, 5, -Math.PI / 2), main);
      break;
  }
  svg.append(g);
  return svg;
}
