export type KeyAction = () => void;

/**
 * Edge-triggered bindings (by KeyboardEvent.code) + held-key queries.
 * Ignored while a text field has focus so chat doesn't cast spells.
 */
export class Keyboard {
  private readonly held = new Set<string>();
  private readonly bindings = new Map<string, KeyAction>();
  private readonly releases = new Map<string, KeyAction>();
  private readonly abort = new AbortController();
  private filter: ((code: string) => boolean) | null = null;

  constructor(target: Window = window) {
    const opts = { signal: this.abort.signal };
    target.addEventListener("keydown", (e) => this.down(e), opts);
    target.addEventListener("keyup", (e) => this.up(e), opts);
    target.addEventListener("blur", () => this.held.clear(), opts);
  }

  bind(code: string, action: KeyAction): this {
    this.bindings.set(code, action);
    return this;
  }

  /** Fires when a key bound with bind() is released (hold-and-release casting). */
  bindRelease(code: string, action: KeyAction): this {
    this.releases.set(code, action);
    return this;
  }

  private up(e: KeyboardEvent): void {
    const wasDown = this.held.delete(e.code);
    if (!wasDown) return;
    if (this.filter && !this.filter(e.code)) return;
    this.releases.get(e.code)?.();
  }

  /**
   * While set, only bindings whose code passes the filter fire. Held-key
   * state is still tracked (e.g. the dev free camera reads WASD itself).
   */
  setBindingFilter(filter: ((code: string) => boolean) | null): void {
    this.filter = filter;
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** -1 / 0 / +1 from a pair of held keys. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  private down(e: KeyboardEvent): void {
    if (e.code === "F1") e.preventDefault(); // reserved for the dev panel
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    this.held.add(e.code);
    // Modifier combos (Ctrl+S, Ctrl+Z…) belong to tools, never to gameplay binds.
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.filter && !this.filter(e.code)) return;
    const action = this.bindings.get(e.code);
    if (action) {
      e.preventDefault();
      action();
    }
  }

  dispose(): void {
    this.abort.abort();
    this.held.clear();
  }
}
