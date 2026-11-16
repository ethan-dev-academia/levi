import { z } from "zod";

const finite = z.number().finite();

export const CONTENT_ID = /^[a-z0-9_-]+$/;
export const CHUNK_KEY = /^\d+_\d+$/;

export const chunkKey = (kx: number, kz: number): string => `${kx}_${kz}`;

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
  })
  .superRefine((m, ctx) => {
    if (m.cols % m.chunkCells !== 0 || m.rows % m.chunkCells !== 0) {
      ctx.addIssue({ code: "custom", message: "cols and rows must be multiples of chunkCells" });
    }
  });

/**
 * One authored chunk. Binary payloads are base64 (little-endian):
 *   heights: Int16 × (n+1)², quantised by HEIGHT_QUANTUM
 *   paint:   Uint8 × n²  terrain material id per cell (0 = auto)
 *   walk:    Uint8 × n²  0 = auto, 1 = blocked, 2 = forced walkable
 */
export const MapChunkSchema = z.object({
  kx: z.number().int().nonnegative(),
  kz: z.number().int().nonnegative(),
  heights: z.string(),
  paint: z.string(),
  walk: z.string(),
});

/** Body of the dev-only save request. */
export const SaveMapRequestSchema = z.object({
  map: MapDefSchema,
  chunks: z.array(MapChunkSchema),
  /** Chunk keys that are back to pristine and should be deleted. */
  removed: z.array(z.string().regex(CHUNK_KEY)),
});

export type MapDef = z.infer<typeof MapDefSchema>;
export type MapChunk = z.infer<typeof MapChunkSchema>;
export type SaveMapRequest = z.infer<typeof SaveMapRequestSchema>;
