import { z } from "zod";

const n = z.number().finite();
const vec3 = z.tuple([n, n, n]);

/** Animation roles the built-in procedural animator understands. */
export const PART_ROLES = [
  "torso", "head",
  "armL", "armR", "forearmL", "forearmR",
  "legL", "legR", "shinL", "shinR",
] as const;
export type PartRole = (typeof PART_ROLES)[number];

/** One cross-section of a facet: [y, radiusX, radiusZ] relative to the joint. */
export const FacetRingSchema = z.tuple([n, n.nonnegative(), n.nonnegative()]);

/**
 * The ONE primitive every model is built from: a faceted lathe.
 * `sides` points per ring; consecutive rings are rotated half a step
 * (antiprism), so every face is a triangle. Radius 0 = a point.
 *
 *   sides 3–4 → shards / spikes      sides 5–7 → limbs, torso, head
 */
export const ModelPartSchema = z.object({
  id: z.string().min(1),
  parent: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sides: z.number().int().min(3).max(16).default(6),
  /** Bottom → top. At least two rings. */
  rings: z.array(FacetRingSchema).min(2),
  /** Joint position relative to the parent joint (or model origin at the feet). */
  pos: vec3.default([0, 0, 0]),
  /** Shift of the geometry away from its joint. */
  offset: vec3.default([0, 0, 0]),
  /** Euler degrees, XYZ order. */
  rot: vec3.default([0, 0, 0]),
  role: z.enum(PART_ROLES).optional(),
});

/** Low-poly model: a tree of facet parts. Facing = +Z. */
export const ModelDefSchema = z
  .object({
    id: z.string().min(1),
    scale: z.number().positive().default(1),
    parts: z.array(ModelPartSchema).min(1),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const p of m.parts) {
      if (seen.has(p.id)) ctx.addIssue({ code: "custom", message: `duplicate part id "${p.id}"` });
      if (p.parent && !seen.has(p.parent)) {
        ctx.addIssue({ code: "custom", message: `part "${p.id}": parent "${p.parent}" must be declared earlier` });
      }
      seen.add(p.id);
    }
  });

export type FacetRing = z.infer<typeof FacetRingSchema>;
export type ModelPart = z.infer<typeof ModelPartSchema>;
export type ModelDef = z.infer<typeof ModelDefSchema>;
