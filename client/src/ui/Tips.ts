const KEY = "levi.tips.v1";
const SHOW_SECONDS = 16;

/**
 * One-time tutorial tips: a small card above the action bar that explains
 * the thing you're about to need. Each tip shows once per browser (a viewer
 * convenience, so it lives in localStorage), one at a time.
 */
export class Tips {
  private readonly card: HTMLElement;
  private readonly text: HTMLElement;
  private readonly seen: Set<string>;
  private readonly queue: Array<{ id: string; text: string }> = [];
  private left = 0;
  private current: string | null = null;

  constructor(host: HTMLElement) {
    this.card = document.createElement("div");
    this.card.className = "tip-card";
    const label = document.createElement("small");
    label.textContent = "Tip";
    this.text = document.createElement("span");
    const ok = document.createElement("button");
    ok.textContent = "Got it";
    ok.addEventListener("click", () => this.dismiss());
    this.card.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.card.append(label, this.text, ok);
    host.append(this.card);
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
    } catch {
      seen = [];
    }
    this.seen = new Set(Array.isArray(seen) ? seen : []);
  }

  /** Show a tip unless it's been seen (or is already waiting). */
  offer(id: string, text: string): void {
    if (this.seen.has(id) || this.current === id || this.queue.some((q) => q.id === id)) return;
    this.queue.push({ id, text });
  }

  has(id: string): boolean {
    return this.seen.has(id) || this.current === id || this.queue.some((q) => q.id === id);
  }

  private dismiss(): void {
    this.card.classList.remove("show");
    this.left = 0;
    this.current = null;
  }

  update(dt: number, blocked: boolean): void {
    if (this.current) {
      this.left -= dt;
      if (this.left <= 0) this.dismiss();
      return;
    }
    if (blocked) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next.id;
    this.seen.add(next.id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.seen]));
    } catch {
      // Private mode: tips may show again next time.
    }
    this.text.textContent = next.text;
    this.card.classList.add("show");
    this.left = SHOW_SECONDS;
  }
}
