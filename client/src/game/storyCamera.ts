import { lerp, type StoryEncounter } from "@levi/shared";
import type { CameraShot } from "../camera/OrbitCamera.js";

type GroundAt = (x: number, z: number) => number;

export interface StoryFrame {
  shot: CameraShot;
  focus: { x: number; y: number; z: number };
}

/** Yaw that puts the camera at `from`'s side, looking toward `to`. */
const yawFrom = (from: { x: number; z: number }, to: { x: number; z: number }): number => Math.atan2(from.x - to.x, from.z - to.z);

/**
 * The cutscene director: where the camera looks during each beat of a story
 * encounter. Null = the player's normal camera.
 */
export function storyCamera(enc: StoryEncounter | null, alpha: number, player: { x: number; z: number }, groundAt: GroundAt, playerLift: number): StoryFrame | null {
  if (!enc?.phase) return null;
  const d = enc.def;
  const t = enc.t;
  const b = { x: lerp(enc.bossActor.prevX, enc.bossActor.x, alpha), z: lerp(enc.bossActor.prevZ, enc.bossActor.z, alpha) };
  const f = { x: lerp(enc.falcon.prevX, enc.falcon.x, alpha), z: lerp(enc.falcon.prevZ, enc.falcon.z, alpha) };
  const at = (p: { x: number; z: number }, up: number): { x: number; y: number; z: number } => ({ x: p.x, y: groundAt(p.x, p.z) + up, z: p.z });
  const mid = (a: { x: number; z: number }, c: { x: number; z: number }, k = 0.5): { x: number; z: number } => ({ x: lerp(a.x, c.x, k), z: lerp(a.z, c.z, k) });

  switch (enc.phase) {
    case "crash":
      if (t < 1.9) {
        // Something falls out of the sky: look up toward it.
        return { shot: { yaw: Math.atan2(-18, 26), pitch: 0.16, distance: 15, rate: 2 }, focus: at(mid(player, d.impact, 0.6), 4.5) };
      }
      if (t < 2.9) {
        // Her: from just behind you.
        return { shot: { yaw: yawFrom(player, d.impact), pitch: 0.2, distance: 7.5, rate: 5 }, focus: at(d.impact, 1.3) };
      }
      if (t < 4.7) {
        // Thrown off the mountain: follow the fall from the side.
        const p = at(player, 1.2 + playerLift);
        return { shot: { yaw: 0.35, pitch: 0.32, distance: 21, rate: 4 }, focus: p };
      }
      if (t < 7.2) {
        // The rockfall builds the arena.
        return { shot: { yaw: Math.atan2(-0.55, 0.85), pitch: 0.82, distance: 33, rate: 1.6 }, focus: at(d.arena, 2) };
      }
      // She drifts down after you.
      return { shot: { yaw: yawFrom(player, b), pitch: 0.28, distance: 12, rate: 2.2 }, focus: { ...at(mid(b, player, 0.3), 2.2) } };
    case "fight":
      // Pulled up and back so you can read the bullets; you still turn the camera yourself.
      // Framed a little toward her so her volleys come from on screen.
      return { shot: { yaw: null, pitch: 0.98, distance: 23, rate: 3 }, focus: at(mid(player, b, 0.3), 1.2) };
    case "rescue": {
      const side = yawFrom(player, b) + Math.PI / 2;
      return { shot: { yaw: side, pitch: 0.4, distance: 13, rate: 2.5 }, focus: at(mid(player, b, 0.5), 1.4) };
    }
    case "farewell":
      if (t < 7) return { shot: { yaw: yawFrom(f, player) + 0.7, pitch: 0.3, distance: 7, rate: 1.8 }, focus: at(mid(player, f), 1) };
      return { shot: { yaw: yawFrom(f, player) + 0.9, pitch: 0.55, distance: 12, rate: 1.5 }, focus: at(player, 2) };
  }
}
