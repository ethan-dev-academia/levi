import { z } from "zod";
import { AdventuringSkillSchema } from "./skillTree.js";

/**
 * content/progression/adventuring.json: Adventuring soft caps. Past `level`,
 * until all `quests` are done, each level costs `penalty`× the XP (banked).
 */
export const AdventuringConfigSchema = z.object({
  caps: z
    .array(
      z.object({
        level: z.number().int().min(1).max(49),
        quests: z.array(z.string().regex(/^[a-z0-9_-]+$/)).min(1),
        penalty: z.number().min(1).max(50).default(5),
      }),
    )
    .default([]),
  /** Adventuring's own skills (sprint...), unlocked by Adventuring level. */
  skills: z.array(AdventuringSkillSchema).max(32).default([]),
});
export type AdventuringConfig = z.infer<typeof AdventuringConfigSchema>;

/** content/progression/acts.json: display names for the story Acts. */
export const ActsConfigSchema = z.object({
  acts: z.array(z.object({ act: z.number().int().min(0).max(20), name: z.string().min(1).max(60) })).default([]),
});
