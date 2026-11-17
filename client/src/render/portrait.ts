import * as THREE from "three";
import type { ModelDef, ModelPalette } from "@levi/shared";
import { buildModel } from "./ModelBuilder.js";

/**
 * Render a one-off head-and-shoulders portrait of a model into a 2D canvas.
 * Uses a short-lived offscreen renderer, then releases its GL context.
 */
export function renderPortrait(def: ModelDef, target: HTMLCanvasElement, palette?: ModelPalette, yaw = -0.45): void {
  const { width, height } = target;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const key = new THREE.DirectionalLight(0xfff1d6, 2.4);
  key.position.set(1, 1.5, 2);
  scene.add(key);

  const model = buildModel(def, palette);
  model.root.rotation.y = yaw;
  scene.add(model.root);

  const box = new THREE.Box3().setFromObject(model.root);
  const top = box.max.y;
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 50);
  camera.position.set(0.55, top - 0.2, 1.7);
  camera.lookAt(0, top - 0.35, 0);

  renderer.render(scene, camera);
  target.getContext("2d")?.drawImage(renderer.domElement, 0, 0);

  model.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}
