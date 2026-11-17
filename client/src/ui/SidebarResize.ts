const KEY = "levi.sidebarWidth";
const MIN = 340;
const DEFAULT = 520;

/** Largest the sidebar may get: keep at least ~45% of the window for the game. */
function maxWidth(): number {
  return Math.max(MIN, Math.min(820, Math.round(window.innerWidth * 0.55)));
}

/**
 * Drag the sidebar's left edge to resize it. The width is a CSS variable
 * (--side-w) on <html>, remembered per browser.
 */
export function mountSidebarResize(side: HTMLElement): void {
  const root = document.documentElement;
  const apply = (w: number): number => {
    const clamped = Math.round(Math.max(MIN, Math.min(maxWidth(), w)));
    root.style.setProperty("--side-w", `${clamped}px`);
    return clamped;
  };
  let width = DEFAULT;
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved > 0) width = saved;
  } catch {
    // Storage unavailable: use the default.
  }
  width = apply(width);

  const handle = document.createElement("div");
  handle.className = "side-resize";
  handle.title = "Drag to resize";
  side.append(handle);

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("active");
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent): void => {
      width = apply(startW + (startX - ev.clientX));
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("active");
      try {
        localStorage.setItem(KEY, String(width));
      } catch {
        // ignore
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  });
  handle.addEventListener("dblclick", () => {
    width = apply(DEFAULT);
    try {
      localStorage.setItem(KEY, String(width));
    } catch {
      // ignore
    }
  });
  window.addEventListener("resize", () => (width = apply(width)));
}
