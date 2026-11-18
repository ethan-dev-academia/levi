import * as THREE from "three";
import { ABILITY_SLOTS, buildWalkGrid, Character, lerp, regionAt, storeyY, type AbilitySlot, type EnemyDef, type ItemDef, type ItemSlot, type NpcDef, type QuestDef, type Region } from "@levi/shared";
import { OrbitCamera } from "./camera/OrbitCamera.js";
import { loadMap } from "./content/mapLoader.js";
import { loadingDone, loadingFailed, loadingProgress, loadingStage } from "./loading.js";
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
import { skillIcon } from "./ui/skillIcons.js";
import { SkillTreeWindow } from "./ui/SkillTreeWindow.js";
import { mountSidebarResize } from "./ui/SidebarResize.js";
import { fitCharacterTab, focusQuestInBook, gameTabs } from "./ui/GameMenus.js";
import { QuestMapWindow } from "./ui/QuestMapWindow.js";
import { ItemUi } from "./ui/ItemUi.js";
import { ChestWindow } from "./ui/ChestWindow.js";
import { DialogueBox } from "./ui/DialogueBox.js";
import { QuestTracker } from "./ui/QuestTracker.js";
import { NpcLayer } from "./render/NpcLayer.js";
import { GroundItemLayer } from "./render/GroundItemLayer.js";
import { EnemyLayer } from "./render/EnemyLayer.js";
import { CombatFx } from "./render/CombatFx.js";
import { EncounterView } from "./render/EncounterView.js";
import { Ambience } from "./render/Ambience.js";
import { StoryOverlay } from "./ui/StoryOverlay.js";
import { Announcer } from "./ui/Announcer.js";
import { ArrivalIntro } from "./game/ArrivalIntro.js";
import { Tips } from "./ui/Tips.js";
import { Sound } from "./audio/Sound.js";
import { storyCamera } from "./game/storyCamera.js";
import { createCharacter, loadSave, storeSave } from "./game/characterStore.js";
import { interactionAtCell, isAdjacent, resolveInteraction, type Interaction, type InteractionContext } from "./game/Interactions.js";
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
  await loadingStage(0.04, "Opening the Archive…");
  const content = loadContent();
  const heroModel = getOrThrow(content.models, "humanoid", "model");
  await loadingStage(0.08, "Charting the islands…");
  const data = await loadMap(START_MAP, (f) => loadingProgress(0.08 + f * 0.52));
  // `data.def` is read live everywhere below: dev undo can replace it.
  const { hm } = data;
  await loadingStage(0.62, "Laying the roads…");
  const walk = buildWalkGrid(data);
  const topo = new TerrainTopology(data);
  await loadingStage(0.72, "Drawing the map…");
  const mapImage = new MapImage(data, walk, topo);
  await loadingStage(0.8, "Raising the land…");

  // --- UI -----------------------------------------------------------
  mountSidebarResize(el("side", HTMLElement));
  const hud = new Hud(el("hud", HTMLElement));
  renderPortrait(heroModel, hud.portrait);

  const controlsTab = textTab("settings", "Controls", ICONS.settings, [
    "Right-click: Walk / interact",
    "Middle-drag: Rotate camera",
    "Arrow keys: Rotate camera",
    "Wheel: Zoom",
    "M: World map",
    "Q W E R: Skills (bind in Skills tab)",
    "D F: Skills (mobility, utility)",
    "1 – 4: Hotbar items",
    "Left-click item: Use / equip",
    "Right-click item: Options",
    "Drag items: Move / swap",
    "S: Stop",
    "N: Sound on / off",
    "Enter: Chat",
  ]);

  await loadingStage(0.88, "Waking the townsfolk…");
  // --- World --------------------------------------------------------
  const stage = el("stage", HTMLElement);
  const canvas = el("viewport", HTMLCanvasElement);
  const world = new WorldRenderer(canvas);
  const terrain = new ChunkedTerrain(data, walk, topo);
  const water = createWater(hm, data.def.waterLevel);
  const clouds = new Clouds((x, z) => Math.max(data.def.waterLevel, data.buildings.groundHeight(hm, x, z)));
  clouds.rebuild(data.def.regions);
  const buildings = new BuildingLayer(data.buildings, hm);
  const props = new PropLayer(data.buildings, hm, content.models, content.props);
  const npcLayer = new NpcLayer(data.buildings, hm, content.npcs, content.models, stage);
  const groundItems = new GroundItemLayer(data.buildings, hm, content.items);
  const enemyLayer = new EnemyLayer(data.buildings, hm, content.models, stage);
  const combatFx = new CombatFx((x, z) => data.buildings.groundHeight(hm, x, z), stage);
  world.scene.add(terrain.group, water, clouds.group, buildings.group, props.group, npcLayer.group, groundItems.group, enemyLayer.group, combatFx.group);
  // Story encounters: one view, playing whichever encounter is running (Falcon's look comes from his NPC).
  const encounterDef = [...content.encounters.values()][0];
  const falconNpc = encounterDef ? content.npcs.get(encounterDef.falconNpc) : undefined;
  const encounterView = new EncounterView(
    (x, z) => data.buildings.groundHeight(hm, x, z),
    getOrThrow(content.models, falconNpc?.model ?? "humanoid", "model"),
    falconNpc?.palette ?? {},
    falconNpc?.scale ?? 1,
  );
  world.scene.add(encounterView.group);
  // Birds over the island, the town and the Cathedral; glowing lamps; campfire smoke; motes.
  const ambience = new Ambience((ax, az) => data.buildings.groundHeight(hm, ax, az), [
    { x: 520, y: 112, z: 300, radius: 70, count: 9 },
    { x: 540, y: 98, z: 372, radius: 26, count: 6 },
    { x: 1010, y: 62, z: 470, radius: 50, count: 11 },
  ]);
  world.scene.add(ambience.group);
  const story = new StoryOverlay(stage);
  let heroTilt = 0;
  const reader = new ReadPopup(stage);

  const hero = new CharacterEntity(heroModel);
  hero.addTo(world.scene);

  const marker = new ClickMarker();
  world.scene.add(marker.mesh);

  const orbit = new OrbitCamera(world.camera, hm);
  const cs = data.def.cellSize;
  const picker = new TerrainPicker(world.camera, hm, (x, z) => !data.isHole(Math.floor(x / cs), Math.floor(z / cs)));

  // --- Simulation + intent pipeline ---------------------------------
  // Character: restored from this browser's save (server-owned in Step 2).
  const gameData = { items: content.items, trees: content.trees, adventureCaps: content.adventureCaps, adventuringSkills: content.adventuringSkills };
  const saved = loadSave();
  const character = saved && saved.location.map === START_MAP ? new Character(saved, gameData) : createCharacter(gameData, START_MAP, data.def.spawn);
  const loc = character.save.location;
  const savedBuilding = loc.building ? data.buildings.get(loc.building) : undefined;
  const upstairs = loc.storey > 0 && savedBuilding?.grids[loc.storey]?.isWalkable(Math.floor(loc.x), Math.floor(loc.z));
  const startPos = upstairs || walk.isWalkable(Math.floor(loc.x), Math.floor(loc.z)) ? { x: loc.x, z: loc.z } : data.def.spawn;
  const announcer = new Announcer(stage);
  const sound = new Sound();
  const sim = new LocalSim(walk, data.buildings, startPos, { message: (t, k) => chat.add(t, k ?? "game"), banner: (b) => {
    announcer.announce(b.kind, b.title, b.detail);
    if (b.kind === "start") sound.questStart();
    else if (b.kind === "complete") sound.questComplete();
    else sound.levelUp();
  } }, character, {
    map: START_MAP,
    propDefs: content.props,
    npcs: content.npcs,
    quests: content.quests,
    enemies: content.enemies,
    encounters: content.encounters,
    respawn: data.def.spawn,
    respawns: () => data.def.respawns,
    regionAt: (x, z) => regionAt(data.def.regions, x, z)?.id ?? null,
    regionsAt: (x, z) => data.def.regions.filter((r) => x >= r.bounds.x0 && x < r.bounds.x1 && z >= r.bounds.z0 && z < r.bounds.z1).map((r) => r.id),
  });
  const interactCtx: InteractionContext = {
    buildings: data.buildings,
    propDefs: content.props,
    npcs: content.npcs,
    items: content.items,
    groundAvailable: (g) => sim.isGroundItemAvailable(g),
    npcAt: (cx, cz, storey, building) => sim.npcOnCell(cx, cz, storey, building),
    npcTarget: (spawn) => sim.npcTarget(spawn),
  };
  /** The current right-click press started on an enemy. */
  let attackPress = false;
  /** Re-walks toward a moving NPC this many more times before giving up. */
  let chaseLeft = 0;
  if (upstairs && savedBuilding) {
    sim.player.storey = loc.storey;
    sim.player.building = savedBuilding.def.id;
  }
  const intents = new LocalIntentSink((i) => sim.apply(i));

  // --- Menus (bag, character, skills, quests, friends) --------------------------
  const questMap = new QuestMapWindow(stage, {
    quests: content.quests,
    engine: () => sim.quests,
    actNames: content.actNames,
    pick: (id) => {
      focusQuestInBook(id);
      questMap.close();
      panel.open("quests");
    },
  });
  const skillTree = new SkillTreeWindow(stage, {
    character: () => sim.character,
    send: (i) => intents.send(i),
    inCombat: () => sim.inCombat,
  });
  const itemUi = new ItemUi({ character: () => sim.character, send: (i) => intents.send(i), message: (t) => chat.add(t) });
  for (let i = 0; i < hud.itemSlots.length; i++) hud.itemSlots[i]!.dataset["hot"] = String(i);
  const panel = new SidePanel(
    el("tabs", HTMLElement),
    el("tab-content", HTMLElement),
    gameTabs(
      {
        character: () => sim.character,
        inCombat: () => sim.inCombat,
        combatSecondsLeft: () => sim.combatSecondsLeft,
        send: (i) => intents.send(i),
        items: itemUi,
        quests: content.quests,
        engine: () => sim.quests,
        actNames: content.actNames,
        openTree: (style) => skillTree.open(style),
        adventuringSkills: content.adventuringSkills,
        dragSkill: (skill, style, e) => skillTree.beginDrag(skill, style, e),
        openQuestMap: () => questMap.toggle(),
      },
      controlsTab,
    ),
    "character",
  );
  // Re-fit the Character tab whenever the sidebar is resized.
  const tabContent = el("tab-content", HTMLElement);
  new ResizeObserver(() => fitCharacterTab(tabContent)).observe(tabContent);
  const chest = new ChestWindow(stage, itemUi, {
    contents: (id) => {
      const c = sim.container(id);
      return c ? sim.character.containerView(c.key, c.prop.loot ?? [], c.slots) : null;
    },
    send: (i) => intents.send(i),
  });

  const tracker = new QuestTracker(stage, () => panel.open("quests"), (id) => {
    const t = sim.questTargets().find((q) => q.quest === id);
    if (t) worldMap.focusOn(t);
    else chat.add("There's nowhere to mark for that one: it happens wherever you are.", "system");
  });
  for (const key of ABILITY_SLOTS) skillTree.bindHudSlot(hud.abilitySlot(key), key);
  const dialogue = new DialogueBox(stage, {
    choose: (option) => intents.send({ type: "talkNext", option }),
    end: () => intents.send({ type: "talkEnd" }),
  });

  /** Redraw everything that shows character state (only when it changed). */
  let shownVersion = -1;
  let shownCombatSecond = -1;
  const refreshCharacterUi = (): void => {
    const c = sim.character;
    for (let i = 0; i < hud.itemSlots.length; i++) itemUi.renderSlot(hud.itemSlots[i]!, { area: "hot", index: i }, c.save.hotbar[i] ?? null);
    for (const key of ABILITY_SLOTS) {
      const b = c.barSlot(key);
      if (b) {
        const res = c.poolFor(b.style);
        const needs = { mage: "a staff or wand", ranger: "a bow or gun", brawler: "a sword or dagger", adventuring: "" }[b.style];
        hud.setAbility(key, b.skill.name, b.usable ? `${b.skill.cost} ${res} · ${b.skill.cooldown}s` : `Needs ${needs}`, skillIcon(b.skill, b.style), b.usable);
      } else hud.setAbility(key, null);
    }
    hud.setResourceKind(c.resource);
    hud.setLevel(c.level(c.style));
    if (!itemUi.isDragging) panel.refresh();
    chest.refresh();
    skillTree.refresh();
    questMap.refresh();
    tracker.render(c, sim.quests, content.quests);
  };
  let lastStored = 0;
  const persist = (): void => storeSave(sim.character.save);
  window.addEventListener("beforeunload", persist);

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

  /** Enemy right under the cursor: its model, a little slack around small ones, or right at the clicked spot. */
  const enemyUnder = (x: number, y: number, ground: { x: number; z: number } | null): string | null =>
    enemyLayer.pick(world.camera, x, y) ??
    enemyLayer.pickNear(world.camera, x, y, 24) ??
    (ground ? sim.combat.enemyNear(ground.x, ground.z, 0.8)?.spawn.id ?? null : null);

  const pointer = new PointerInput(canvas, {
    onMoveCommand: (ndc, initial) => {
      if (intro.active) return;
      if (initial) {
        attackPress = false;
        const hitGround = picker.pick(ndc.x, ndc.y);
        const target = enemyUnder(ndc.x, ndc.y, hitGround);
        if (target) {
          // The whole press is an attack: hold-to-steer repeats mustn't turn it into a walk.
          attackPress = true;
          intents.send({ type: "attack", enemy: target });
          return;
        }
      } else if (attackPress) {
        // Holding on the enemy keeps attacking; dragging off it walks instead.
        if (enemyUnder(ndc.x, ndc.y, picker.pick(ndc.x, ndc.y))) return;
        attackPress = false;
      }
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
        // Clicking a model (NPC, sign, chest) counts as clicking its tile.
        const meshNpc = npcLayer.pick(world.camera, ndc.x, ndc.y);
        const meshProp = meshNpc ? null : props.pick(world.camera, ndc.x, ndc.y);
        const meshTarget = meshNpc ? sim.npcTarget(meshNpc) : meshProp;
        const action: Interaction | null =
          (meshTarget ? interactionAtCell(interactCtx, meshTarget.x, meshTarget.z, meshTarget.storey, meshTarget.building ?? null) : null) ??
          (hit0 ? resolveInteraction(interactCtx, hit0, p.storey, p.building) : null);
        if (action) {
          const t = action.target;
          // Chests are used from the front; everything else from any side.
          const front = action.kind === "open" ? sim.useCell(action.prop) : null;
          if (front) moveTo(front[0] + 0.5, front[1] + 0.5, true, surfaceAt(t.x + 0.5, t.z + 0.5));
          else moveTo(t.x + 0.5, t.z + 0.5, true, surfaceAt(t.x + 0.5, t.z + 0.5));
          pendingAction = action;
          chaseLeft = 4;
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
    () => {
      const prefix = `${START_MAP}:`;
      return new Set(sim.character.save.discovered.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    },
  );

  /**
   * Where a skillshot goes: the enemy you're pointing at on screen (snap), else
   * the cursor ray on a flat plane at your height, so hills don't bend the aim.
   */
  const aimRay = new THREE.Raycaster();
  const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const aimHit = new THREE.Vector3();
  /** Where the cursor points (flat plane at your height): the aim line follows this freely. */
  const cursorPoint = (): { x: number; z: number } => {
    const n = pointer.lastNdc;
    const p = sim.player;
    aimPlane.constant = -(surfaceAt(p.x, p.z) + 0.7);
    aimRay.setFromCamera(new THREE.Vector2(n.x, n.y), world.camera);
    if (aimRay.ray.intersectPlane(aimPlane, aimHit)) return { x: aimHit.x, z: aimHit.z };
    return picker.pick(n.x, n.y) ?? { x: p.x, z: p.z };
  };
  /** Where the shot actually goes on release: the enemy you're pointing at, else the cursor. */
  const aimPoint = (): { x: number; z: number } => {
    const n = pointer.lastNdc;
    const snapped = enemyLayer.pickNear(world.camera, n.x, n.y, 48);
    const e = snapped ? sim.combat.enemies.get(snapped) : undefined;
    if (e && e.mode !== "dead") return { x: e.x, z: e.z };
    return cursorPoint();
  };
  const keys = new Keyboard();
  const castKeys: ReadonlyArray<readonly [string, AbilitySlot]> = [
    ["KeyQ", "Q"], ["KeyW", "W"], ["KeyE", "E"], ["KeyR", "R"], ["KeyD", "D"], ["KeyF", "F"],
  ];
  // Skillshots: hold the key to aim (a line toward the cursor), release to fire.
  let aiming: AbilitySlot | null = null;
  for (const [code, slot] of castKeys) {
    keys.bind(code, () => {
      if (intro.active) return;
      const b = sim.character.barSlot(slot);
      if (b?.usable && b.skill.cast.kind === "line") {
        aiming = slot;
        return;
      }
      hud.flash(slot);
      const aim = aimPoint();
      intents.send({ type: "cast", slot, aimX: aim.x, aimZ: aim.z });
    });
    keys.bindRelease(code, () => {
      if (aiming !== slot) return;
      aiming = null;
      hud.flash(slot);
      const aim = aimPoint();
      intents.send({ type: "cast", slot, aimX: aim.x, aimZ: aim.z });
    });
  }
  const itemKeys: ReadonlyArray<readonly [string, ItemSlot]> = [["Digit1", 1], ["Digit2", 2], ["Digit3", 3], ["Digit4", 4]];
  for (const [code, slot] of itemKeys) {
    keys.bind(code, () => {
      hud.flash(`${slot}`);
      itemUi.useHotbar(slot - 1);
    });
  }
  keys.bind("KeyS", () => intents.send({ type: "stop" }));
  keys.bind("KeyN", () => chat.add(sound.toggleMute() ? "Sound off." : "Sound on.", "system"));
  keys.bind("Enter", () => chat.focus());
  keys.bind("KeyM", () => worldMap.toggle(sim.player));
  keys.bind("Escape", () => {
    worldMap.setOpen(false);
    reader.close();
    chest.close();
    itemUi.closeOverlays();
  });

  // --- Dev tools (stripped from production builds) ------------------
  const frameHooks: Array<(dt: number) => void> = [];
  let cameraOverride: CameraOverride | null = null;
  if (import.meta.env.DEV) {
    const dev = await import("./dev/index.js");
    dev.mountDevTools({
      stage, canvas, scene: world.scene, camera: world.camera, data, walk, terrain, topo, water, mapImage, picker, keys, sim, chat, buildings,
      props, propDefs: content.props,
      items: content.items as Map<string, ItemDef>,
      quests: content.quests,
      itemUi,
      onItemsChanged: () => sim.contentChanged(),
      npcLayer,
      groundItems,
      npcs: content.npcs as Map<string, NpcDef>,
      questDefs: content.quests as Map<string, QuestDef>,
      enemyDefs: content.enemies as Map<string, EnemyDef>,
      onEnemiesChanged: () => {
        sim.combat.refreshDefs();
        enemyLayer.rebuild();
      },
      model: (id) => content.models.get(id),
      characterModelIds: () => [...content.models.keys()].filter((id) => id === "humanoid" || id.startsWith("npc-")),
      enemyModelIds: () => [...content.models.keys()].filter((id) => id.startsWith("enemy-")),
      onFrame: (cb) => frameHooks.push(cb),
      setCameraOverride: (o) => (cameraOverride = o),
      onRegionsChanged: () => clouds.rebuild(data.def.regions),
    });
  }

  // --- Region tracking ----------------------------------------------
  let currentRegion: Region | null = null;
  let firstRegion = true;
  const discoveredAtBoot = new Set(sim.character.save.discovered);
  const titleShownAt = new Map<string, number>();
  const trackRegion = (x: number, z: number): void => {
    const r = regionAt(data.def.regions, x, z);
    if (r?.id !== currentRegion?.id) {
      currentRegion = r;
      if (r) {
        chat.add(`You arrive at ${r.name}.`, "system");
        // Big lands get a full title card the first time (and when you log in);
        // small named places (a meadow, the town) a lighter one, not too often.
        const area = (r.bounds.x1 - r.bounds.x0) * (r.bounds.z1 - r.bounds.z0);
        const minor = area < 20000;
        const now = performance.now();
        const fresh = firstRegion || (!discoveredAtBoot.has(`${START_MAP}:${r.id}`) && !titleShownAt.has(r.id));
        firstRegion = false;
        if (!intro.active && (minor ? now - (titleShownAt.get(r.id) ?? -1e9) > 90_000 : fresh)) {
          titleShownAt.set(r.id, now);
          announcer.regionTitle(r.name, r.subtitle ?? "", minor);
          if (!minor) sound.arrive();
        }
      }
    }
  };

  // A new hero's first moments (plays once; the server remembers it was seen).
  const intro = new ArrivalIntro({
    cinematic: (on) => {
      story.setCinematic(on);
      clouds.setDriftersVisible(!on);
    },
    whiteFlash: (a, b, c) => story.whiteFlash(a, b, c),
    voice: (text) => story.bark("voice", "A Voice", text),
    pillar: (px, pz, s) => encounterView.pillar(px, pz, s),
    title: () => {
      // The land itself (Falcon's Landing), not the town you're standing in.
      const p = sim.player;
      const around = data.def.regions.filter((r) => p.x >= r.bounds.x0 && p.x < r.bounds.x1 && p.z >= r.bounds.z0 && p.z < r.bounds.z1);
      const area = (r: Region): number => (r.bounds.x1 - r.bounds.x0) * (r.bounds.z1 - r.bounds.z0);
      const r = around.sort((a, b) => area(b) - area(a))[0];
      if (r) announcer.regionTitle(r.name, r.subtitle ?? "");
    },
    done: () => intents.send({ type: "beat", beat: "arrival" }),
  });
  if (!sim.character.save.worldFlags.includes("seen-arrival") && sim.quests.status("a-feather-on-the-wind") === "active") {
    intro.start(sim.player.x, sim.player.z, orbit.yaw);
    sound.story("arrival");
  }
  // Each turn of a story encounter gets its own (unresolved) chord.
  let lastPhase: string | null = null;
  const PHASE_BEATS = { crash: "dread", fight: "fight", rescue: "rescue", farewell: "farewell" } as const;

  // One-time tutorial tips, offered at the moment they're useful.
  const tips = new Tips(stage);
  let tipCheck = 0;
  const offerTips = (): void => {
    const c = sim.character;
    const p = sim.player;
    tips.offer("walk", "Right-click the ground to walk there (hold it to keep walking). Middle-drag or the arrow keys turn the camera; the wheel zooms.");
    if (c.save.pinned.length > 0) {
      tips.offer("quests", "Your newest quest pins itself at the top right. A gold ! or ? floats over people with something for you, and gold diamonds on the minimap and world map (M) show where to go.");
    }
    const weapon = c.save.equipment.weapon?.item;
    const spare = c.save.inventory.some((s) => s && c.def(s.item)?.weaponType && s.item !== weapon);
    if (spare) tips.offer("equip", "You have a new weapon. Open the Character tab (the shield) and click it in your bag to equip it. Each weapon type has its own skill tree.");
    if (weapon && weapon !== "basic-staff" && c.def(weapon)?.weaponType) {
      tips.offer("skills", "Open the Skills tab and click a combat style to see its skill tree. Drag a skill onto Q W E R, then hold the key to aim and release to cast.");
    }
    let enemy = false;
    let dummy = false;
    for (const e of sim.combat.enemies.values()) {
      if (e.mode === "dead" || e.scripted) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (e.def.dummy && d < 9) dummy = true;
      else if (!e.def.dummy && d < 14) enemy = true;
    }
    if (dummy) tips.offer("dummy", "Training dummies never fight back. Right-click one to attack it, and try your skills on it.");
    if (enemy) tips.offer("combat", "Right-click an enemy to attack it. Enemies mark the ground red before they strike: step out of the red to avoid the hit.");
    if (!sim.encounter && c.save.vitals.hp < c.stats.maxHp * 0.5) {
      tips.offer("health", "Health comes back slowly on its own. Food and tonics on your hotbar (keys 1-4) heal much faster.");
    }
  };

  // Where pinned quests point (refreshed a few times a second; wanderers move).
  let targets: ReturnType<typeof sim.questTargets> = [];
  let targetsAge = 99;
  let targetsVersion = -1;

  // --- Loop ---------------------------------------------------------
  const focus = new THREE.Vector3();
  terrain.update(sim.player.x, sim.player.z, true);
  startGameLoop({
    tick: () => sim.tick(),
    frame: (alpha, dt) => {
      const p = sim.player;
      const x = lerp(p.prevX, p.x, alpha);
      const z = lerp(p.prevZ, p.z, alpha);

      // Story encounter: what happened this tick, then the cutscene camera.
      const enc = sim.encounter;
      for (const e of sim.encounters) {
        const evs = e.drainEvents();
        for (const ev of evs) {
          if (ev.kind === "bark") story.bark(ev.speaker, ev.name, ev.text);
          else if (ev.kind === "cinematic") story.setCinematic(ev.on);
        }
        encounterView.handle(evs, {
          shake: (power, dur) => orbit.shake(power, dur),
          debris: (dur) => {
            const flag = e.def.arenaFlag;
            props.dropIn((inst) => !!inst.visibleWhen?.some((c) => c.kind === "flag" && c.flag === flag), dur, (rx, rz) => {
              encounterView.rockLanded(rx, rz);
              orbit.shake(0.18, 0.25);
            });
          },
          playerHit: () => story.hit(),
          flash: (a, b, c) => story.whiteFlash(a, b, c),
          player: () => ({ x: sim.player.x, z: sim.player.z }),
        });
      }
      const heroLift = encounterView.playerLift(enc, alpha, x, z);
      heroTilt += ((enc?.flight ? 0.75 : 0) - heroTilt) * (1 - Math.exp(-dt * 6));
      hero.lift = heroLift;
      hero.tilt = heroTilt;
      const introShot = intro.update(dt);
      const cut = introShot
        ? { shot: introShot, focus: { x, y: surfaceAt(x, z) + 1.2, z } }
        : storyCamera(enc, alpha, { x, z }, (sx, sz) => data.buildings.groundHeight(hm, sx, sz), heroLift);
      orbit.setShot(cut?.shot ?? null);

      if (cameraOverride) {
        cameraOverride.update(dt);
        const f = cameraOverride.focus();
        terrain.update(f.x, f.z);
      } else {
        orbit.rotateByKeys(keys.axis("ArrowRight", "ArrowLeft"), keys.axis("ArrowDown", "ArrowUp"), dt);
        if (cut) focus.set(cut.focus.x, cut.focus.y, cut.focus.z);
        else focus.set(x, surfaceAt(x, z) + 1.2, z);
        orbit.update(dt, focus);
        terrain.update(x, z);
      }

      // Character UI: bars every frame, menus only when something changed.
      const ch = sim.character;
      const st = ch.stats;
      hud.setHealth(ch.save.vitals.hp, st.maxHp);
      if (ch.resource === "mana") hud.setResource(ch.save.vitals.mana, st.maxMana);
      else hud.setResource(ch.save.vitals.energy, st.maxEnergy);
      const combatSecond = Math.ceil(sim.combatSecondsLeft);
      if (sim.version !== shownVersion || combatSecond !== shownCombatSecond) {
        if (sim.version !== shownVersion) persist();
        shownVersion = sim.version;
        shownCombatSecond = combatSecond;
        refreshCharacterUi();
      }
      const now = performance.now();
      if (now - lastStored > 5000) {
        lastStored = now;
        persist();
      }

      hero.update(surfaceAt, x, z, p.dirX, p.dirZ, dt);
      buildings.update({ x, z, storey: p.storey, building: p.building }, world.camera.position, dt);
      props.update(buildings, { x, z, y: surfaceAt(x, z) + 1 }, world.camera.position, dt, (inst) => sim.propShown(inst));
      npcLayer.update(world.camera, { x, z }, sim.talk?.spawn.id ?? null, buildings, dt, (id) => {
        const w = sim.npcWalkers().get(id);
        return w ? { x: lerp(w.prevX, w.x, alpha), z: lerp(w.prevZ, w.z, alpha), dirX: w.dirX, dirZ: w.dirZ, home: w.spawn.wander === "none" } : null;
      }, (id) => {
        const s = sim.npcWalkers().get(id)?.spawn;
        return !s || sim.npcShown(s);
      }, (id) => {
        const s = sim.npcWalkers().get(id)?.spawn;
        return s ? sim.npcMarker(s) : null;
      });
      groundItems.update(dt, (g) => sim.isGroundItemAvailable(g), buildings);
      enemyLayer.update(sim.combat, world.camera, { x, z }, alpha, dt, encounterView.bossLook(enc, alpha));
      encounterView.setViewport(stage.getBoundingClientRect().height);
      encounterView.update(enc, alpha, dt);
      ambience.setViewport(stage.getBoundingClientRect().height);
      ambience.update(dt, { x, z }, data.buildings.props, (pp) => props.baseY(pp));
      const phase = enc?.phase ?? null;
      if (phase !== lastPhase) {
        lastPhase = phase;
        if (phase && phase in PHASE_BEATS) sound.story(PHASE_BEATS[phase as keyof typeof PHASE_BEATS]);
      }
      const bossState = enc?.phase === "fight" ? sim.combat.enemies.get(enc.bossId) : undefined;
      story.setBoss(bossState ? { name: bossState.def.name, title: enc?.def.bossTitle ?? "", fraction: bossState.hp / bossState.def.stats.maxHp } : null);
      story.update(dt);
      const fresh = sim.combatEvents;
      sim.combatEvents = [];
      for (const e of fresh) if (e.kind === "cast") hero.playCast(e.melee || e.style === "brawler" ? "swing" : "thrust");
      combatFx.showEvents(fresh, (e) =>
        e.target === "player" ? new THREE.Vector3(x, surfaceAt(x, z) + 2.1, z) : enemyLayer.headOf(e.id) ?? new THREE.Vector3(e.x, surfaceAt(e.x, e.z) + 1.4, e.z),
      );
      combatFx.update(sim.combat, world.camera, alpha, dt);
      const tgt = sim.attackTarget ? sim.combat.enemies.get(sim.attackTarget) : undefined;
      combatFx.setTarget(tgt && tgt.mode !== "dead" ? { x: lerp(tgt.prevX, tgt.x, alpha), z: lerp(tgt.prevZ, tgt.z, alpha), r: sim.combat.radius(tgt) + 0.25 } : null);
      const aimSkill = aiming ? sim.character.barSlot(aiming) : undefined;
      if (aimSkill?.usable) {
        const to = cursorPoint();
        const pool = aimSkill.style === "mage" ? "mana" : "energy";
        const ready = sim.cooldownFraction(aiming!) <= 0 && sim.character.save.vitals[pool] >= aimSkill.skill.cost;
        combatFx.setAim({ x, z }, to, aimSkill.skill.cast.range, aimSkill.skill.cast.width, aimSkill.skill.cast.pierce, ready);
      } else combatFx.setAim(null, null);
      for (const key of ABILITY_SLOTS) hud.setCooldown(key, sim.cooldownFraction(key));
      // Sprint's key glows while you're running.
      const sprinting = sim.sprintLeft > 0;
      for (const key of ABILITY_SLOTS) {
        const b = sim.character.save.bar[key];
        hud.abilitySlot(key).classList.toggle("active", sprinting && b?.style === "adventuring" && b.skill === "sprint");
      }
      const talk = sim.talk;
      if (talk) {
        const isPlayer = talk.node.speaker === "player";
        dialogue.show({
          key: `${talk.spawn.id}:${talk.node.id}`,
          speaker: isPlayer ? "You" : talk.npc.name,
          title: isPlayer ? "" : talk.npc.title,
          isPlayer,
          text: talk.node.text,
          options: sim.quests.options(talk.node).map((o) => ({ index: o.index, text: o.option.text })),
        });
      } else if (dialogue.isOpen) dialogue.hide();
      if (pendingAction) {
        const a = pendingAction;
        // NPCs may stroll off while we walk over: aim at where they are now.
        const t = a.kind === "talk" ? sim.npcTarget(a.spawn) : a.target;
        const near = a.kind === "open" ? sim.canUse(a.prop) : p.storey === t.storey && isAdjacent(p.x, p.z, t.x, t.z);
        if (near) {
          sim.faceCell(t.x, t.z);
          if (a.kind === "read") reader.open(a.def.name, a.prop.text ?? "");
          else if (a.kind === "open") chest.open(a.prop.id, a.def.name);
          else if (a.kind === "talk") intents.send({ type: "talk", npc: a.spawn.id });
          else intents.send({ type: "pickup", item: a.item.id });
          lastRead = { x: p.x, z: p.z };
          pendingAction = null;
        } else if (p.path.length === 0) {
          if (a.kind === "talk" && chaseLeft-- > 0) {
            moveTo(t.x + 0.5, t.z + 0.5, false);
            pendingAction = a;
          } else pendingAction = null; // couldn't get there
        }
      } else if (lastRead && Math.hypot(lastRead.x - p.x, lastRead.z - p.z) > 4) {
        // Walked away: put the note down / close the chest.
        reader.close();
        chest.close();
        lastRead = null;
      }
      marker.update(dt);
      clouds.update(dt);
      trackRegion(x, z);
      for (const hook of frameHooks) hook(dt);

      const dest = sim.destination();
      targetsAge += dt;
      if (targetsAge > 0.4 || sim.version !== targetsVersion) {
        targets = sim.questTargets();
        targetsAge = 0;
        targetsVersion = sim.version;
      }
      minimap.draw({ x, z }, orbit.yaw, dest, targets);
      worldMap.draw({ x, z }, dest, targets);
      announcer.update(dt);
      // High winds up on the sky island, a breeze below.
      sound.setWind(data.def.regions.some((r) => r.kind === "sky" && x >= r.bounds.x0 && x < r.bounds.x1 && z >= r.bounds.z0 && z < r.bounds.z1) ? 1 : 0.45);
      sound.update(dt, p.storey === 0 && !p.building && !sim.encounter && !intro.active);
      tipCheck -= dt;
      if (tipCheck <= 0 && !intro.active) {
        tipCheck = 0.5;
        offerTips();
      }
      tips.update(dt, intro.active || sim.locked || !!sim.encounter || dialogue.isOpen);
      world.render();
    },
  });

  // The world is ready: lift the loading screen.
  loadingDone();
  chat.add("Welcome to Leviathan.", "system");
  chat.add("Right-click to walk. Middle-drag or arrow keys to turn the camera. M for the world map.");
}

boot().catch((e: unknown) => {
  console.error(e);
  loadingFailed(String(e));
  const log = document.getElementById("chat-log");
  if (log) log.textContent = `Failed to start: ${String(e)}`;
});
