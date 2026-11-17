import { z } from "zod";
import { PropInstanceSchema } from "./prop.js";

/** Same rule as map CONTENT_ID (kept local: map.ts imports this module). */
const CONTENT_ID = /^[a-z0-9_-]+$/;

/**
 * Buildings are authored on the map's cell grid (1 cell = 1 world unit):
 *  - floor tiles are cells, per storey
 *  - walls sit on cell EDGES (OSRS-style thin walls), per storey
 *  - stairs/ladders occupy a short strip of cells and link storeys
 * The roof is generated over the top storey. Storey 0 is the ground floor.
 */

const cell = z.number().int().min(0).max(65535);

export const WALL_MATERIALS = ["wood", "brick", "stone", "plaster"] as const;
export type WallMaterial = (typeof WALL_MATERIALS)[number];

export const ROOF_KINDS = ["gable", "hip", "shed", "flat", "none"] as const;
export type RoofKind = (typeof ROOF_KINDS)[number];

export const WALL_KINDS = ["wall", "door", "window"] as const;
export type WallKind = (typeof WALL_KINDS)[number];

export const DIRS = ["n", "e", "s", "w"] as const;
export type Dir = (typeof DIRS)[number];

/**
 * One wall segment on a cell edge.
 *  axis "x": runs along X from (x, z) to (x+1, z) — between cells (x, z-1) and (x, z)
 *  axis "z": runs along Z from (x, z) to (x, z+1) — between cells (x-1, z) and (x, z)
 * Doors are open doorways (walkable); windows block like walls.
 */
export const WallSchema = z.object({
  x: cell,
  z: cell,
  axis: z.enum(["x", "z"]),
  kind: z.enum(WALL_KINDS).default("wall"),
  /** Defaults to the building's material. */
  material: z.enum(WALL_MATERIALS).optional(),
});

export const StoreySchema = z.object({
  /** Floor cells [x, z]. Storey 0 tiles become walkable ground inside the building. */
  tiles: z.array(z.tuple([cell, cell])).max(16384).default([]),
  walls: z.array(WallSchema).max(16384).default([]),
});

/**
 * Stairs or a ladder. The foot cell is (x, z); it climbs towards `dir` over
 * `length` cells, linking storey `from` to storey `to` (stacked flights for
 * to > from + 1). You step on at the cell behind the foot and arrive just
 * past the top. Footprint cells are blocked on every storey it spans.
 */
export const StairSchema = z.object({
  id: z.string().regex(CONTENT_ID).max(64),
  kind: z.enum(["stairs", "ladder"]),
  x: cell,
  z: cell,
  dir: z.enum(DIRS),
  length: z.number().int().min(1).max(6).default(3),
  from: z.number().int().min(0),
  to: z.number().int().min(1),
});

export const RoofSchema = z.object({
  kind: z.enum(ROOF_KINDS).default("gable"),
  /** Rise per unit of run. */
  pitch: z.number().min(0.1).max(2).default(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const BuildingSchema = z
  .object({
    id: z.string().regex(CONTENT_ID).max(64),
    name: z.string().min(1).max(64),
    material: z.enum(WALL_MATERIALS).default("wood"),
    /** World height of the ground-floor surface. */
    baseY: z.number().finite(),
    floorHeight: z.number().min(2).max(6).default(2.6),
    storeys: z.array(StoreySchema).min(1).max(8),
    stairs: z.array(StairSchema).max(64).default([]),
    roof: RoofSchema.default({}),
  })
  .superRefine((b, ctx) => {
    const ids = new Set<string>();
    for (const s of b.stairs) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate stair id "${s.id}"` });
      ids.add(s.id);
      if (s.to <= s.from || s.to >= b.storeys.length) {
        ctx.addIssue({ code: "custom", message: `stair "${s.id}": storeys ${s.from}→${s.to} invalid for ${b.storeys.length} storey(s)` });
      }
    }
  });

/** content/maps/<id>/buildings.json: structures plus placed props. */
export const BuildingsFileSchema = z
  .object({
    buildings: z.array(BuildingSchema).max(4096),
    props: z.array(PropInstanceSchema).max(65536).default([]),
  })
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    for (const b of f.buildings) {
      if (ids.has(b.id)) ctx.addIssue({ code: "custom", message: `duplicate building id "${b.id}"` });
      ids.add(b.id);
    }
    const propIds = new Set<string>();
    for (const p of f.props) {
      if (propIds.has(p.id)) ctx.addIssue({ code: "custom", message: `duplicate prop id "${p.id}"` });
      propIds.add(p.id);
      if (p.storey > 0 && !(p.building && ids.has(p.building))) {
        ctx.addIssue({ code: "custom", message: `prop "${p.id}" on storey ${p.storey} needs an existing building` });
      }
    }
  });

export type Wall = z.infer<typeof WallSchema>;
export type Storey = z.infer<typeof StoreySchema>;
export type Stair = z.infer<typeof StairSchema>;
export type Roof = z.infer<typeof RoofSchema>;
export type Building = z.infer<typeof BuildingSchema>;
export type BuildingsFile = z.infer<typeof BuildingsFileSchema>;
