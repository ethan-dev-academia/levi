import type * as THREE from "three";
import type { EnemyDef, ItemDef, MapData, ModelDef, NpcDef, PropDef, QuestDef, Vec2, WalkGrid } from "@levi/shared";
import type { LocalSim } from "../game/LocalSim.js";
import type { Keyboard } from "../input/Keyboard.js";
import type { TerrainPicker } from "../input/TerrainPicker.js";
import type { BuildingLayer } from "../render/BuildingLayer.js";
import type { PropLayer } from "../render/PropLayer.js";
import type { NpcLayer } from "../render/NpcLayer.js";
import type { GroundItemLayer } from "../render/GroundItemLayer.js";
import type { ItemUi } from "../ui/ItemUi.js";
import type { MapImage } from "../render/MapImage.js";
import type { ChunkedTerrain } from "../render/TerrainMesh.js";
import type { TerrainTopology } from "../render/TerrainTopology.js";
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
  topo: TerrainTopology;
  water: THREE.Object3D;
  mapImage: MapImage;
  picker: TerrainPicker;
  keys: Keyboard;
  sim: LocalSim;
  chat: ChatBox;
  buildings: BuildingLayer;
  props: PropLayer;
  propDefs: ReadonlyMap<string, PropDef>;
  /** Live item registry, editable by the item manager. */
  items: Map<string, ItemDef>;
  quests: ReadonlyMap<string, QuestDef>;
  itemUi: ItemUi;
  /** Item definitions changed: re-derive stats and redraw menus. */
  onItemsChanged(): void;
  npcLayer: NpcLayer;
  groundItems: GroundItemLayer;
  /** Live NPC + quest registries, editable by the F2 quest editor. */
  npcs: Map<string, NpcDef>;
  questDefs: Map<string, QuestDef>;
  /** Live enemy registry, editable in F2. */
  enemyDefs: Map<string, EnemyDef>;
  /** Enemy definitions changed: refresh the fighting enemies and their models. */
  onEnemiesChanged(): void;
  model(id: string): ModelDef | undefined;
  /** Models usable as NPC bodies. */
  characterModelIds(): string[];
  /** Models made for enemies (enemy-rodent, enemy-pig...). */
  enemyModelIds(): string[];
  onFrame(cb: (dt: number) => void): void;
  setCameraOverride(override: CameraOverride | null): void;
  /** Regions were added/edited/removed: refresh clouds etc. */
  onRegionsChanged(): void;
}
