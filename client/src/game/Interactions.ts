import type { BuildingIndex, GroundItem, ItemDef, NpcDef, NpcSpawn, PropDef, PropInstance, Vec2 } from "@levi/shared";

/** The tile something stands on. */
export interface Target {
  x: number;
  z: number;
  storey: number;
  building?: string | undefined;
}

/**
 * Tile-based interactions: anything you can act on owns a cell, and a click
 * anywhere on that cell (or just over its edge) snaps to it. New kinds
 * (doors, enemies, gathering nodes) plug in here.
 */
export type Interaction =
  | { kind: "read"; target: Target; prop: PropInstance; def: PropDef }
  | { kind: "open"; target: Target; prop: PropInstance; def: PropDef }
  | { kind: "talk"; target: Target; spawn: NpcSpawn; def: NpcDef }
  | { kind: "pickup"; target: Target; item: GroundItem; def: ItemDef };

/** How far past a tile's edge a click still counts for that tile (cells). */
const EDGE_TOLERANCE = 0.3;

export interface InteractionContext {
  buildings: BuildingIndex;
  propDefs: ReadonlyMap<string, PropDef>;
  npcs: ReadonlyMap<string, NpcDef>;
  items: ReadonlyMap<string, ItemDef>;
  /** Ground item still there for this player? */
  groundAvailable(g: GroundItem): boolean;
  /** NPC standing on a cell right now (they can wander). */
  npcAt(cx: number, cz: number, storey: number, building: string | null): NpcSpawn | undefined;
  /** Tile an NPC is on right now. */
  npcTarget(spawn: NpcSpawn): Target;
}

/** What can be done with whatever stands on cell (cx, cz), if anything. NPCs first, then items, then props. */
export function interactionAtCell(ctx: InteractionContext, cx: number, cz: number, storey: number, building: string | null): Interaction | null {
  const spawn = ctx.npcAt(cx, cz, storey, building);
  const npc = spawn ? ctx.npcs.get(spawn.npc) : undefined;
  if (spawn && npc) return { kind: "talk", target: ctx.npcTarget(spawn), spawn, def: npc };

  const g = ctx.buildings.groundItemAt(cx, cz, storey, building);
  const item = g ? ctx.items.get(g.item) : undefined;
  if (g && item && ctx.groundAvailable(g)) return { kind: "pickup", target: g, item: g, def: item };

  const prop = ctx.buildings.propAt(cx, cz, storey, building);
  const def = prop ? ctx.propDefs.get(prop.prop) : undefined;
  if (prop && def?.readable) return { kind: "read", target: prop, prop, def };
  if (prop && def?.container) return { kind: "open", target: prop, prop, def };
  return null;
}

/**
 * Resolve a ground click to an interaction: the clicked tile first, then
 * neighbouring tiles whose edge the click is within EDGE_TOLERANCE of
 * (nearest first), so near-misses still snap to the object.
 */
export function resolveInteraction(ctx: InteractionContext, at: Vec2, storey: number, building: string | null): Interaction | null {
  const cx = Math.floor(at.x);
  const cz = Math.floor(at.z);
  const exact = interactionAtCell(ctx, cx, cz, storey, building);
  if (exact) return exact;

  const fx = at.x - cx;
  const fz = at.z - cz;
  const candidates: Array<{ dx: number; dz: number; d: number }> = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const ex = dx < 0 ? fx : dx > 0 ? 1 - fx : 0;
      const ez = dz < 0 ? fz : dz > 0 ? 1 - fz : 0;
      const d = Math.hypot(ex, ez);
      if (d <= EDGE_TOLERANCE) candidates.push({ dx, dz, d });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const c of candidates) {
    const hit = interactionAtCell(ctx, cx + c.dx, cz + c.dz, storey, building);
    if (hit) return hit;
  }
  return null;
}

/** Interactions that need the player next to the tile (Chebyshev distance ≤ 1). */
export function isAdjacent(px: number, pz: number, cx: number, cz: number): boolean {
  return Math.max(Math.abs(Math.floor(px) - cx), Math.abs(Math.floor(pz) - cz)) <= 1;
}
