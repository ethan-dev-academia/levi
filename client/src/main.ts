import * as THREE from "three";
import { buildWalkGrid, getTerrainHeight, lerp, regionAt, type AbilitySlot, type ItemSlot, type Region } from "@levi/shared";
import { OrbitCamera } from "./camera/OrbitCamera.js";
import { loadMap } from "./content/mapLoader.js";
import { getOrThrow, loadContent } from "./content/registry.js";
import { startGameLoop } from "./game/GameLoop.js";
import { LocalSim } from "./game/LocalSim.js";
import { Keyboard } from "./input/Keyboard.js";
import { PointerInput } from "./input/PointerInput.js";
import { TerrainPicker } from "./input/TerrainPicker.js";
import { LocalIntentSink } from "./net/IntentSink.js";
import { CharacterEntity } from "./render/CharacterEntity.js";
import { ClickMarker } from "./render/ClickMarker.js";
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
  const heroModel = getOrThrow(content.models, "hero", "model");
  const data = await loadMap(START_MAP);
  // `data.def` is read live everywhere below: dev undo can replace it.
  const { hm } = data;
  const walk = buildWalkGrid(data);
  const topo = new TerrainTopology(data);
  const mapImage = new MapImage(data, walk);

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
  world.scene.add(terrain.group, water, clouds.group);

  const hero = new CharacterEntity(heroModel);
  hero.addTo(world.scene);

  const marker = new ClickMarker();
  world.scene.add(marker.mesh);

  const orbit = new OrbitCamera(world.camera, hm);
  const cs = data.def.cellSize;
  const picker = new TerrainPicker(world.camera, hm, (x, z) => !data.isHole(Math.floor(x / cs), Math.floor(z / cs)));

  // --- Simulation + intent pipeline ---------------------------------
  const sim = new LocalSim(walk, data.def.spawn, { message: (t) => chat.add(t) });
  const intents = new LocalIntentSink((i) => sim.apply(i));

  const moveTo = (x: number, z: number, showMarker: boolean): void => {
    if (showMarker) marker.show(hm, x, z);
    intents.send({ type: "move", targetX: x, targetZ: z });
  };

  const pointer = new PointerInput(canvas, {
    onMoveCommand: (ndc, initial) => {
      const hit = picker.pick(ndc.x, ndc.y);
      if (hit) moveTo(hit.x, hit.z, initial);
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
  keys.bind("Escape", () => worldMap.setOpen(false));

  // --- Dev tools (stripped from production builds) ------------------
  const frameHooks: Array<(dt: number) => void> = [];
  let cameraOverride: CameraOverride | null = null;
  if (import.meta.env.DEV) {
    const dev = await import("./dev/index.js");
    dev.mountDevTools({
      stage, canvas, scene: world.scene, camera: world.camera, data, walk, terrain, topo, water, mapImage, picker, keys, sim, chat,
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
        focus.set(x, getTerrainHeight(hm, x, z) + 1.2, z);
        orbit.update(dt, focus);
        terrain.update(x, z);
      }

      hero.update(hm, x, z, p.dirX, p.dirZ, dt);
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
