/**
 * Paintable terrain materials. Ids are persisted in chunk files: never
 * renumber, only append. Id 0 = "auto" (derived from height/slope).
 */
export interface TerrainMaterialDef {
  id: number;
  key: string;
  name: string;
  color: string;
}

export const TERRAIN_MATERIALS: readonly TerrainMaterialDef[] = [
  { id: 0, key: "auto", name: "Auto", color: "#67983f" },
  { id: 1, key: "grass", name: "Grass", color: "#67983f" },
  { id: 2, key: "lush", name: "Lush grass", color: "#4f8636" },
  { id: 3, key: "dry", name: "Dry grass", color: "#93a64a" },
  { id: 4, key: "dirt", name: "Dirt", color: "#8a7048" },
  { id: 5, key: "path", name: "Path", color: "#a89272" },
  { id: 6, key: "sand", name: "Sand", color: "#cdb87f" },
  { id: 7, key: "rock", name: "Rock", color: "#7d746a" },
  { id: 8, key: "snow", name: "Snow", color: "#e9eef0" },
  { id: 9, key: "mud", name: "Mud", color: "#5c4a35" },
  { id: 10, key: "cobble", name: "Cobblestone", color: "#8f8a84" },
];
