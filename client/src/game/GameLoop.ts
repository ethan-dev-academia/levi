import { TICK_MS } from "@levi/shared";

const MAX_CATCHUP_TICKS = 5;

export interface LoopCallbacks {
  /** Fixed-rate simulation step (TICK_MS). */
  tick(): void;
  /** Per-frame render. alpha ∈ [0,1) = progress between the last two ticks. */
  frame(alpha: number, dtSec: number): void;
}

/** Fixed-timestep sim + variable-rate render. Returns a stop function. */
export function startGameLoop(cb: LoopCallbacks): () => void {
  let last = performance.now();
  let acc = 0;
  let raf = 0;

  const step = (now: number): void => {
    const dt = Math.min(now - last, 250);
    last = now;
    acc += dt;

    let ticks = 0;
    while (acc >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      cb.tick();
      acc -= TICK_MS;
      ticks++;
    }
    if (ticks === MAX_CATCHUP_TICKS) acc = 0; // drop backlog after a stall

    cb.frame(acc / TICK_MS, dt / 1000);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
