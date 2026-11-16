import type * as THREE from "three";
import type { MapData, Vec2, WalkGrid } from "@levi/shared";
import type { LocalSim } from "../game/LocalSim.js";
import type { Keyboard } from "../input/Keyboard.js";
import type { TerrainPicker } from "../input/TerrainPicker.js";
import type { MapImage } from "../render/MapImage.js";
import type { ChunkedTerrain } from "../render/TerrainMesh.js";
import type { ChatBox } from "../ui/ChatBox.js";

/** Takes over the camera from the player orbit while active (dev free cam). */
export interface CameraOverride {
  update(dt: number): void;
  /** Ground point that terrain streaming should centre on. */
  focus(): Vec2;
}

/** Everything the dev tools are allowed to touch. Passed in; never global. */
export interface DevContext {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  data: MapData;
  walk: WalkGrid;
  terrain: ChunkedTerrain;
  water: THREE.Object3D;
  mapImage: MapImage;
  picker: TerrainPicker;
  keys: Keyboard;
  sim: LocalSim;
  chat: ChatBox;
  onFrame(cb: (dt: number) => void): void;
  setCameraOverride(override: CameraOverride | null): void;
}
