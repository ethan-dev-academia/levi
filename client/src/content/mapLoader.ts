import { BuildingsFileSchema, MapChunkSchema, MapDefSchema, loadMapData, type MapChunk, type MapData } from "@levi/shared";

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Fetch a designed map: metadata + every authored chunk + buildings, schema-validated. */
export async function loadMap(id: string, onProgress?: (fraction: number) => void): Promise<MapData> {
  const base = `/content/maps/${encodeURIComponent(id)}`;
  const def = MapDefSchema.parse(await fetchJson(`${base}/map.json`));
  let got = 0;
  const chunks: MapChunk[] = await Promise.all(
    def.chunks.map(async (key) => {
      const c = MapChunkSchema.parse(await fetchJson(`${base}/chunks/${key}.json`));
      onProgress?.(++got / def.chunks.length);
      return c;
    }),
  );
  const buildings = BuildingsFileSchema.parse(await fetchJson(`${base}/buildings.json`));
  const data = loadMapData(def, chunks, buildings.buildings, buildings.props, buildings.npcs, buildings.groundItems, buildings.enemies);
  data.buildings.setZones(buildings.zones);
  return data;
}
