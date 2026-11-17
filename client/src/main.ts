import * as THREE from "three";
import { buildWalkGrid, lerp, regionAt, storeyY, type AbilitySlot, type ItemSlot, type Region } from "@levi/shared";
import { OrbitCamera } from "./camera/OrbitCamera.js";
import { loadMap } from "./content/mapLoader.js";
import { getOrThrow, loadContent } from "./content/registry.js";
import { startGameLoop } from "./game/GameLoop.js";
import { LocalSim } from "./game/LocalSim.js";
import { Keyboard } from "./input/Keyboard.js";
import { PointerInput } from "./input/PointerInput.js";
import { TerrainPicker } from "./input/TerrainPicker.js";
import { LocalIntentSink } from "./net/IntentSink.js";
import { BuildingLayer } from "./render/BuildingLayer.js";
import { CharacterEntity } from "./render/CharacterEntity.js";
import { ClickMarker } from "./render/ClickMarker.js";
import { PropLayer } from "./render/PropLayer.js";
import { Clouds } from "./render/Clouds.js";
import { MapImage } from "./render/MapImage.js";
import { renderPortrait } from "./render/portrait.js";
import { ChunkedTerrain, createWater } from "./render/TerrainMesh.js";
import { TerrainTopology } from "./render/TerrainTopology.js";
import { WorldRenderer } from "./render/WorldRenderer.js";
import type { CameraOverride } from "./dev/types.js";
import { ChatBox } from "./ui/ChatBox.js";
import { Hud } from "./ui/Hud.js";
import { Minimap } from "./ui/Minimap.js";
import { ReadPopup } from "./ui/ReadPopup.js";
import { isAdjacent, resolveInteraction, type Interaction } from "./game/Interactions.js";
import { ICONS, SidePanel, textTab } from "./ui/SidePanel.js";
import { WorldMap } from "./ui/WorldMap.js";

// Everything lives in module scope: nothing is ever attached to `window`.

const START_MAP = "overworld";

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`#${id} missing or not a ${type.name}`);
  return node;
}

async function boot(): Promise<void> {
  const chat = new ChatBox(el("chat-log", HTMLDivElement), el("chat-input", HTMLInputElement), (text) =>
    chat.add(`You: ${text}`, "player"),
  );

  // --- Content ------------------------------------------------------
  const content = loadContent();
  const heroModel = getOrThrow(content.models, "humanoid", "model");
  const data = await loadMap(START_MAP);
  // `data.def` is read live everywhere below: dev undo can replace it.
  const { hm } = data;
  const walk = buildWalkGrid(data);
  const topo = new TerrainTopology(data);
  const mapImage = new MapImage(data, walk, topo);

  // --- UI -----------------------------------------------------------
  const hud = new Hud(el("hud", HTMLElement));
  renderPortrait(heroModel, hud.portrait);

  new SidePanel(el("tabs", HTMLElement), el("tab-content", HTMLElement), [
    textTab("combat", "Combat", ICONS.combat, ["No abilities learned yet."]),
    textTab("skills", "Skills", ICONS.skills, ["Skill progression arrives with the content schemas."]),
    textTab("quests", "Quests", ICONS.quests, ["No quests available."]),
    textTab("inventory", "Inventory", ICONS.inventory, ["Your bag is empty."]),
    textTab("equipment", "Equipment", ICONS.equipment, ["Nothing equipped."]),
    textTab("spells", "Spellbook", ICONS.spells, ["D / F utility spells will live here."]),
    textTab("friends", "Friends", ICONS.friends, ["Multiplayer arrives in Step 2."]),
    textTab("settings", "Controls", ICONS.settings, [
      "Right-click: Walk (hold to steer)",
      "Middle-drag: Rotate camera",
      "Arrow keys: Rotate camera",
      "Wheel: Zoom",
      "M: World map",
      "Q W E R: Abilities",
      "D F: Utility spells",
      "1 – 4: Items",
      "S: Stop",
      "Enter: Chat",
    ]),
  ], "settings");

  // --- World --------------------------------------------------------
  const stage = el("stage", HTMLElement);
  const canvas = el("viewport", HTMLCanvasElement);
  const world = new WorldRenderer(canvas);
  const terrain = new ChunkedTerrain(data, walk, topo);
  const water = createWater(hm, data.def.waterLevel);
  const clouds = new Clouds();
  clouds.rebuild(data.def.regions);
  const buildings = new BuildingLayer(data.buildings, hm);
  const props = new PropLayer(data.buildings, hm, content.models, content.props);
  world.scene.add(terrain.group, water, clouds.group, buildings.group, props.group);
  const reader = new ReadPopup(stage);
  const interactCtx = { buildings: data.buildings, propDefs: content.props };

  const hero = new CharacterEntity(heroModel);
  hero.addTo(world.scene);

  const marker = new ClickMarker();
  world.scene.add(marker.mesh);

  const orbit = new OrbitCamera(world.camera, hm);
  const cs = data.def.cellSize;
  const picker = new TerrainPicker(world.camera, hm, (x, z) => !data.isHole(Math.floor(x / cs), Math.floor(z / cs)));

  // --- Simulation + intent pipeline ---------------------------------
  const sim = new LocalSim(walk, data.buildings, data.def.spawn, { message: (t) => chat.add(t) });
  const intents = new LocalIntentSink((i) => sim.apply(i));

  /** Height of the floor the player is standing on: upper storey, building floor or terrain. */
  const playerFloorY = (): number | null => {
    const p = sim.player;
    const b = p.storey > 0 && p.building ? data.buildings.get(p.building) : undefined;
    return b ? storeyY(b.def, p.storey) : null;
  };
  const surfaceAt = (x: number, z: number): number => playerFloorY() ?? data.buildings.groundHeight(hm, x, z);

  /** Tile interaction the player is walking to; runs once they're next to it. */
  let pendingAction: Interaction | null = null;
  /** Where the player stood when the open note was read (walk away = close). */
  let lastRead: { x: number; z: number } | null = null;
  const moveTo = (x: number, z: number, showMarker: boolean, y?: number): void => {
    pendingAction = null;
    if (showMarker) marker.show(hm, x, z, y);
    intents.send({ type: "move", targetX: x, targetZ: z });
  };

  /** Ground point under the cursor on the player's storey. */
  const pickWalk = (ndcX: number, ndcY: number): { x: number; z: number; y?: number } | null => {
    const floorY = playerFloorY();
    if (floorY !== null) {
      const p = buildings.pickFloor(world.camera, ndcX, ndcY, floorY);
      if (p) return { x: p.x, z: p.z, y: floorY };
    }
    return picker.pick(ndcX, ndcY);
  };

  const pointer = new PointerInput(canvas, {
    onMoveCommand: (ndc, initial) => {
      // Stairs/ladders: the clicked half picks the direction (top = up).
      const stair = initial ? buildings.pickStair(world.camera, ndc.x, ndc.y) : null;
      const info = stair ? data.buildings.get(stair.building) : undefined;
      if (stair && info) {
        const mid = storeyY(info.def, stair.flight) + info.def.floorHeight / 2;
        intents.send({ type: "climb", building: stair.building, stair: stair.stair, dir: stair.point.y >= mid ? "up" : "down" });
        return;
      }
      // Interactions are tile-based: clicking the object, its tile, or just
      // past the tile's edge all snap to it. Walk next to it, then act.
      const hit0 = initial ? pickWalk(ndc.x, ndc.y) : null;
      if (initial) {
        const p = sim.player;
        const meshProp = props.pick(world.camera, ndc.x, ndc.y);
        const meshDef = meshProp ? props.def(meshProp) : undefined;
        const action: Interaction | null =
          meshProp && meshDef?.readable
            ? { kind: "read", prop: meshProp, def: meshDef }
            : hit0
              ? resolveInteraction(interactCtx, hit0, p.storey, p.building)
              : null;
        if (action) {
          const t = action.prop;
          moveTo(t.x + 0.5, t.z + 0.5, true, props.baseY(t));
          pendingAction = action;
          return;
        }
      }
      const hit = hit0 ?? pickWalk(ndc.x, ndc.y);
      if (hit) moveTo(hit.x, hit.z, initial, hit.y);
    },
    onOrbit: (dx, dy) => orbit.orbit(dx, dy),
    onZoom: (dy) => orbit.zoom(dy),
  });

  const minimap = new Minimap(el("minimap", HTMLCanvasElement), mapImage, (w) => moveTo(w.x, w.z, true));
  const worldMap = new WorldMap(
    stage,
    mapImage,
    data.def.name,
    {
      onWalk: (w) => moveTo(w.x, w.z, true),
      ...(import.meta.env.DEV ? { onTeleport: (w: { x: number; z: number }) => sim.teleport(w.x, w.z) } : {}),
    },
    () => data.def.regions,
  );

  const aimPoint = () => picker.pick(pointer.lastNdc.x, pointer.lastNdc.y) ?? { x: sim.player.x, z: sim.player.z };
  const keys = new Keyboard();
  const castKeys: ReadonlyArray<readonly [string, AbilitySlot]> = [
    ["KeyQ", "Q"], ["KeyW", "W"], ["KeyE", "E"], ["KeyR", "R"], ["KeyD", "D"], ["KeyF", "F"],
  ];
  for (const [code, slot] of castKeys) {
    keys.bind(code, () => {
      hud.flash(slot);
      const aim = aimPoint();
      intents.send({ type: "cast", slot, aimX: aim.x, aimZ: aim.z });
    });
  }
  const itemKeys: ReadonlyArray<readonly [string, ItemSlot]> = [["Digit1", 1], ["Digit2", 2], ["Digit3", 3], ["Digit4", 4]];
  for (const [code, slot] of itemKeys) {
    keys.bind(code, () => {
      hud.flash(`${slot}`);
      intents.send({ type: "useItem", slot });
    });
  }
  keys.bind("KeyS", () => intents.send({ type: "stop" }));
  keys.bind("Enter", () => chat.focus());
  keys.bind("KeyM", () => worldMap.toggle(sim.player));
  keys.bind("Escape", () => {
    worldMap.setOpen(false);
    reader.close();
  });

  // --- Dev tools (stripped from production builds) ------------------
  const frameHooks: Array<(dt: number) => void> = [];
  let cameraOverride: CameraOverride | null = null;
  if (import.meta.env.DEV) {
    const dev = await import("./dev/index.js");
    dev.mountDevTools({
      stage, canvas, scene: world.scene, camera: world.camera, data, walk, terrain, topo, water, mapImage, picker, keys, sim, chat, buildings,
      props, propDefs: content.props,
      onFrame: (cb) => frameHooks.push(cb),
      setCameraOverride: (o) => (cameraOverride = o),
      onRegionsChanged: () => clouds.rebuild(data.def.regions),
    });
  }

  // --- Region tracking ----------------------------------------------
  let currentRegion: Region | null = null;
  const trackRegion = (x: number, z: number): void => {
    const r = regionAt(data.def.regions, x, z);
    if (r?.id !== currentRegion?.id) {
      currentRegion = r;
      if (r) chat.add(`You arrive at ${r.name}.`, "system");
    }
  };

  // --- Loop ---------------------------------------------------------
  const focus = new THREE.Vector3();
  terrain.update(sim.player.x, sim.player.z, true);
  startGameLoop({
    tick: () => sim.tick(),
    frame: (alpha, dt) => {
      const p = sim.player;
      const x = lerp(p.prevX, p.x, alpha);
      const z = lerp(p.prevZ, p.z, alpha);

      if (cameraOverride) {
        cameraOverride.update(dt);
        const f = cameraOverride.focus();
        terrain.update(f.x, f.z);
      } else {
        orbit.rotateByKeys(keys.axis("ArrowRight", "ArrowLeft"), keys.axis("ArrowDown", "ArrowUp"), dt);
        focus.set(x, surfaceAt(x, z) + 1.2, z);
        orbit.update(dt, focus);
        terrain.update(x, z);
      }

      hero.update(surfaceAt, x, z, p.dirX, p.dirZ, dt);
      buildings.update({ x, z, storey: p.storey, building: p.building }, world.camera.position, dt);
      props.update(buildings);
      if (pendingAction) {
        const t = pendingAction.prop;
        const near = p.storey === t.storey && isAdjacent(p.x, p.z, t.x, t.z);
        if (near) {
          // Only one kind so far; new interaction kinds get their own branch.
          reader.open(pendingAction.def.name, t.text ?? "");
          lastRead = { x: p.x, z: p.z };
          pendingAction = null;
        } else if (p.path.length === 0) pendingAction = null; // couldn't get there
      } else if (reader.isOpen && lastRead && Math.hypot(lastRead.x - p.x, lastRead.z - p.z) > 4) {
        reader.close();
      }
      marker.update(dt);
      clouds.update(dt);
      trackRegion(x, z);
      for (const hook of frameHooks) hook(dt);

      const dest = sim.destination();
      minimap.draw({ x, z }, orbit.yaw, dest);
      worldMap.draw({ x, z }, dest);
      world.render();
    },
  });

  chat.add("Welcome to Levi.", "system");
  chat.add("Right-click to walk. Middle-drag or arrow keys to turn the camera. M for the world map.");
}

boot().catch((e: unknown) => {
  console.error(e);
  const log = document.getElementById("chat-log");
  if (log) log.textContent = `Failed to start: ${String(e)}`;
});
