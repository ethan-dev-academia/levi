import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ResolvedConfig } from "vite";
import { CONTENT_ID, SaveMapRequestSchema, chunkKey } from "../../shared/src/schemas/map.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
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

    const { map, chunks, removed } = parsed.data;
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
    await writeAtomic(path.join(dir, "map.json"), `${JSON.stringify(map, null, 2)}\n`);
    reply(200, { ok: true, written: chunks.length, removed: removed.length });
  }

  return {
    name: "levi-content",
    configResolved(c) {
      config = c;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (req.method === "GET" && url.startsWith("/content/")) {
          serveContent(url, res).then((handled) => !handled && next(), next);
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
