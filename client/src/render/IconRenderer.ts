import * as THREE from "three";
import type { ModelPart } from "@levi/shared";
import { buildModel } from "./ModelBuilder.js";

/** A little faceted model to photograph as an icon. Colours are literal hex. */
export interface IconModel {
  parts: ModelPart[];
  /** Degrees about the view axis (−45 = pointing up-right, like a sword in a slot). */
  tilt?: number;
  /** Degrees about the model's own up axis, so the facets catch the light. */
  yaw?: number;
  /** Degrees leaning the top away from the camera (see a bit of the top face). */
  pitch?: number;
  /** Mirror left-right. */
  mirror?: boolean;
}

const PX = 128;
const OUTLINE = "#15120e";
const cache = new Map<string, string>();
let renderer: THREE.WebGLRenderer | null = null;
let failed = false;
let scene: THREE.Scene | null = null;

function setup(): THREE.WebGLRenderer | null {
  if (renderer || failed) return renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(PX, PX, false);
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    // The world's light: sky from above, the sun from the upper left.
    scene.add(new THREE.HemisphereLight(0xdfeeff, 0x4a3b28, 1.5));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
    sun.position.set(-1.2, 1.6, 2);
    scene.add(sun);
  } catch {
    failed = true;
    renderer = null;
  }
  return renderer;
}

/**
 * Photograph a low-poly model into a transparent PNG (data URL), framed to
 * fill the square, with a thin dark outline so it reads on any slot colour.
 * One shared offscreen renderer; every result is cached by `key`.
 * Returns "" if WebGL isn't available.
 */
export function iconImage(key: string, build: () => IconModel): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const r = setup();
  if (!r || !scene) {
    cache.set(key, "");
    return "";
  }
  const def = build();
  const model = buildModel({ id: key, scale: 1, palette: {}, parts: def.parts });
  const spin = new THREE.Group();
  spin.add(model.root);
  spin.rotation.y = ((def.yaw ?? 25) * Math.PI) / 180;
  const tilt = new THREE.Group();
  tilt.add(spin);
  tilt.rotation.z = ((def.tilt ?? 0) * Math.PI) / 180;
  const holder = new THREE.Group();
  holder.add(tilt);
  holder.rotation.x = ((def.pitch ?? 14) * Math.PI) / 180;
  if (def.mirror) holder.scale.x = -1;
  scene.add(holder);
  holder.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(holder);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const half = (Math.max(size.x, size.y) / 2) * 1.12;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
  cam.position.set(c.x, c.y, c.z + 30);
  cam.lookAt(c);
  r.render(scene, cam);

  // Outline: the silhouette in dark, nudged around, under the picture.
  const out = document.createElement("canvas");
  out.width = out.height = PX;
  const sil = document.createElement("canvas");
  sil.width = sil.height = PX;
  const sg = sil.getContext("2d")!;
  sg.drawImage(r.domElement, 0, 0);
  sg.globalCompositeOperation = "source-in";
  sg.fillStyle = OUTLINE;
  sg.fillRect(0, 0, PX, PX);
  const g = out.getContext("2d")!;
  const w = 2.5;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.drawImage(sil, Math.cos(a) * w, Math.sin(a) * w);
  }
  g.drawImage(r.domElement, 0, 0);
  const url = out.toDataURL("image/png");

  scene.remove(holder);
  model.dispose();
  cache.set(key, url);
  return url;
}

/** An <img> showing a cached icon. */
export function iconElement(url: string, className: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = className;
  img.src = url;
  img.alt = "";
  img.draggable = false;
  img.decoding = "sync";
  return img;
}
