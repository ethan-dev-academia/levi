/**
 * Dev tools entry. Loaded ONLY via `if (import.meta.env.DEV) await import(...)`
 * in main.ts, so none of this (nor dev.css) exists in a production bundle.
 */
import "./dev.css";
import { getTerrainHeight, nearestWalkableCell, type Region, type Vec2 } from "@levi/shared";
import { BrushCursor } from "./BrushCursor.js";
import { DevPanel } from "./DevPanel.js";
import { FreeCamera } from "./FreeCamera.js";
import { RegionOverlay } from "./RegionOverlay.js";
import { TerrainSculptor } from "./TerrainSculptor.js";
import type { DevContext } from "./types.js";

export type { DevContext };

const BRUSH_COLORS: Record<string, number> = {
  raise: 0x8fe39a, lower: 0xff8a6b, smooth: 0x8ecbff, flatten: 0xffe14a, set: 0xffe14a, paint: 0xffffff, walk: 0xff4a4a, void: 0x7ad7ff, region: 0xb89cff,
};

export function mountDevTools(ctx: DevContext): void {
  const sculptor = new TerrainSculptor(ctx);
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
    sculptor.save().then(
      (msg) => ctx.chat.add(`[dev] ${msg}`, "system"),
      (e: unknown) => ctx.chat.add(`[dev] ${String(e)}`, "system"),
    );
  };

  // Assigned after the panel exists (the panel's button calls it).
  let setFreeCam: (on: boolean) => void = () => {};
  const FLY_SPEED = 30;

  const panel = new DevPanel(
    ctx.stage,
    sculptor,
    {
      toggleFreeCam: () => setFreeCam(!freeCam.isActive),
      setFlySpeed: (v) => (freeCam.speed = v),
      undo: () => sculptor.undo(),
      save,
      setSpawnHere: () => {
        sculptor.setSpawn(ctx.sim.player);
        ctx.chat.add("[dev] Spawn set to player position (save to keep).", "system");
      },
      setWaterLevel: (v) => sculptor.setWaterLevel(v),
      setShowCollision: (v) => (ctx.terrain.showCollision = v),
      floatRegion: (id, lift) => report(sculptor.floatRegion(id, lift)),
      sinkOutsideRegions: (seabed) => report(sculptor.sinkOutsideRegions(seabed)),
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
  };

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
    const hit = pickCursor();
    if (!hit) return;
    ctx.canvas.setPointerCapture(e.pointerId);
    if (sculptor.settings.tool === "region") regionDrag = { start: hit, end: hit };
    else sculptor.beginStroke(hit);
  });
  ctx.canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
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
  const FREECAM_ALLOWED = new Set(["F1", "KeyC", "KeyM", "Escape", "Enter", "BracketLeft", "BracketRight"]);
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
  ctx.keys.bind("BracketLeft", () => panel.visible && (sculptor.settings.radius = Math.max(1, sculptor.settings.radius - 1)));
  ctx.keys.bind("BracketRight", () => panel.visible && (sculptor.settings.radius = Math.min(40, sculptor.settings.radius + 1)));

  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !panel.visible) return;
    if (e.code === "KeyZ") {
      e.preventDefault();
      sculptor.undo();
    } else if (e.code === "KeyS") {
      e.preventDefault();
      save();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (sculptor.hasUnsaved) e.preventDefault();
  });

  // --- Per frame -----------------------------------------------------------------
  ctx.onFrame((dt) => {
    panel.setCoords(ctx.sim.player.x, ctx.sim.player.z);
    overlay.group.visible = panel.visible;
    if (!panel.visible) return;
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

  ctx.chat.add("[dev] Dev tools loaded. Press F1 for the Terrain Sculptor.", "system");
}
