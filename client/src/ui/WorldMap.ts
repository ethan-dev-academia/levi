import type { Region, Vec2 } from "@levi/shared";
import type { MapImage } from "../render/MapImage.js";

const MIN_SCALE = 0.4;
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

  constructor(
    host: HTMLElement,
    private readonly image: MapImage,
    title: string,
    private readonly handlers: WorldMapHandlers,
    /** Read each frame so dev edits show up live. */
    private readonly regions: () => readonly Region[] = () => [],
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
    if (open && player) this.center = { x: player.x, z: player.z };
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
    });
    c.addEventListener("pointerup", () => (this.drag = null));
    c.addEventListener("pointerleave", () => (this.hover = null));
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.clientX, e.clientY);
        this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * Math.exp(-e.deltaY * 0.0015)));
        const after = this.toWorld(e.clientX, e.clientY);
        // Keep the point under the cursor fixed.
        this.center.x += before.x - after.x;
        this.center.z += before.z - after.z;
      },
      { passive: false },
    );
  }

  draw(player: Vec2, destination: Vec2 | null): void {
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
    ctx.font = "700 14px Cinzel, Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const r of this.regions()) {
      const [rx0, rz0] = toScreen({ x: r.bounds.x0, z: r.bounds.z0 });
      const [rx1, rz1] = toScreen({ x: r.bounds.x1, z: r.bounds.z1 });
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = r.kind === "sky" ? "rgba(255,255,255,0.55)" : "rgba(196,164,101,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(rx0, rz0, rx1 - rx0, rz1 - rz0);
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#f2d48a";
      ctx.strokeText(r.name, (rx0 + rx1) / 2, rz0 - 4);
      ctx.fillText(r.name, (rx0 + rx1) / 2, rz0 - 4);
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
