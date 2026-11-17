import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ResolvedConfig } from "vite";
import { CONTENT_ID, SaveMapRequestSchema, chunkKey } from "../../shared/src/schemas/map.js";
import { ItemDefSchema } from "../../shared/src/schemas/item.js";
import { NpcDefSchema } from "../../shared/src/schemas/npc.js";
import { QuestDefSchema } from "../../shared/src/schemas/quest.js";
import { EnemyDefSchema } from "../../shared/src/schemas/enemy.js";

/** Content the F2 editor may write, with the schema each file must pass. */
const EDITABLE = {
  npc: { dir: "npcs", schema: NpcDefSchema },
  quest: { dir: "quests", schema: QuestDefSchema },
  enemy: { dir: "enemies", schema: EnemyDefSchema },
} as const;

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Readable but compact: [x, z] tile pairs and each wall stay on one line (diff-friendly). */
function formatBuildings(file: unknown): string {
  return JSON.stringify(file, null, 1)
    .replace(/\[\s+(-?\d+),\s+(-?\d+)\s+\]/g, "[$1,$2]")
    .replace(
      /\{\s+("x": -?\d+),\s+("z": -?\d+),\s+("axis": "[xz]"),\s+("kind": "\w+")(,\s+"material": "\w+")?\s+\}/g,
      (_m, x: string, z: string, axis: string, kind: string, mat?: string) =>
        `{${x}, ${z}, ${axis}, ${kind}${mat ? `, ${mat.replace(/^,\s+/, "")}` : ""}}`,
    );
}
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Serves /content/** during dev, and exposes the DEV-ONLY save endpoint the
 * F1 tools use to write maps into the repo. Neither exists in a production
 * build: the endpoint lives in `configureServer`, which only runs under
 * `vite serve`, and only accepts loopback connections.
 */
export function contentPlugin(contentRoot: string): Plugin {
  let config: ResolvedConfig;
  const root = path.resolve(contentRoot);

  const inside = (p: string): boolean => {
    const rel = path.relative(root, p);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  async function serveContent(url: string, res: ServerResponse): Promise<boolean> {
    const rel = decodeURIComponent(url.slice("/content/".length));
    const file = path.resolve(root, rel);
    if (!inside(file) || !file.endsWith(".json")) return false;
    try {
      const body = await fs.readFile(file);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
      return true;
    } catch {
      res.statusCode = 404;
      res.end("not found");
      return true;
    }
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error("body too large");
      parts.push(chunk as Buffer);
    }
    return Buffer.concat(parts).toString("utf8");
  }

  async function writeAtomic(file: string, data: string): Promise<void> {
    if (!inside(file)) throw new Error("path escapes content root");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, file);
  }

  async function saveMap(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return reply(403, { error: "dev tools are local-only" });

    let parsed;
    try {
      parsed = SaveMapRequestSchema.safeParse(JSON.parse(await readBody(req)));
    } catch (e) {
      return reply(400, { error: String(e) });
    }
    if (!parsed.success) return reply(400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });

    const { map, chunks, removed, buildings } = parsed.data;
    if (!CONTENT_ID.test(map.id)) return reply(400, { error: "bad map id" });
    const dir = path.join(root, "maps", map.id);
    const chunkDir = path.join(dir, "chunks");

    for (const c of chunks) {
      await writeAtomic(path.join(chunkDir, `${chunkKey(c.kx, c.kz)}.json`), JSON.stringify(c));
    }
    for (const key of removed) {
      const f = path.join(chunkDir, `${key}.json`);
      if (inside(f)) await fs.rm(f, { force: true });
    }
    if (buildings) await writeAtomic(path.join(dir, "buildings.json"), `${formatBuildings(buildings)}\n`);
    await writeAtomic(path.join(dir, "map.json"), `${JSON.stringify(map, null, 2)}\n`);
    reply(200, { ok: true, written: chunks.length, removed: removed.length });
  }

  /** Item manager (F1): write or delete one content/items/<id>.json. */
  async function editItem(req: IncomingMessage, res: ServerResponse, remove: boolean): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return reply(403, { error: "dev tools are local-only" });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return reply(400, { error: String(e) });
    }
    if (remove) {
      const id = (body as { id?: unknown }).id;
      if (typeof id !== "string" || !CONTENT_ID.test(id)) return reply(400, { error: "bad item id" });
      const f = path.join(root, "items", `${id}.json`);
      if (!inside(f)) return reply(400, { error: "bad path" });
      await fs.rm(f, { force: true });
      return reply(200, { ok: true });
    }
    const parsed = ItemDefSchema.safeParse((body as { item?: unknown }).item);
    if (!parsed.success) return reply(400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    await writeAtomic(path.join(root, "items", `${parsed.data.id}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`);
    reply(200, { ok: true });
  }

  /** F2 editor: save or delete one NPC / quest file (validated). */
  async function editContent(req: IncomingMessage, res: ServerResponse, remove: boolean): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return reply(403, { error: "dev tools are local-only" });
    let body: { kind?: unknown; id?: unknown; data?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (e) {
      return reply(400, { error: String(e) });
    }
    const kind = body.kind === "npc" || body.kind === "quest" || body.kind === "enemy" ? EDITABLE[body.kind] : null;
    if (!kind) return reply(400, { error: "bad kind" });
    if (remove) {
      if (typeof body.id !== "string" || !CONTENT_ID.test(body.id)) return reply(400, { error: "bad id" });
      const f = path.join(root, kind.dir, `${body.id}.json`);
      if (!inside(f)) return reply(400, { error: "bad path" });
      await fs.rm(f, { force: true });
      return reply(200, { ok: true });
    }
    const parsed = kind.schema.safeParse(body.data);
    if (!parsed.success) return reply(400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    await writeAtomic(path.join(root, kind.dir, `${parsed.data.id}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`);
    reply(200, { ok: true });
  }

  /** Item manager groups: editor-only organisation, never shipped. */
  async function saveItemGroups(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return reply(403, { error: "dev tools are local-only" });
    let body: { groups?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { groups?: unknown };
    } catch (e) {
      return reply(400, { error: String(e) });
    }
    const groups = Array.isArray(body.groups) ? body.groups : null;
    const valid =
      groups &&
      groups.length <= 500 &&
      groups.every(
        (g: { id?: unknown; name?: unknown; items?: unknown }) =>
          typeof g.id === "string" && CONTENT_ID.test(g.id) &&
          typeof g.name === "string" && g.name.length <= 40 &&
          Array.isArray(g.items) && g.items.length <= 5000 && g.items.every((i) => typeof i === "string" && CONTENT_ID.test(i)),
      );
    if (!valid) return reply(400, { error: "bad groups" });
    await writeAtomic(path.join(root, "dev", "item-groups.json"), `${JSON.stringify({ groups }, null, 1)}\n`);
    reply(200, { ok: true });
  }

  return {
    name: "levi-content",
    configResolved(c) {
      config = c;
    },
    // The F1/F2 editors rewrite items, NPCs and quests and update the running
    // game themselves; don't let Vite reload the page (and lose editor state).
    handleHotUpdate(ctx) {
      const rel = path.relative(root, ctx.file);
      const editorOwned = ["items", "dev", "npcs", "quests", "enemies"].some((d) => rel.startsWith(`${d}${path.sep}`));
      if (!rel.startsWith("..") && editorOwned) return [];
      return undefined;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (req.method === "GET" && url.startsWith("/content/")) {
          serveContent(url, res).then((handled) => !handled && next(), next);
          return;
        }
        if (req.method === "POST" && (url === "/__dev/save-content" || url === "/__dev/delete-content")) {
          editContent(req, res, url === "/__dev/delete-content").catch((e: unknown) => {
            res.statusCode = 500;
            res.end(String(e));
          });
          return;
        }
        if (req.method === "POST" && url === "/__dev/save-item-groups") {
          saveItemGroups(req, res).catch((e: unknown) => {
            res.statusCode = 500;
            res.end(String(e));
          });
          return;
        }
        if (req.method === "POST" && (url === "/__dev/save-item" || url === "/__dev/delete-item")) {
          editItem(req, res, url === "/__dev/delete-item").catch((e: unknown) => {
            res.statusCode = 500;
            res.end(String(e));
          });
          return;
        }
        if (req.method === "POST" && url === "/__dev/save-map") {
          saveMap(req, res).catch((e: unknown) => {
            res.statusCode = 500;
            res.end(String(e));
          });
          return;
        }
        next();
      });
    },
    async closeBundle() {
      if (config.command !== "build") return;
      // Ship map data next to the bundle. (Step 2: the game server serves this.)
      await fs.cp(path.join(root, "maps"), path.resolve(config.root, config.build.outDir, "content", "maps"), {
        recursive: true,
        filter: (src) => !src.endsWith(".tmp") && !src.endsWith(".gitkeep"),
      });
    },
  };
}
