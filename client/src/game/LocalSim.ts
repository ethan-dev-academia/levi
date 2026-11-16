import {
  advanceAlongPath,
  findPath,
  PLAYER_MOVE_SPEED,
  TICK_SEC,
  type Intent,
  type Mover,
  type Vec2,
  type WalkGrid,
} from "@levi/shared";

export interface PlayerState extends Mover {
  /** Position at the previous tick, for render interpolation. */
  prevX: number;
  prevZ: number;
}

export interface SimEvents {
  message(text: string): void;
}

/**
 * Offline stand-in for the server's simulation. Consumes the SAME validated
 * intents and runs the SAME shared movement/pathing code at TICK_RATE.
 * Step 2 moves this logic into the Colyseus room and the client switches to
 * rendering interpolated server snapshots.
 */
export class LocalSim {
  readonly player: PlayerState;

  constructor(
    private readonly grid: WalkGrid,
    spawn: Vec2,
    private readonly events: SimEvents,
  ) {
    this.player = { x: spawn.x, z: spawn.z, prevX: spawn.x, prevZ: spawn.z, path: [], dirX: 0, dirZ: 1 };
  }

  apply(intent: Intent): void {
    switch (intent.type) {
      case "move": {
        const path = findPath(this.grid, this.player, { x: intent.targetX, z: intent.targetZ });
        if (path.length === 0) this.events.message("I can't reach that!");
        this.player.path = path;
        break;
      }
      case "stop":
        this.player.path = [];
        break;
      case "cast":
        this.events.message(`You haven't learned an ability for ${intent.slot} yet.`);
        break;
      case "useItem":
        this.events.message(`There's nothing in item slot ${intent.slot}.`);
        break;
    }
  }

  /** Dev-only helper (the real server exposes this as an admin command). */
  teleport(x: number, z: number): void {
    const p = this.player;
    p.x = p.prevX = x;
    p.z = p.prevZ = z;
    p.path = [];
  }

  tick(): void {
    const p = this.player;
    p.prevX = p.x;
    p.prevZ = p.z;
    advanceAlongPath(p, PLAYER_MOVE_SPEED * TICK_SEC);
  }

  /** Remaining waypoints' final point, if moving. */
  destination(): Vec2 | null {
    return this.player.path[this.player.path.length - 1] ?? null;
  }
}
