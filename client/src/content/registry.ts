import { ModelDefSchema, PropDefSchema, SpriteDefSchema, type ModelDef, type PropDef, type SpriteDef } from "@levi/shared";
import type { z } from "zod";

/**
 * Small content (sprites, models, later items/NPCs/quests) is bundled: every
 * JSON file under its folder is picked up automatically and schema-validated.
 * Maps are large and streamed at runtime instead (see mapLoader.ts).
 */
const spriteFiles = import.meta.glob<unknown>("../../../content/sprites/*.json", { eager: true, import: "default" });
const modelFiles = import.meta.glob<unknown>("../../../content/models/*.json", { eager: true, import: "default" });
const propFiles = import.meta.glob<unknown>("../../../content/props/*.json", { eager: true, import: "default" });

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
}

export function loadContent(): ContentRegistry {
  const reg = {
    sprites: loadAll("sprite", spriteFiles, SpriteDefSchema),
    models: loadAll("model", modelFiles, ModelDefSchema),
    props: loadAll("prop", propFiles, PropDefSchema),
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
