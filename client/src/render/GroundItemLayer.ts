import * as THREE from "three";
import { storeyY, type BuildingIndex, type GroundItem, type Heightmap, type ItemDef, type Rarity } from "@levi/shared";
import { itemGraphic } from "../ui/itemIcons.js";
import type { BuildingLayer } from "./BuildingLayer.js";

const TEX_PX = 128;
const SIZE = 0.62;

/** Faint shimmer colour per rarity (warm white for common). */
const SHIMMER: Record<Rarity, string> = {
  common: "#fff1c8",
  uncommon: "#a6f08f",
  rare: "#8cc4ff",
  epic: "#d39cff",
  legendary: "#ffc070",
};

interface Placed {
  item: GroundItem;
  icon: THREE.Mesh;
  glow: THREE.Mesh;
  phase: number;
}

/**
 * Items lying on the ground, drawn as the item itself laid flat at a
 * random angle (as if dropped), with only a faint rarity-tinted shimmer
 * around its outline. No markers: finding them should feel like noticing.
 */
export class GroundItemLayer {
  readonly group = new THREE.Group();
  private placed: Placed[] = [];
  private readonly icons = new Map<string, THREE.CanvasTexture>();
  private readonly glows = new Map<string, THREE.CanvasTexture>();
  private readonly plane = new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2);
  private readonly glowPlane = new THREE.PlaneGeometry(SIZE * 1.25, SIZE * 1.25).rotateX(-Math.PI / 2);
  private t = 0;

  constructor(
    private readonly index: BuildingIndex,
    private readonly hm: Heightmap,
    private readonly items: ReadonlyMap<string, ItemDef>,
  ) {
    this.group.name = "ground-items";
    this.rebuild();
  }

  /** Draw the item's SVG into a canvas (async), returning icon + soft-glow textures. */
  private textures(def: ItemDef): { icon: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
    const key = `${def.id}|${def.rarity}|${def.art ? JSON.stringify(def.art.rows).length : def.icon}|${def.color}`;
    let icon = this.icons.get(key);
    let glow = this.glows.get(key);
    if (icon && glow) return { icon, glow };
    const iconCanvas = document.createElement("canvas");
    const glowCanvas = document.createElement("canvas");
    iconCanvas.width = iconCanvas.height = glowCanvas.width = glowCanvas.height = TEX_PX;
    icon = new THREE.CanvasTexture(iconCanvas);
    glow = new THREE.CanvasTexture(glowCanvas);
    icon.colorSpace = glow.colorSpace = THREE.SRGBColorSpace;
    this.icons.set(key, icon);
    this.glows.set(key, glow);
    const svg = itemGraphic(def);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(TEX_PX));
    svg.setAttribute("height", String(TEX_PX));
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    const pad = 14;
    void img.decode().then(() => {
      const ic = iconCanvas.getContext("2d")!;
      ic.drawImage(img, pad, pad, TEX_PX - pad * 2, TEX_PX - pad * 2);
      icon!.needsUpdate = true;
      // The shimmer: the item's own silhouette, blurred and tinted.
      const gc = glowCanvas.getContext("2d")!;
      gc.filter = "blur(7px)";
      gc.drawImage(img, pad, pad, TEX_PX - pad * 2, TEX_PX - pad * 2);
      gc.filter = "none";
      gc.globalCompositeOperation = "source-in";
      gc.fillStyle = SHIMMER[def.rarity];
      gc.fillRect(0, 0, TEX_PX, TEX_PX);
      glow!.needsUpdate = true;
    });
    return { icon, glow };
  }

  private baseY(g: GroundItem): number {
    const b = g.building ? this.index.get(g.building) : undefined;
    if (g.storey > 0 && b) return storeyY(b.def, g.storey);
    return this.index.groundHeight(this.hm, g.x + 0.5, g.z + 0.5);
  }

  rebuild(): void {
    for (const p of this.placed) {
      (p.icon.material as THREE.Material).dispose();
      (p.glow.material as THREE.Material).dispose();
    }
    this.group.clear();
    this.placed = [];
    for (const item of this.index.groundItems) {
      const def = this.items.get(item.item);
      if (!def) continue;
      const tex = this.textures(def);
      const icon = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({ map: tex.icon, transparent: true, alphaTest: 0.05, depthWrite: false }));
      const glow = new THREE.Mesh(
        this.glowPlane,
        new THREE.MeshBasicMaterial({ map: tex.glow, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      );
      // Dropped at a random (but stable) angle and spot within the tile.
      const seed = (item.x * 73856093) ^ (item.z * 19349663);
      const rand = (n: number): number => (((seed * (n + 1)) >>> 0) % 1000) / 1000;
      const yaw = rand(1) * Math.PI * 2;
      const ox = (rand(2) - 0.5) * 0.3;
      const oz = (rand(3) - 0.5) * 0.3;
      const y = this.baseY(item);
      for (const m of [glow, icon]) {
        m.rotation.y = yaw;
        m.position.set(item.x + 0.5 + ox, y + (m === icon ? 0.035 : 0.025), item.z + 0.5 + oz);
        m.renderOrder = 2;
      }
      icon.userData = { groundItem: item.id };
      this.group.add(glow, icon);
      this.placed.push({ item, icon, glow, phase: rand(4) * 10 });
    }
  }

  /** Gentle shimmer; hide what this player already picked up. */
  update(dt: number, available: (g: GroundItem) => boolean, buildings: BuildingLayer): void {
    this.t += dt;
    for (const p of this.placed) {
      const g = p.item;
      const show = available(g) && (g.storey === 0 || !g.building || buildings.isStoreyVisible(g.building, g.storey));
      p.icon.visible = p.glow.visible = show;
      if (!show) continue;
      const pulse = 0.5 + Math.sin(this.t * 1.6 + p.phase) * 0.5;
      (p.glow.material as THREE.MeshBasicMaterial).opacity = 0.16 + pulse * 0.22;
    }
  }
}
