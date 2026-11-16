export interface Ndc {
  x: number;
  y: number;
}

export interface PointerHandlers {
  /**
   * Right mouse: fired on press, then repeatedly while held and the cursor
   * moves (LoL-style steering). `initial` is true for the press itself.
   */
  onMoveCommand(ndc: Ndc, initial: boolean): void;
  /** Middle-drag, in pixels. */
  onOrbit(dxPx: number, dyPx: number): void;
  onZoom(wheelDeltaY: number): void;
}

const BUTTON_MIDDLE = 1;
const BUTTON_RIGHT = 2;
/** Min ms between repeated move commands while right mouse is held. */
const HOLD_REPEAT_MS = 125;

/** Right = move (hold to steer) · Middle-drag = orbit · Wheel = zoom. */
export class PointerInput {
  /** Last pointer position over the viewport, for aiming QWER. */
  readonly lastNdc: Ndc = { x: 0, y: 0 };
  private rightHeld = false;
  private orbiting = false;
  private lastRepeat = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly el: HTMLElement,
    private readonly handlers: PointerHandlers,
  ) {
    const opts = { signal: this.abort.signal };
    el.addEventListener("contextmenu", (e) => e.preventDefault(), opts);
    el.addEventListener("pointerdown", (e) => this.down(e), opts);
    el.addEventListener("pointermove", (e) => this.move(e), opts);
    el.addEventListener("pointerup", (e) => this.up(e), opts);
    el.addEventListener("pointercancel", () => this.reset(), opts);
    el.addEventListener("lostpointercapture", () => this.reset(), opts);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.handlers.onZoom(e.deltaY);
      },
      { signal: this.abort.signal, passive: false },
    );
  }

  private toNdc(e: PointerEvent): Ndc {
    const r = this.el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  }

  private trackNdc(e: PointerEvent): void {
    const n = this.toNdc(e);
    this.lastNdc.x = n.x;
    this.lastNdc.y = n.y;
  }

  private down(e: PointerEvent): void {
    this.trackNdc(e);
    if (e.button === BUTTON_RIGHT) {
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      this.rightHeld = true;
      this.lastRepeat = performance.now();
      this.handlers.onMoveCommand({ ...this.lastNdc }, true);
    } else if (e.button === BUTTON_MIDDLE) {
      e.preventDefault(); // suppress browser autoscroll
      this.el.setPointerCapture(e.pointerId);
      this.orbiting = true;
    }
  }

  private move(e: PointerEvent): void {
    this.trackNdc(e);
    if (this.orbiting) this.handlers.onOrbit(e.movementX, e.movementY);
    if (this.rightHeld) {
      const now = performance.now();
      if (now - this.lastRepeat >= HOLD_REPEAT_MS) {
        this.lastRepeat = now;
        this.handlers.onMoveCommand({ ...this.lastNdc }, false);
      }
    }
  }

  private up(e: PointerEvent): void {
    if (e.button === BUTTON_RIGHT) this.rightHeld = false;
    if (e.button === BUTTON_MIDDLE) this.orbiting = false;
    if (!this.rightHeld && !this.orbiting && this.el.hasPointerCapture(e.pointerId)) {
      this.el.releasePointerCapture(e.pointerId);
    }
  }

  private reset(): void {
    this.rightHeld = false;
    this.orbiting = false;
  }

  dispose(): void {
    this.abort.abort();
  }
}
