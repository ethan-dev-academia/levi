import { valueNoise2, type Region, type Vec2 } from "@levi/shared";
import type { MapImage } from "../render/MapImage.js";

const MIN_SCALE = 0.4;
/** Fog-of-war texels per world unit (1 texel = 8 cells). */
const FOG_STEP = 8;
const MAX_SCALE = 16;
const CHUNK_GRID = 64;

export interface WorldMapHandlers {
  /** Right-click on the map. */
  onWalk(world: Vec2): void;
  /** Ctrl + right-click (dev builds only). */
  onTeleport?: (world: Vec2) => void;
}

/**
 * Full-screen north-up world map (M). Drag to pan, wheel to zoom at the
 * cursor, right-click to walk. Shows cell coordinates under the cursor.
 */
export class WorldMap {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly coords: HTMLSpanElement;
  private open = false;
  private center: Vec2 = { x: 0, z: 0 };
  private scale = 2;
  private drag: { x: number; y: number } | null = null;
  private hover: Vec2 | null = null;
  /** Black over everywhere you haven't discovered; rebuilt when that changes. */
  private readonly fog = document.createElement("canvas");
  private fogKey = "";

  constructor(
    host: HTMLElement,
    private readonly image: MapImage,
    title: string,
    private readonly handlers: WorldMapHandlers,
    /** Read each frame so dev edits show up live. */
    private readonly regions: () => readonly Region[] = () => [],
    /** Region ids this player has found; null = show everything (no fog). */
    private readonly discovered: () => ReadonlySet<string> | null = () => null,
  ) {
    this.root = document.createElement("div");
    this.root.id = "worldmap";
    this.root.hidden = true;

    const header = document.createElement("header");
    const h = document.createElement("h2");
    h.textContent = title;
    this.coords = document.createElement("span");
    this.coords.className = "wm-coords";
    const hint = document.createElement("span");
    hint.className = "wm-hint";
    hint.textContent = handlers.onTeleport
      ? "Drag: pan · Wheel: zoom · Right-click: walk · Ctrl+Right-click: teleport · M / Esc: close"
      : "Drag: pan · Wheel: zoom · Right-click: walk · M / Esc: close";
    header.append(h, this.coords, hint);

    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;

    this.root.append(header, this.canvas);
    host.appendChild(this.root);
    this.bindInput();
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(player: Vec2): void {
    this.setOpen(!this.open, player);
  }

  setOpen(open: boolean, player?: Vec2): void {
    this.open = open;
    this.root.hidden = !open;
    if (open && player) {
      // Open on the region you're in (the island, the Cathedral...); wheel out for the whole world.
      this.center = { x: player.x, z: player.z };
      const here = this.regionHere(player);
      const w = this.canvas.clientWidth || 800;
      const h = this.canvas.clientHeight || 600;
      if (here) {
        const b = here.bounds;
        this.center = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
        this.scale = Math.max(this.minScale(), Math.min(MAX_SCALE, Math.min(w / (b.x1 - b.x0), h / (b.z1 - b.z0)) * 0.8));
      } else this.scale = 2;
      this.clampCenter();
    }
  }

  /** Open centred on a point (a quest target), zoomed in close. */
  focusOn(p: Vec2): void {
    this.setOpen(true);
    this.center = { x: p.x, z: p.z };
    this.scale = Math.max(this.scale, 3);
    this.clampCenter();
  }

  /** The smallest region around a point. */
  private regionHere(p: Vec2): Region | null {
    let best: Region | null = null;
    let area = Infinity;
    for (const r of this.regions()) {
      const b = r.bounds;
      if (p.x < b.x0 || p.x >= b.x1 || p.z < b.z0 || p.z >= b.z1) continue;
      const a = (b.x1 - b.x0) * (b.z1 - b.z0);
      if (a < area) {
        best = r;
        area = a;
      }
    }
    return best;
  }

  /** Keep the view over the world; once it all fits, centre it. */
  private clampCenter(): void {
    const half = (screen: number): number => screen / this.scale / 2;
    const fit = (c: number, size: number, screen: number): number =>
      size * this.scale <= screen ? size / 2 : Math.min(size - half(screen), Math.max(half(screen), c));
    this.center.x = fit(this.center.x, this.image.worldWidth, this.canvas.clientWidth || 800);
    this.center.z = fit(this.center.z, this.image.worldDepth, this.canvas.clientHeight || 600);
  }

  /** Zoomed all the way out = the whole world fits. */
  private minScale(): number {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    return Math.min(MIN_SCALE, Math.min(w / this.image.worldWidth, h / this.image.worldDepth) * 0.92);
  }

  /** Rebuild the fog when the discovered regions (or the regions themselves) change. */
  private updateFog(found: ReadonlySet<string>): void {
    const regions = this.regions();
    const key = [...found].sort().join(",") + "|" + regions.map((r) => `${r.id}:${r.bounds.x0},${r.bounds.z0},${r.bounds.x1},${r.bounds.z1}`).join(";");
    if (key === this.fogKey) return;
    this.fogKey = key;
    const fw = Math.ceil(this.image.worldWidth / FOG_STEP);
    const fh = Math.ceil(this.image.worldDepth / FOG_STEP);
    this.fog.width = fw;
    this.fog.height = fh;
    const ctx = this.fog.getContext("2d")!;
    const img = ctx.createImageData(fw, fh);
    const open = regions.filter((r) => found.has(r.id));
    for (let tz = 0; tz < fh; tz++) {
      for (let tx = 0; tx < fw; tx++) {
        const x = (tx + 0.5) * FOG_STEP;
        const z = (tz + 0.5) * FOG_STEP;
        // Ragged, soft edge: distance outside the nearest discovered region, wobbled by noise.
        let lit = 0;
        for (const r of open) {
          const b = r.bounds;
          const d = Math.max(b.x0 - x, x - b.x1, b.z0 - z, z - b.z1) + (valueNoise2(x * 0.02, z * 0.02, 5) - 0.5) * 40;
          lit = Math.max(lit, Math.min(1, Math.max(0, (12 - d) / 28)));
        }
        const i = (tz * fw + tx) * 4;
        img.data[i] = 6;
        img.data[i + 1] = 7;
        img.data[i + 2] = 10;
        img.data[i + 3] = Math.round((1 - lit) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private toWorld(clientX: number, clientY: number): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: this.center.x + (clientX - r.left - r.width / 2) / this.scale,
      z: this.center.z + (clientY - r.top - r.height / 2) / this.scale,
    };
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      if (e.button === 0) {
        this.drag = { x: e.clientX, y: e.clientY };
        c.setPointerCapture(e.pointerId);
      } else if (e.button === 2) {
        const w = this.toWorld(e.clientX, e.clientY);
        if (e.ctrlKey && this.handlers.onTeleport) this.handlers.onTeleport(w);
        else this.handlers.onWalk(w);
      }
    });
    c.addEventListener("pointermove", (e) => {
      this.hover = this.toWorld(e.clientX, e.clientY);
      if (!this.drag) return;
      this.center.x -= (e.clientX - this.drag.x) / this.scale;
      this.center.z -= (e.clientY - this.drag.y) / this.scale;
      this.drag = { x: e.clientX, y: e.clientY };
      this.clampCenter();
    });
    c.addEventListener("pointerup", () => (this.drag = null));
    c.addEventListener("pointerleave", () => (this.hover = null));
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.clientX, e.clientY);
        this.scale = Math.min(MAX_SCALE, Math.max(this.minScale(), this.scale * Math.exp(-e.deltaY * 0.0015)));
        const after = this.toWorld(e.clientX, e.clientY);
        // Keep the point under the cursor fixed.
        this.center.x += before.x - after.x;
        this.center.z += before.z - after.z;
        this.clampCenter();
      },
      { passive: false },
    );
  }

  draw(player: Vec2, destination: Vec2 | null, targets: ReadonlyArray<Vec2 & { label: string }> = []): void {
    if (!this.open) return;
    const { canvas, ctx, image, scale } = this;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-this.center.x, -this.center.z);
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(image.canvas, 0, 0, image.worldWidth, image.worldDepth);
    const found = this.discovered();
    if (found) {
      this.updateFog(found);
      const smooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fog, 0, 0, image.worldWidth, image.worldDepth);
      ctx.imageSmoothingEnabled = smooth;
    }

    // Chunk grid helps designers orient on large maps.
    if (scale >= 1) {
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      for (let x = 0; x <= image.worldWidth; x += CHUNK_GRID) { ctx.moveTo(x, 0); ctx.lineTo(x, image.worldDepth); }
      for (let z = 0; z <= image.worldDepth; z += CHUNK_GRID) { ctx.moveTo(0, z); ctx.lineTo(image.worldWidth, z); }
      ctx.stroke();
    }
    ctx.strokeStyle = "#c4a465";
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(0, 0, image.worldWidth, image.worldDepth);
    ctx.restore();

    const toScreen = (p: Vec2): [number, number] => [
      w / 2 + (p.x - this.center.x) * scale,
      h / 2 + (p.z - this.center.z) * scale,
    ];

    // Region outlines + names (OSRS-style area labels).
    ctx.font = "700 14px Verdana, Geneva, Tahoma, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const r of this.regions()) {
      if (found && !found.has(r.id)) continue; // undiscovered: no name, no border
      const [rx0, rz0] = toScreen({ x: r.bounds.x0, z: r.bounds.z0 });
      const [rx1, rz1] = toScreen({ x: r.bounds.x1, z: r.bounds.z1 });
      // Sky islands are framed by their cloud bank; only ground zones get a border.
      if (r.kind !== "sky" && (r.bounds.x1 - r.bounds.x0) * (r.bounds.z1 - r.bounds.z0) >= 20000) {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(196,164,101,0.6)";
        ctx.lineWidth = 1;
        ctx.strokeRect(rx0, rz0, rx1 - rx0, rz1 - rz0);
        ctx.setLineDash([]);
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#f2d48a";
      ctx.strokeText(r.name, (rx0 + rx1) / 2, rz0 - 4);
      ctx.fillText(r.name, (rx0 + rx1) / 2, rz0 - 4);
    }
    // Quest targets.
    ctx.font = "700 12px Verdana, Geneva, Tahoma, sans-serif";
    ctx.textBaseline = "bottom";
    for (const t of targets) {
      const [tx, ty] = toScreen(t);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#ffd24a";
      ctx.strokeStyle = "#2a1c00";
      ctx.lineWidth = 2;
      ctx.fillRect(-6, -6, 12, 12);
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#ffe7a0";
      ctx.strokeText(t.label, tx, ty - 10);
      ctx.fillText(t.label, tx, ty - 10);
    }
    if (destination) {
      const [dx, dy] = toScreen(destination);
      ctx.fillStyle = "#ff3030";
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    const [px, py] = toScreen(player);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    this.coords.textContent = this.hover ? `${Math.floor(this.hover.x)}, ${Math.floor(this.hover.z)}` : "";
  }
}
