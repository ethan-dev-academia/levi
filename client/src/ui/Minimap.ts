import type { Vec2 } from "@levi/shared";
import type { MapImage } from "../render/MapImage.js";

const PX_PER_UNIT = 3;

/**
 * Rotating minimap: draws the shared MapImage rotated by camera yaw so
 * "up" = camera forward. Clicking emits a world (X, Z) target.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private center: Vec2 = { x: 0, z: 0 };
  private yaw = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly image: MapImage,
    onClick: (world: Vec2) => void,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const r = canvas.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * canvas.width - canvas.width / 2;
      const sy = ((e.clientY - r.top) / r.height) * canvas.height - canvas.height / 2;
      if (Math.hypot(sx, sy) > canvas.width / 2) return;
      // Inverse of draw(): rotate by -yaw, unscale, offset from player.
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      onClick({
        x: this.center.x + (sx * c + sy * s) / PX_PER_UNIT,
        z: this.center.z + (-sx * s + sy * c) / PX_PER_UNIT,
      });
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  draw(player: Vec2, yaw: number, destination: Vec2 | null): void {
    this.center = { x: player.x, z: player.z };
    this.yaw = yaw;
    const { ctx, canvas, image } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(yaw);
    ctx.scale(PX_PER_UNIT, PX_PER_UNIT);
    ctx.translate(-player.x, -player.z);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image.canvas, 0, 0, image.worldWidth, image.worldDepth);

    if (destination) {
      ctx.fillStyle = "#ff2020";
      ctx.fillRect(destination.x - 0.6, destination.z - 0.6, 1.2, 1.2);
    }
    ctx.restore();

    ctx.fillStyle = "#fff";
    ctx.fillRect(w / 2 - 2, h / 2 - 2, 4, 4);

    // North (-Z) marker riding the rim.
    const r = w / 2 - 12;
    ctx.font = "bold 12px Cinzel, Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#c4a465";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    const nx = w / 2 + Math.sin(yaw) * r;
    const ny = h / 2 - Math.cos(yaw) * r;
    ctx.strokeText("N", nx, ny);
    ctx.fillText("N", nx, ny);
  }
}
