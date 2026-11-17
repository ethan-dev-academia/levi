import * as THREE from "three";
import { ABILITY_SLOTS, buildWalkGrid, Character, lerp, regionAt, storeyY, type AbilitySlot, type EnemyDef, type ItemDef, type ItemSlot, type NpcDef, type QuestDef, type Region } from "@levi/shared";
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
import { skillIcon } from "./ui/skillIcons.js";
import { SkillTreeWindow } from "./ui/SkillTreeWindow.js";
import { mountSidebarResize } from "./ui/SidebarResize.js";
import { fitCharacterTab, gameTabs } from "./ui/GameMenus.js";
import { ItemUi } from "./ui/ItemUi.js";
import { ChestWindow } from "./ui/ChestWindow.js";
import { DialogueBox } from "./ui/DialogueBox.js";
import { QuestTracker } from "./ui/QuestTracker.js";
import { NpcLayer } from "./render/NpcLayer.js";
import { GroundItemLayer } from "./render/GroundItemLayer.js";
import { EnemyLayer } from "./render/EnemyLayer.js";
import { CombatFx } from "./render/CombatFx.js";
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
  const content = loadContent();
  const heroModel = getOrThrow(content.models, "humanoid", "model");
  const data = await loadMap(START_MAP);
  // `data.def` is read live everywhere below: dev undo can replace it.
  const { hm } = data;
  const walk = buildWalkGrid(data);
  const topo = new TerrainTopology(data);
  const mapImage = new MapImage(data, walk, topo);

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
    "Enter: Chat",
  ]);

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
  const npcLayer = new NpcLayer(data.buildings, hm, content.npcs, content.models, stage);
  const groundItems = new GroundItemLayer(data.buildings, hm, content.items);
  const enemyLayer = new EnemyLayer(data.buildings, hm, content.models, stage);
  const combatFx = new CombatFx((x, z) => data.buildings.groundHeight(hm, x, z), stage);
  world.scene.add(terrain.group, water, clouds.group, buildings.group, props.group, npcLayer.group, groundItems.group, enemyLayer.group, combatFx.group);
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
  const gameData = { items: content.items, trees: content.trees, adventureCaps: content.adventureCaps };
  const saved = loadSave();
  const character = saved && saved.location.map === START_MAP ? new Character(saved, gameData) : createCharacter(gameData, START_MAP, data.def.spawn);
  const loc = character.save.location;
  const savedBuilding = loc.building ? data.buildings.get(loc.building) : undefined;
  const upstairs = loc.storey > 0 && savedBuilding?.grids[loc.storey]?.isWalkable(Math.floor(loc.x), Math.floor(loc.z));
  const startPos = upstairs || walk.isWalkable(Math.floor(loc.x), Math.floor(loc.z)) ? { x: loc.x, z: loc.z } : data.def.spawn;
  const sim = new LocalSim(walk, data.buildings, startPos, { message: (t, k) => chat.add(t, k ?? "game") }, character, {
    map: START_MAP,
    propDefs: content.props,
    npcs: content.npcs,
    quests: content.quests,
    enemies: content.enemies,
    respawn: data.def.spawn,
    regionAt: (x, z) => regionAt(data.def.regions, x, z)?.id ?? null,
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

  const tracker = new QuestTracker(stage, () => panel.open("quests"));
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
        const res = b.style === "mage" ? "mana" : "energy";
        const needs = { mage: "a staff or wand", ranger: "a bow or gun", brawler: "a sword or dagger" }[b.style];
        hud.setAbility(key, b.skill.name, b.usable ? `${b.skill.cost} ${res} · ${b.skill.cooldown}s` : `Needs ${needs}`, skillIcon(b.skill, b.style), b.usable);
      } else hud.setAbility(key, null);
    }
    hud.setResourceKind(c.resource);
    hud.setLevel(c.level(c.style));
    if (!itemUi.isDragging) panel.refresh();
    chest.refresh();
    skillTree.refresh();
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

  const pointer = new PointerInput(canvas, {
    onMoveCommand: (ndc, initial) => {
      if (initial) {
        attackPress = false;
        const hitGround = picker.pick(ndc.x, ndc.y);
        const target =
          enemyLayer.pick(world.camera, ndc.x, ndc.y) ??
          enemyLayer.pickNear(world.camera, ndc.x, ndc.y) ??
          (hitGround ? sim.combat.enemyNear(hitGround.x, hitGround.z, 1.4)?.spawn.id ?? null : null);
        if (target) {
          // The whole press is an attack: hold-to-steer repeats mustn't turn it into a walk.
          attackPress = true;
          intents.send({ type: "attack", enemy: target });
          return;
        }
      } else if (attackPress) return;
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
      props.update(buildings);
      npcLayer.update(world.camera, { x, z }, sim.talk?.spawn.id ?? null, buildings, dt, (id) => {
        const w = sim.npcWalkers().get(id);
        return w ? { x: lerp(w.prevX, w.x, alpha), z: lerp(w.prevZ, w.z, alpha), dirX: w.dirX, dirZ: w.dirZ, home: w.spawn.wander === "none" } : null;
      });
      groundItems.update(dt, (g) => sim.isGroundItemAvailable(g), buildings);
      enemyLayer.update(sim.combat, world.camera, { x, z }, alpha, dt);
      const fresh = sim.combatEvents;
      sim.combatEvents = [];
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
