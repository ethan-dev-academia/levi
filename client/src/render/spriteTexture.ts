import * as THREE from "three";
import type { SpriteDef } from "@levi/shared";

/** Rasterise a palette-indexed SpriteDef onto a canvas at 1px per pixel. */
export function spriteDefToCanvas(def: SpriteDef): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = def.width;
  canvas.height = def.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const key = row[x]!;
      if (key === ".") continue;
      ctx.fillStyle = def.palette[key]!;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return canvas;
}

/** Crisp pixel-art texture: nearest filtering, no mipmaps. */
export function pixelTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
