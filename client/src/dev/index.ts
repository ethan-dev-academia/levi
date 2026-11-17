/**
 * Dev tools entry. Loaded ONLY via `if (import.meta.env.DEV) await import(...)`
 * in main.ts, so none of this (nor dev.css) exists in a production bundle.
 */
import "./dev.css";
import { DIR_VEC, getTerrainHeight, nearestWalkableCell, stairCells, type CellRect, type Dir, type Region, type Vec2 } from "@levi/shared";
import { BrushCursor } from "./BrushCursor.js";
import { BuildOverlay } from "./BuildOverlay.js";
import { BuildPanel } from "./BuildPanel.js";
import { BuildTool, propFacing, type Edge, type Side } from "./BuildTool.js";
import { ItemManager } from "./ItemManager.js";
import { QuestEditor } from "./quests/QuestEditor.js";
import { DevPanel } from "./DevPanel.js";
import { FreeCamera } from "./FreeCamera.js";
import { RegionOverlay } from "./RegionOverlay.js";
import { TerrainSculptor } from "./TerrainSculptor.js";
import { clearSave, disableSaving, STARTING_QUESTS } from "../game/characterStore.js";
import type { DevContext } from "./types.js";

export type { DevContext };

const BRUSH_COLORS: Record<string, number> = {
  raise: 0x8fe39a, lower: 0xff8a6b, smooth: 0x8ecbff, flatten: 0xffe14a, set: 0xffe14a, paint: 0xffffff, walk: 0xff4a4a, void: 0x7ad7ff, region: 0xb89cff,
};

const OPPOSITE: Record<Side, Dir> = { n: "s", s: "n", e: "w", w: "e" };
const MAX_RUN = 64;

/** The cell edge nearest to a ground point. */
function edgeAt(x: number, z: number): Edge {
  const cx = Math.floor(x), cz = Math.floor(z);
  const fx = x - cx, fz = z - cz;
  const d = [fz, 1 - fz, fx, 1 - fx];
  const i = d.indexOf(Math.min(...d));
  if (i === 0) return { axis: "x", x: cx, z: cz };
  if (i === 1) return { axis: "x", x: cx, z: cz + 1 };
  if (i === 2) return { axis: "z", x: cx, z: cz };
  return { axis: "z", x: cx + 1, z: cz };
}

/** Straight run of edges from `a` towards the cursor, along a's axis. */
function edgeRun(a: Edge, x: number, z: number): Edge[] {
  const to = a.axis === "x" ? Math.floor(x) : Math.floor(z);
  const from = a.axis === "x" ? a.x : a.z;
  const lo = Math.max(Math.min(from, to), from - MAX_RUN);
  const hi = Math.min(Math.max(from, to), from + MAX_RUN);
  const out: Edge[] = [];
  for (let i = lo; i <= hi; i++) out.push(a.axis === "x" ? { axis: "x", x: i, z: a.z } : { axis: "z", x: a.x, z: i });
  return out;
}

function cellRect(a: { cx: number; cz: number }, b: { cx: number; cz: number }): CellRect {
  return { cx0: Math.min(a.cx, b.cx), cz0: Math.min(a.cz, b.cz), cx1: Math.max(a.cx, b.cx), cz1: Math.max(a.cz, b.cz) };
}

export function mountDevTools(ctx: DevContext): void {
  const sculptor = new TerrainSculptor(ctx);
  const builder = new BuildTool(ctx);
  const buildPanel = new BuildPanel(builder, ctx.propDefs, ctx.npcs, ctx.items, ctx.enemyDefs, () => ctx.data.buildings.enemies.length);
  const buildOverlay = new BuildOverlay();
  ctx.scene.add(buildOverlay.group);
  const itemManager = new ItemManager(ctx.stage, {
    items: ctx.items,
    itemUi: ctx.itemUi,
    onChanged: () => ctx.onItemsChanged(),
    give: (id, qty) => {
      const left = ctx.sim.character.addItem(id, qty);
      ctx.sim.markChanged();
      report(left > 0 ? `Bag full: ${left} didn't fit.` : `Added ${qty}× ${ctx.items.get(id)?.name ?? id}.`);
    },
    report: (m) => ctx.chat.add(`[dev] ${m}`, "system"),
    usages: (id) => [
      ...ctx.data.buildings.props.filter((p) => p.loot?.some((l) => l?.item === id)).map((p) => `chest ${p.id}`),
      ...[...ctx.quests.values()].filter((q) => q.rewards.items.some((i) => i.item === id) || q.steps.some((s) => s.objectives.some((o) => "item" in o && o.item === id))).map((q) => `quest ${q.id}`),
    ],
  });
  // F2: quests + NPCs.
  const questEditor = new QuestEditor(ctx.stage, {
    quests: ctx.questDefs,
    npcs: ctx.npcs,
    lookups: {
      quests: ctx.questDefs,
      npcs: ctx.npcs,
      items: ctx.items,
      propDefs: ctx.propDefs,
      regions: () => ctx.data.def.regions.map((r) => ({ id: r.id, name: r.name })),
    },
    model: ctx.model,
    modelIds: ctx.characterModelIds,
    engine: () => ctx.sim.quests,
    character: () => ctx.sim.character,
    onQuestsChanged: () => ctx.sim.markChanged(),
    enemies: ctx.enemyDefs,
    enemyModelIds: () => ctx.characterModelIds().concat(ctx.enemyModelIds()),
    onEnemiesChanged: () => {
      ctx.onEnemiesChanged();
      buildPanel.refresh(true);
    },
    onNpcsChanged: () => {
      ctx.npcLayer.rebuild();
      ctx.sim.markChanged();
      buildPanel.refresh(true);
    },
    report: (m) => ctx.chat.add(`[dev] ${m}`, "system"),
  });
  ctx.keys.bind("F2", () => questEditor.toggle());

  builder.onEditLoot = (prop) => {
    const def = ctx.propDefs.get(prop.prop);
    itemManager.openLoot({
      title: `${def?.name ?? "Chest"} loot · ${prop.id}`,
      slots: def?.container?.slots ?? 8,
      loot: prop.loot ?? [],
      onSave: (loot) => {
        builder.setPropLoot(prop.id, loot);
        report(`Saved loot for ${prop.id} (${loot.filter(Boolean).length} slot(s)). Press Save to write the map.`);
      },
      onRemove: () => {
        builder.removeProp(prop.id);
        report(`Removed ${prop.id}.`);
      },
    });
  };
  const cursor = new BrushCursor();
  ctx.scene.add(cursor.line);
  const overlay = new RegionOverlay(ctx.data.hm, () => ctx.data.def.waterLevel);
  ctx.scene.add(overlay.group);
  overlay.rebuild(ctx.data.def.regions);
  const report = (msg: string): void => ctx.chat.add(`[dev] ${msg}`, "system");
  const cs = ctx.data.def.cellSize;
  /** Visible surface height: terrain, or the sea where there's void. */
  const surfaceAt = (x: number, z: number): number =>
    ctx.data.isHole(Math.floor(x / cs), Math.floor(z / cs))
      ? ctx.data.def.waterLevel
      : Math.max(getTerrainHeight(ctx.data.hm, x, z), ctx.data.def.waterLevel);

  const save = (): void => {
    const buildingsDirty = builder.dirty;
    sculptor.save(buildingsDirty ? builder.file() : undefined).then(
      (msg) => {
        if (buildingsDirty) builder.dirty = false;
        panel.refresh();
        ctx.chat.add(`[dev] ${msg}`, "system");
      },
      (e: unknown) => ctx.chat.add(`[dev] ${String(e)}`, "system"),
    );
  };

  // Assigned after the panel exists (the panel's button calls it).
  let setFreeCam: (on: boolean) => void = () => {};
  const FLY_SPEED = 30;

  let mode: "terrain" | "build" | "items" = "terrain";
  const panel = new DevPanel(
    ctx.stage,
    sculptor,
    buildPanel,
    {
      toggleFreeCam: () => setFreeCam(!freeCam.isActive),
      setFlySpeed: (v) => (freeCam.speed = v),
      undo: () => (mode === "build" ? builder.undo() : sculptor.undo()),
      canUndo: () => (mode === "build" ? builder.canUndo : sculptor.canUndo),
      hasUnsaved: () => sculptor.hasUnsaved || builder.dirty,
      // Runs inside the panel constructor: only touch what's already declared.
      setMode: (m) => {
        mode = m;
        cursor.hide();
        if (m === "items") itemManager.openManager();
      },
      save,
      setSpawnHere: () => {
        sculptor.setSpawn(ctx.sim.player);
        ctx.chat.add("[dev] Spawn set to player position (save to keep).", "system");
      },
      setWaterLevel: (v) => sculptor.setWaterLevel(v),
      setShowCollision: (v) => (ctx.terrain.showCollision = v),
      floatRegion: (id, lift) => report(sculptor.floatRegion(id, lift)),
      sinkOutsideRegions: (seabed) => report(sculptor.sinkOutsideRegions(seabed)),
      openItemManager: () => itemManager.openManager(),
      resetQuests: () => {
        const c = ctx.sim.character;
        const save = c.save;
        const n = Object.keys(save.quests).length;
        if (ctx.sim.talk) ctx.sim.apply({ type: "talkEnd" });
        save.quests = {};
        save.pinned = [];
        save.worldFlags = [];
        save.xp.adventuring = 0;
        save.pickedUp = [];
        // Quest items go too, from bag and hotbar.
        for (const list of [save.inventory, save.hotbar]) {
          list.forEach((s, i) => {
            if (s && c.def(s.item)?.kind === "quest") list[i] = null;
          });
        }
        for (const id of STARTING_QUESTS) save.quests[id] = { stage: 0, progress: {} };
        ctx.sim.markChanged();
        report(`Quests reset (${n} cleared): progress, story flags, Adventuring XP, quest items and picked-up ground items.`);
      },
      clearBag: () => {
        const save = ctx.sim.character.save;
        const n = [...save.inventory, ...save.hotbar].filter(Boolean).length;
        save.inventory.fill(null);
        save.hotbar.fill(null);
        ctx.sim.markChanged();
        report(n ? `Cleared ${n} slot(s) from your bag and hotbar.` : "Your bag and hotbar are already empty.");
      },
      resetLoot: () => {
        const save = ctx.sim.character.save;
        const n = Object.keys(save.containers).length + save.pickedUp.length;
        save.containers = {};
        save.pickedUp = [];
        ctx.sim.markChanged();
        report(n ? `Loot regenerated: ${n} chest(s) / ground item(s) restored.` : "Nothing to reset: nothing looted yet.");
      },
      testCombat: () => {
        ctx.sim.enterCombat(10);
        report("You're in combat for 10s: try changing gear or skills.");
      },
      resetCharacter: () => {
        disableSaving();
        clearSave();
        location.reload();
      },
      goToRegion: (id) => {
        const r = ctx.data.def.regions.find((x) => x.id === id);
        if (!r) return;
        const c = { x: (r.bounds.x0 + r.bounds.x1) / 2, z: (r.bounds.z0 + r.bounds.z1) / 2 };
        const cell = ctx.walk.cellOf(c);
        const near = nearestWalkableCell(ctx.walk, cell.cx, cell.cz, 96, c);
        const p = near ? ctx.walk.cellCenter(near.cx, near.cz) : c;
        ctx.sim.teleport(p.x, p.z);
      },
    },
    ctx.data.def.waterLevel,
    FLY_SPEED,
  );
  sculptor.onChange = () => {
    panel.refresh();
    overlay.rebuild(ctx.data.def.regions);
    // Foundations follow the terrain under them.
    if (ctx.data.buildings.size > 0) ctx.buildings.rebuildAll();
    if (ctx.data.buildings.props.length > 0) ctx.props.rebuild();
  };
  builder.onChange = () => panel.refresh();

  // --- Input ----------------------------------------------------------------
  const ndc = { x: 0, y: 0, over: false, moved: true };
  const updateNdc = (e: PointerEvent): void => {
    const r = ctx.canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ndc.over = true;
    ndc.moved = true;
  };
  let regionDrag: { start: Vec2; end: Vec2 } | null = null;
  // Build mode: a box drag (room/floor/erase) or an edge run (wall/door/window).
  let buildDrag: { kind: "rect"; start: { cx: number; cz: number } } | { kind: "edges"; start: Edge } | null = null;
  /** Painting a spawn zone (left button held). */
  let zoneStroke = false;
  let scatterStroke = false;
  let buildAt: (Vec2 & { y: number }) | null = null;
  const groundY = (x: number, z: number): number => ctx.data.buildings.groundHeight(ctx.data.hm, x, z);
  /** Cursor on the edit plane: the selected building's storey, else the ground. */
  const buildPick = (): (Vec2 & { y: number }) | null => {
    if (!ndc.over) return null;
    const planeY = builder.settings.storey > 0 ? builder.editPlaneY() : null;
    if (planeY !== null) {
      const p = ctx.buildings.pickFloor(ctx.camera, ndc.x, ndc.y, planeY);
      return p ? { x: p.x, z: p.z, y: planeY } : null;
    }
    const hit = ctx.picker.pick(ndc.x, ndc.y);
    return hit ? { ...hit, y: groundY(hit.x, hit.z) } : null;
  };
  const cameraSide = (x: number, z: number): Side => {
    const dx = ctx.camera.position.x - x, dz = ctx.camera.position.z - z;
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "e" : "w") : dz > 0 ? "s" : "n";
  };
  const cellOf = (p: Vec2): { cx: number; cz: number } => ({ cx: Math.floor(p.x), cz: Math.floor(p.z) });
  const finishBuildDrag = (): void => {
    const d = buildDrag;
    buildDrag = null;
    // Re-pick at the release point: the per-frame cursor can lag a fast drag.
    const at = buildPick() ?? buildAt;
    if (!d || !at) return;
    const t = builder.settings.tool;
    let msg = "";
    if (d.kind === "rect") {
      const r = cellRect(d.start, cellOf(at));
      if (t === "erase") msg = builder.erase(r);
      else if (t === "floor") {
        const preset = builder.settings.preset;
        builder.settings.preset = "floor";
        msg = builder.placeRoom(r, cameraSide((r.cx0 + r.cx1 + 1) / 2, (r.cz0 + r.cz1 + 1) / 2));
        builder.settings.preset = preset;
      } else msg = builder.placeRoom(r, cameraSide((r.cx0 + r.cx1 + 1) / 2, (r.cz0 + r.cz1 + 1) / 2));
    } else {
      msg = builder.paintEdges(edgeRun(d.start, at.x, at.z), t === "door" ? "door" : t === "window" ? "window" : "wall");
    }
    if (msg) report(msg);
  };
  const onBuildDown = (): void => {
    const hit = buildPick();
    buildAt = hit;
    if (!hit) return;
    const t = builder.settings.tool;
    const c = cellOf(hit);
    if (t === "room" || t === "floor" || t === "erase") buildDrag = { kind: "rect", start: c };
    else if (t === "wall" || t === "door" || t === "window") buildDrag = { kind: "edges", start: edgeAt(hit.x, hit.z) };
    else if (t === "stairs" || t === "ladder") report(builder.placeStair(c.cx, c.cz, t, OPPOSITE[cameraSide(hit.x, hit.z)]));
    else if (t === "prop" && builder.scattering) {
      builder.beginScatter();
      scatterStroke = true;
      builder.scatterAt(c.cx, c.cz);
    } else if (t === "prop") report(builder.placeProp(c.cx, c.cz));
    else if (t === "npc") report(builder.placeNpc(c.cx, c.cz));
    else if (t === "item") report(builder.placeGroundItem(c.cx, c.cz));
    else if (t === "enemy") report(builder.placeEnemy(c.cx, c.cz));
    else if (t === "zone") {
      const err = builder.beginZoneStroke();
      if (err) report(err);
      else {
        zoneStroke = true;
        builder.paintZone(c.cx, c.cz);
      }
    } else report(builder.pick(c.cx, c.cz));
  };
  const rectOf = (a: Vec2, b: Vec2): Region["bounds"] => ({
    x0: Math.floor(Math.min(a.x, b.x)), z0: Math.floor(Math.min(a.z, b.z)),
    x1: Math.ceil(Math.max(a.x, b.x)), z1: Math.ceil(Math.max(a.z, b.z)),
  });
  // Brush point is only re-picked when the mouse (or camera) moves; otherwise a
  // rising hill would pull the ray hit toward the camera mid-stroke.
  let brushAt: Vec2 | null = null;
  const camPos = ctx.camera.position.clone();
  const pickCursor = (): Vec2 | null => (ndc.over ? ctx.picker.pick(ndc.x, ndc.y) : null);

  ctx.canvas.addEventListener("pointermove", updateNdc);
  ctx.canvas.addEventListener("pointerleave", () => (ndc.over = false));
  ctx.canvas.addEventListener("pointerdown", (e) => {
    updateNdc(e);
    if (e.button !== 0 || !panel.visible) return;
    if (mode === "build") {
      ctx.canvas.setPointerCapture(e.pointerId);
      onBuildDown();
      return;
    }
    const hit = pickCursor();
    if (!hit) return;
    ctx.canvas.setPointerCapture(e.pointerId);
    if (sculptor.settings.tool === "region") regionDrag = { start: hit, end: hit };
    else sculptor.beginStroke(hit);
  });
  ctx.canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    updateNdc(e);
    if (buildDrag) finishBuildDrag();
    if (scatterStroke) {
      scatterStroke = false;
      report(builder.endScatter());
    }
    if (zoneStroke) {
      zoneStroke = false;
      builder.endZoneStroke();
      const z = builder.selectedZone();
      if (z) report(`${z.name}: ${z.cells.length} cells.`);
    }
    if (sculptor.isStroking) sculptor.endStroke();
    if (regionDrag) {
      const b = rectOf(regionDrag.start, regionDrag.end);
      regionDrag = null;
      overlay.setPreview(null);
      if (b.x1 - b.x0 >= 8 && b.z1 - b.z0 >= 8) {
        const r = sculptor.addRegion(b);
        report(`Created ${r.id} (${b.x1 - b.x0}×${b.z1 - b.z0}). Rename it in the Regions list.`);
      } else {
        report("Region too small (min 8×8). Drag a larger box.");
      }
    }
  });

  // Ctrl + right-click teleport. Capture phase on the target runs before the
  // game's own right-click handler, which we then suppress.
  ctx.canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 2 || !e.ctrlKey) return;
      updateNdc(e);
      const hit = pickCursor();
      e.stopImmediatePropagation();
      e.preventDefault();
      if (hit) ctx.sim.teleport(hit.x, hit.z);
    },
    { capture: true },
  );

  // --- Free camera (after the teleport listener so Ctrl+RMB keeps priority) --
  const freeCam = new FreeCamera(ctx.camera, ctx.data.hm, ctx.keys, ctx.canvas);
  freeCam.speed = FLY_SPEED;
  // While flying, WASD/QE drive the camera, so gameplay binds are muted.
  const FREECAM_ALLOWED = new Set(["F1", "F2", "KeyC", "KeyM", "Escape", "Enter", "BracketLeft", "BracketRight"]);
  setFreeCam = (on) => {
    if (on === freeCam.isActive) return;
    if (on) {
      freeCam.enter();
      ctx.setCameraOverride(freeCam);
      ctx.keys.setBindingFilter((code) => FREECAM_ALLOWED.has(code));
    } else {
      freeCam.exit();
      ctx.setCameraOverride(null);
      ctx.keys.setBindingFilter(null);
    }
    panel.setFreeCamActive(on);
  };
  ctx.keys.bind("KeyC", () => panel.visible && setFreeCam(!freeCam.isActive));

  ctx.keys.bind("F1", () => {
    panel.toggle();
    if (!panel.visible) {
      if (sculptor.isStroking) sculptor.endStroke();
      cursor.hide();
      setFreeCam(false);
    }
  });
  ctx.keys.bind("BracketLeft", () => {
    if (!panel.visible) return;
    if (mode === "build") builder.rotateProp();
    else sculptor.settings.radius = Math.max(1, sculptor.settings.radius - 1);
  });
  ctx.keys.bind("BracketRight", () => {
    if (!panel.visible) return;
    if (mode === "build") builder.rotateProp();
    else sculptor.settings.radius = Math.min(40, sculptor.settings.radius + 1);
  });

  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !panel.visible) return;
    if (e.code === "KeyZ") {
      e.preventDefault();
      if (mode === "build") builder.undo();
      else sculptor.undo();
    } else if (e.code === "KeyS") {
      e.preventDefault();
      save();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (sculptor.hasUnsaved || builder.dirty) e.preventDefault();
  });

  // --- Per frame -----------------------------------------------------------------
  ctx.onFrame((dt) => {
    panel.setCoords(ctx.sim.player.x, ctx.sim.player.z);
    overlay.group.visible = panel.visible && mode === "terrain";
    const building = panel.visible && mode === "build";
    buildOverlay.group.visible = building;
    if (!building) buildDrag = null;
    ctx.buildings.editView = building ? { building: builder.settings.selected, storey: builder.settings.storey } : null;
    if (!panel.visible) return;
    if (building) {
      cursor.hide();
      updateBuildPreview();
      return;
    }
    const camMoved = camPos.distanceToSquared(ctx.camera.position) > 1e-6;
    camPos.copy(ctx.camera.position);
    if (ndc.moved || camMoved || !sculptor.isStroking || !brushAt) {
      brushAt = pickCursor();
      ndc.moved = false;
    }
    const hit = brushAt;
    if (!hit) {
      cursor.hide();
      return;
    }
    if (sculptor.settings.tool === "region") {
      cursor.hide();
      if (regionDrag) {
        regionDrag.end = hit;
        overlay.setPreview(rectOf(regionDrag.start, hit));
      }
      return;
    }
    cursor.setColor(BRUSH_COLORS[sculptor.settings.tool] ?? 0xffffff);
    cursor.update(surfaceAt, hit.x, hit.z, sculptor.settings.radius);
    if (sculptor.isStroking) {
      sculptor.apply(hit, dt);
      panel.refresh();
    }
  });

  function updateBuildPreview(): void {
    const hit = buildPick();
    buildAt = hit ?? buildAt;
    if (!hit) {
      buildOverlay.clearShape();
      return;
    }
    const c = cellOf(hit);
    const planeY = builder.settings.storey > 0 ? builder.editPlaneY() : null;
    buildOverlay.setGrid(c.cx, c.cz, planeY !== null ? () => planeY : groundY);
    const t = builder.settings.tool;
    const wallH = builder.selected?.floorHeight ?? 2.6;
    buildOverlay.setColor(t === "erase" ? 0xff5a4a : t === "select" ? 0xb89cff : 0xffe14a);
    const y = buildDrag?.kind === "rect" ? (planeY ?? groundY(buildDrag.start.cx + 0.5, buildDrag.start.cz + 0.5)) : hit.y;
    if (t === "room" || t === "floor" || t === "erase") {
      const r = buildDrag?.kind === "rect" ? cellRect(buildDrag.start, c) : cellRect(c, c);
      buildOverlay.setRect(r, y, t === "room" && builder.settings.preset !== "floor" ? wallH : 0);
    } else if (t === "wall" || t === "door" || t === "window") {
      const edges = buildDrag?.kind === "edges" ? edgeRun(buildDrag.start, hit.x, hit.z) : [edgeAt(hit.x, hit.z)];
      buildOverlay.setEdges(edges, y, t === "door" ? 2.05 : wallH);
    } else if (t === "npc") {
      const sp = builder.placedNpc();
      const cells: Array<[number, number]> = [];
      if (sp?.wander === "route") cells.push([sp.x, sp.z], ...sp.route);
      else if (sp?.wander === "area") {
        for (let dz = -sp.radius; dz <= sp.radius; dz++) for (let dx = -sp.radius; dx <= sp.radius; dx++) cells.push([sp.x + dx, sp.z + dz]);
      } else if (sp) cells.push([sp.x, sp.z]);
      cells.push([c.cx, c.cz]);
      buildOverlay.setCells(cells, y, propFacing(builder.settings.rot));
    } else if (t === "prop" && builder.scattering) {
      if (scatterStroke) builder.scatterAt(c.cx, c.cz);
      const r = builder.settings.scatterRadius;
      const ring: Array<[number, number]> = [];
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r + r) ring.push([c.cx + dx, c.cz + dz]);
      buildOverlay.setColor(builder.settings.scatterErase ? 0xff5a4a : 0x6cc24a);
      buildOverlay.setOutlines([ring], groundY, null);
    } else if (t === "prop") {
      buildOverlay.setCells([[c.cx, c.cz]], y, propFacing(builder.settings.rot));
    } else if (t === "zone") {
      if (zoneStroke) builder.paintZone(c.cx, c.cz);
      buildOverlay.setColor(builder.settings.zoneErase ? 0xff5a4a : 0xff9a3c);
      const sel = builder.selectedZone();
      const sets = sel ? [sel.cells] : builder.zones.map((z) => z.cells);
      buildOverlay.setOutlines(sets, groundY, sel ? { cx: c.cx, cz: c.cz, r: builder.settings.zoneBrush - 1 } : null);
    } else if (t === "enemy") {
      // Show every enemy spot plus the cursor cell.
      const cells: Array<[number, number]> = ctx.data.buildings.enemies.map((e) => [e.x, e.z]);
      cells.push([c.cx, c.cz]);
      buildOverlay.setCells(cells, y, propFacing(builder.settings.rot));
    } else if (t === "stairs" || t === "ladder") {
      const dir = OPPOSITE[cameraSide(hit.x, hit.z)];
      const cells = stairCells({ id: "p", kind: t, x: c.cx, z: c.cz, dir, length: t === "ladder" ? 1 : 3, from: 0, to: 1 });
      buildOverlay.setCells(cells, y, DIR_VEC[dir]);
    } else {
      const info = ctx.data.buildings.containing(c.cx, c.cz);
      if (info) buildOverlay.setRect(info.bounds, y, 0.4);
      else buildOverlay.clearShape();
    }
  }

  ctx.chat.add("[dev] Dev tools loaded. Press F1 for the Terrain Sculptor and Building tools.", "system");
}
