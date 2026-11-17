import {
  ActsConfigSchema,
  AdventuringConfigSchema,
  NpcDefSchema,
  EnemyDefSchema,
  type EnemyDef,
  type AdventureCap,
  type NpcDef,
  ItemDefSchema,
  ModelDefSchema,
  PropDefSchema,
  QuestDefSchema,
  SkillTreeSchema,
  SpriteDefSchema,
  type CombatStyle,
  type ItemDef,
  type ModelDef,
  type PropDef,
  type QuestDef,
  type SkillTree,
  type SpriteDef,
} from "@levi/shared";
import type { z } from "zod";

/**
 * Small content (sprites, models, later items/NPCs/quests) is bundled: every
 * JSON file under its folder is picked up automatically and schema-validated.
 * Maps are large and streamed at runtime instead (see mapLoader.ts).
 */
const spriteFiles = import.meta.glob<unknown>("../../../content/sprites/*.json", { eager: true, import: "default" });
const modelFiles = import.meta.glob<unknown>("../../../content/models/*.json", { eager: true, import: "default" });
const propFiles = import.meta.glob<unknown>("../../../content/props/*.json", { eager: true, import: "default" });
const itemFiles = import.meta.glob<unknown>("../../../content/items/*.json", { eager: true, import: "default" });
const skillFiles = import.meta.glob<unknown>("../../../content/skills/*.json", { eager: true, import: "default" });
const questFiles = import.meta.glob<unknown>("../../../content/quests/*.json", { eager: true, import: "default" });
const npcFiles = import.meta.glob<unknown>("../../../content/npcs/*.json", { eager: true, import: "default" });
const enemyFiles = import.meta.glob<unknown>("../../../content/enemies/*.json", { eager: true, import: "default" });
const progressionFiles = import.meta.glob<unknown>("../../../content/progression/*.json", { eager: true, import: "default" });

function loadAll<T extends { id: string }>(
  kind: string,
  files: Record<string, unknown>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): ReadonlyMap<string, T> {
  const out = new Map<string, T>();
  for (const [path, raw] of Object.entries(files)) {
    const r = schema.safeParse(raw);
    if (!r.success) {
      throw new Error(`[content] invalid ${kind} ${path}:\n${r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    }
    if (out.has(r.data.id)) throw new Error(`[content] duplicate ${kind} id "${r.data.id}" in ${path}`);
    out.set(r.data.id, r.data);
  }
  return out;
}

export interface ContentRegistry {
  sprites: ReadonlyMap<string, SpriteDef>;
  models: ReadonlyMap<string, ModelDef>;
  props: ReadonlyMap<string, PropDef>;
  items: ReadonlyMap<string, ItemDef>;
  trees: ReadonlyMap<CombatStyle, SkillTree>;
  quests: ReadonlyMap<string, QuestDef>;
  npcs: ReadonlyMap<string, NpcDef>;
  enemies: ReadonlyMap<string, EnemyDef>;
  adventureCaps: readonly AdventureCap[];
  /** Act number → name ("Falcon's Landing"). */
  actNames: ReadonlyMap<number, string>;
}

function loadActNames(): Map<number, string> {
  const raw = Object.entries(progressionFiles).find(([p]) => p.endsWith("/acts.json"))?.[1];
  const r = raw ? ActsConfigSchema.safeParse(raw) : null;
  return new Map((r?.success ? r.data.acts : []).map((a) => [a.act, a.name]));
}

/** Adventuring soft caps (content/progression/adventuring.json). */
function loadAdventureCaps(): AdventureCap[] {
  const raw = Object.entries(progressionFiles).find(([p]) => p.endsWith("/adventuring.json"))?.[1];
  if (!raw) return [];
  const r = AdventuringConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`[content] invalid adventuring.json: ${r.error.issues.map((i) => i.message).join("; ")}`);
  return r.data.caps;
}

/** One skill tree per combat style, keyed by style. */
function loadTrees(): ReadonlyMap<CombatStyle, SkillTree> {
  const out = new Map<CombatStyle, SkillTree>();
  for (const [path, raw] of Object.entries(skillFiles)) {
    const r = SkillTreeSchema.safeParse(raw);
    if (!r.success) {
      const issues = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`[content] invalid skill tree ${path}:\n${issues}`);
    }
    if (out.has(r.data.style)) throw new Error(`[content] two skill trees for "${r.data.style}" (${path})`);
    out.set(r.data.style, r.data);
  }
  return out;
}

export function loadContent(): ContentRegistry {
  const reg = {
    sprites: loadAll("sprite", spriteFiles, SpriteDefSchema),
    models: loadAll("model", modelFiles, ModelDefSchema),
    props: loadAll("prop", propFiles, PropDefSchema),
    items: loadAll("item", itemFiles, ItemDefSchema),
    trees: loadTrees(),
    quests: loadAll("quest", questFiles, QuestDefSchema),
    npcs: loadAll("npc", npcFiles, NpcDefSchema),
    enemies: loadAll("enemy", enemyFiles, EnemyDefSchema),
    adventureCaps: loadAdventureCaps(),
    actNames: loadActNames(),
  };
  for (const p of reg.props.values()) {
    if (!reg.models.has(p.model)) throw new Error(`[content] prop "${p.id}" uses unknown model "${p.model}"`);
  }
  return reg;
}

export function getOrThrow<T>(registry: ReadonlyMap<string, T>, id: string, kind: string): T {
  const v = registry.get(id);
  if (!v) throw new Error(`[content] missing ${kind} "${id}"`);
  return v;
}
