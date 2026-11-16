import { z } from "zod";

/**
 * Palette-indexed pixel sprite. Each char in `rows` is a palette key;
 * "." is always transparent. Human-diffable in git and trivially recolorable.
 * The in-engine Sprite Painter reads and writes this format.
 */
export const SpriteDefSchema = z
  .object({
    id: z.string().min(1),
    width: z.number().int().min(1).max(128),
    height: z.number().int().min(1).max(128),
    /** World-space height of the billboard in units (width follows aspect). */
    worldHeight: z.number().positive().default(1.6),
    palette: z.record(z.string().length(1), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    rows: z.array(z.string()),
  })
  .superRefine((s, ctx) => {
    if (s.rows.length !== s.height) {
      ctx.addIssue({ code: "custom", message: `rows: expected ${s.height}, got ${s.rows.length}` });
    }
    s.rows.forEach((row, y) => {
      if (row.length !== s.width) {
        ctx.addIssue({ code: "custom", message: `row ${y}: expected width ${s.width}, got ${row.length}` });
      }
      for (const ch of row) {
        if (ch !== "." && !(ch in s.palette)) {
          ctx.addIssue({ code: "custom", message: `row ${y}: unknown palette key "${ch}"` });
          break;
        }
      }
    });
  });

export type SpriteDef = z.infer<typeof SpriteDefSchema>;
