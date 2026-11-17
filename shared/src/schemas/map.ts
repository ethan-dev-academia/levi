import { z } from "zod";

const finite = z.number().finite();

export const CONTENT_ID = /^[a-z0-9_-]+$/;
export const CHUNK_KEY = /^\d+_\d+$/;

export const chunkKey = (kx: number, kz: number): string => `${kx}_${kz}`;

/**
 * Named area of a map (OSRS-style). Drives world-map labels, "you arrive at"
 * messages, cloud dressing for sky islands, and later music/spawns/rules.
 * Bounds are world units, axis-aligned.
 */
export const RegionSchema = z
  .object({
    id: z.string().regex(CONTENT_ID),
    name: z.string().min(1).max(64),
    kind: z.enum(["island", "sky", "zone"]),
    bounds: z.object({ x0: finite, z0: finite, x1: finite, z1: finite }),
    /** Ground altitude of a floating island (set by "Float region"). */
    altitude: finite.optional(),
  })
  .refine((r) => r.bounds.x1 > r.bounds.x0 && r.bounds.z1 > r.bounds.z0, "bounds must have positive size");

/**
 * Map metadata: content/maps/<id>/map.json
 * Terrain starts flat at `baseHeight`; designer edits live in chunk files
 * (content/maps/<id>/chunks/<kx>_<kz>.json). Only authored chunks exist.
 */
export const MapDefSchema = z
  .object({
    id: z.string().regex(CONTENT_ID),
    name: z.string(),
    /** Cell counts. Vertex grid is (cols + 1) x (rows + 1). */
    cols: z.number().int().min(16).max(4096),
    rows: z.number().int().min(16).max(4096),
    cellSize: finite.positive(),
    chunkCells: z.number().int().min(8).max(256).default(64),
    baseHeight: finite.default(2),
    waterLevel: finite.default(0),
    /** Max height delta across a cell before it is auto-flagged unwalkable. */
    maxStep: finite.positive().default(0.9),
    spawn: z.object({ x: finite, z: finite }),
    /** Keys ("kx_kz") of chunk files that exist on disk. */
    chunks: z.array(z.string().regex(CHUNK_KEY)).default([]),
    regions: z.array(RegionSchema).default([]),
  })
  .superRefine((m, ctx) => {
    if (m.cols % m.chunkCells !== 0 || m.rows % m.chunkCells !== 0) {
      ctx.addIssue({ code: "custom", message: "cols and rows must be multiples of chunkCells" });
    }
    const ids = new Set<string>();
    for (const r of m.regions) {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", message: `duplicate region id "${r.id}"` });
      ids.add(r.id);
    }
  });

/**
 * One authored chunk. Binary payloads are base64 (little-endian):
 *   heights: Int16 × (n+1)², quantised by HEIGHT_QUANTUM
 *   paint:   Uint8 × n²  terrain material id per cell (0 = auto)
 *   walk:    Uint8 × n²  0 = auto, 1 = blocked, 2 = forced walkable
 *   holes:   Uint8 × n²  1 = void (no ground). Omitted when the chunk has none.
 */
export const MapChunkSchema = z.object({
  kx: z.number().int().nonnegative(),
  kz: z.number().int().nonnegative(),
  heights: z.string(),
  paint: z.string(),
  walk: z.string(),
  holes: z.string().optional(),
});

/** Body of the dev-only save request. */
export const SaveMapRequestSchema = z.object({
  map: MapDefSchema,
  chunks: z.array(MapChunkSchema),
  /** Chunk keys that are back to pristine and should be deleted. */
  removed: z.array(z.string().regex(CHUNK_KEY)),
});

export type MapDef = z.infer<typeof MapDefSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type MapChunk = z.infer<typeof MapChunkSchema>;
export type SaveMapRequest = z.infer<typeof SaveMapRequestSchema>;
