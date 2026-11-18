export type AnnounceKind = "start" | "complete" | "level";

interface Queued {
  kind: AnnounceKind;
  title: string;
  detail: string;
}

const HEADINGS: Record<AnnounceKind, string> = { start: "New Quest", complete: "Quest Complete", level: "Level Up" };
const SHOW_SECONDS = 3.4;

/**
 * Big centred moments: quest started / completed, levels gained (queued so
 * they never stack), and the title card when you enter a region.
 */
export class Announcer {
  private readonly banner: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly region: HTMLElement;
  private readonly regionName: HTMLElement;
  private readonly regionSub: HTMLElement;
  private readonly queue: Queued[] = [];
  private showing = 0;
  private regionLeft = 0;

  constructor(host: HTMLElement) {
    this.banner = document.createElement("div");
    this.banner.className = "announce";
    this.heading = document.createElement("small");
    this.title = document.createElement("b");
    this.detail = document.createElement("span");
    this.banner.append(this.heading, this.title, this.detail);
    this.region = document.createElement("div");
    this.region.className = "region-title";
    this.regionName = document.createElement("b");
    this.regionSub = document.createElement("span");
    const rule = document.createElement("i");
    this.region.append(this.regionName, rule, this.regionSub);
    host.append(this.banner, this.region);
  }

  announce(kind: AnnounceKind, title: string, detail: string): void {
    // Two level-ups at once read as one line each; drop exact repeats.
    if (this.queue.some((q) => q.kind === kind && q.title === title)) return;
    this.queue.push({ kind, title, detail });
  }

  /** "Falcon's Landing" / "Where the Benefactor's heroes first set foot". */
  regionTitle(name: string, subtitle: string, minor = false): void {
    this.region.classList.toggle("minor", minor);
    this.regionName.textContent = name;
    this.regionSub.textContent = subtitle;
    this.regionSub.hidden = !subtitle;
    this.region.classList.remove("show");
    void this.region.offsetWidth; // restart the animation
    this.region.classList.add("show");
    this.regionLeft = 4.5;
  }

  update(dt: number): void {
    if (this.regionLeft > 0) {
      this.regionLeft -= dt;
      if (this.regionLeft <= 0) this.region.classList.remove("show");
    }
    if (this.showing > 0) {
      this.showing -= dt;
      if (this.showing < 0.5) this.banner.classList.remove("show");
      if (this.showing > 0) return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.banner.dataset["kind"] = next.kind;
    this.heading.textContent = HEADINGS[next.kind];
    this.title.textContent = next.title;
    this.detail.textContent = next.detail;
    this.detail.hidden = !next.detail;
    this.banner.classList.remove("show");
    void this.banner.offsetWidth;
    this.banner.classList.add("show");
    this.showing = SHOW_SECONDS;
  }
}
