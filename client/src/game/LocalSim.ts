import {
  advanceAlongPath,
  findPath,
  PLAYER_MOVE_SPEED,
  stairLanding,
  TICK_SEC,
  type BuildingIndex,
  type ClimbIntent,
  type Intent,
  type Mover,
  type Vec2,
  type WalkGrid,
} from "@levi/shared";

export interface PlayerState extends Mover {
  /** Position at the previous tick, for render interpolation. */
  prevX: number;
  prevZ: number;
  /** 0 = ground level (terrain + building ground floors). */
  storey: number;
  /** Building the player is inside when storey > 0. */
  building: string | null;
}

export interface SimEvents {
  message(text: string): void;
}

/** Within this distance of a stair's access cell centre counts as "there". */
const CLIMB_REACH = 0.75;

interface PendingClimb {
  building: string;
  storey: number;
  access: Vec2;
  arrive: Vec2;
  verb: string;
}

/**
 * Offline stand-in for the server's simulation. Consumes the SAME validated
 * intents and runs the SAME shared movement/pathing code at TICK_RATE.
 * Step 2 moves this logic into the Colyseus room and the client switches to
 * rendering interpolated server snapshots.
 */
export class LocalSim {
  readonly player: PlayerState;
  private climb: PendingClimb | null = null;

  constructor(
    private readonly ground: WalkGrid,
    private readonly buildings: BuildingIndex,
    spawn: Vec2,
    private readonly events: SimEvents,
  ) {
    this.player = {
      x: spawn.x, z: spawn.z, prevX: spawn.x, prevZ: spawn.z, path: [], dirX: 0, dirZ: 1, storey: 0, building: null,
    };
  }

  /** Walk grid of the storey the player is on. */
  private grid(): WalkGrid {
    const p = this.player;
    if (p.storey === 0 || !p.building) return this.ground;
    return this.buildings.get(p.building)?.grids[p.storey] ?? this.ground;
  }

  apply(intent: Intent): void {
    switch (intent.type) {
      case "move": {
        this.climb = null;
        const path = findPath(this.grid(), this.player, { x: intent.targetX, z: intent.targetZ });
        if (path.length === 0) this.events.message("I can't reach that!");
        this.player.path = path;
        break;
      }
      case "climb":
        this.startClimb(intent);
        break;
      case "stop":
        this.climb = null;
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

  /** Validate a climb, then walk to the stair's access cell (climbs on arrival). */
  private startClimb(intent: ClimbIntent): void {
    const p = this.player;
    const info = this.buildings.get(intent.building);
    const stair = info?.def.stairs.find((s) => s.id === intent.stair);
    if (!info || !stair) return;
    if (p.storey > 0 && p.building !== info.def.id) return;

    const canUp = p.storey >= stair.from && p.storey < stair.to;
    const canDown = p.storey > stair.from && p.storey <= stair.to;
    // The clicked half is a preference; fall back to the only possible way.
    const dir = intent.dir === "up" ? (canUp ? "up" : canDown ? "down" : null) : canDown ? "down" : canUp ? "up" : null;
    if (!dir) {
      this.events.message("You can't climb that from here.");
      return;
    }

    const grid = this.grid();
    const target = p.storey + (dir === "up" ? 1 : -1);
    const targetGrid = target === 0 ? this.ground : info.grids[target];
    const from = stairLanding(grid, stair, dir === "up" ? "bottom" : "top");
    const to = targetGrid ? stairLanding(targetGrid, stair, dir === "up" ? "top" : "bottom") : null;
    if (!from || !to) {
      this.events.message(dir === "up" ? "There's nowhere to stand up there." : "There's nowhere to stand down there.");
      return;
    }
    const access = grid.cellCenter(from[0], from[1]);
    const path = findPath(grid, p, access);
    if (path.length === 0 && Math.hypot(p.x - access.x, p.z - access.z) > CLIMB_REACH) {
      this.events.message("I can't reach that!");
      return;
    }
    p.path = path;
    const thing = stair.kind === "ladder" ? "ladder" : "stairs";
    this.climb = {
      building: info.def.id,
      storey: target,
      access,
      arrive: grid.cellCenter(to[0], to[1]),
      verb: `You climb ${dir} the ${thing}.`,
    };
  }

  /** Dev-only helper (the real server exposes this as an admin command). */
  teleport(x: number, z: number): void {
    const p = this.player;
    p.x = p.prevX = x;
    p.z = p.prevZ = z;
    p.path = [];
    p.storey = 0;
    p.building = null;
    this.climb = null;
  }

  tick(): void {
    const p = this.player;
    p.prevX = p.x;
    p.prevZ = p.z;
    advanceAlongPath(p, PLAYER_MOVE_SPEED * TICK_SEC);

    const c = this.climb;
    if (c && p.path.length === 0) {
      this.climb = null;
      if (Math.hypot(p.x - c.access.x, p.z - c.access.z) <= CLIMB_REACH) {
        p.storey = c.storey;
        p.building = c.storey > 0 ? c.building : null;
        p.x = p.prevX = c.arrive.x;
        p.z = p.prevZ = c.arrive.z;
        this.events.message(c.verb);
      } else {
        this.events.message("I can't reach that!");
      }
    }
  }

  /** Remaining waypoints' final point, if moving. */
  destination(): Vec2 | null {
    return this.player.path[this.player.path.length - 1] ?? null;
  }
}
