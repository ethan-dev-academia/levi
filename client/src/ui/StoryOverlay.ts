
const BARK_LIFE = 5.5; // seconds on screen once fully typed (plus a little per word)
const MAX_BARKS = 2;
/** Characters per second as a line types itself out. */
const TYPE_SPEED = 48;

interface Shown {
  el: HTMLElement;
  left: number;
  /** The typed part and the not-yet-typed part (kept invisible so the line never reflows). */
  typed: HTMLElement;
  rest: HTMLElement;
  text: string;
  chars: number;
}

/**
 * Story presentation over the game view: subtitles centred low on the screen
 * (speaker above, the line typing itself out, no box), one at a time, cinematic bars during cutscenes, a boss health
 * bar, a white flash and a red flicker when you're hit.
 */
export class StoryOverlay {
  private readonly feed: HTMLElement;
  private readonly top: HTMLElement;
  private readonly bottom: HTMLElement;
  private readonly boss: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly bossName: HTMLElement;
  private readonly bossTitle: HTMLElement;
  private readonly white: HTMLElement;
  private readonly hurt: HTMLElement;
  private readonly barks: Shown[] = [];
  private flash: { t: number; fadeIn: number; hold: number; fadeOut: number } | null = null;
  private hurtT = 0;

  constructor(private readonly host: HTMLElement) {
    const mk = (cls: string): HTMLElement => {
      const d = document.createElement("div");
      d.className = cls;
      host.append(d);
      return d;
    };
    this.top = mk("story-bar top");
    this.bottom = mk("story-bar bottom");
    this.feed = mk("story-feed");
    this.boss = mk("story-boss");
    this.boss.hidden = true;
    this.bossName = document.createElement("b");
    this.bossTitle = document.createElement("span");
    const bar = document.createElement("div");
    bar.className = "story-boss-bar";
    this.bossFill = document.createElement("div");
    bar.append(this.bossFill);
    this.boss.append(this.bossName, this.bossTitle, bar);
    this.white = mk("story-white");
    this.hurt = mk("story-hurt");
  }

  /** `speaker` picks the colour: falcon, alpha, you, voice. */
  bark(speaker: string, name: string, text: string): void {
    // The line before steps aside for the new one.
    for (const b of this.barks) {
      b.left = Math.min(b.left, 0.4);
      b.el.classList.add("out");
    }
    const el = document.createElement("div");
    el.className = `story-bark ${speaker}`;
    const who = document.createElement("b");
    who.textContent = name;
    const line = document.createElement("span");
    const typed = document.createElement("span");
    const rest = document.createElement("span");
    rest.className = "untyped";
    rest.textContent = text;
    line.append(typed, rest);
    el.append(who, line);
    this.feed.append(el);
    const typing = text.length / TYPE_SPEED;
    this.barks.push({ el, typed, rest, text, chars: 0, left: typing + BARK_LIFE + text.split(/\s+/).length * 0.12 });
    while (this.barks.length > MAX_BARKS) this.barks.shift()!.el.remove();
    requestAnimationFrame(() => el.classList.add("in"));
  }

  setCinematic(on: boolean): void {
    this.host.classList.toggle("cinematic", on);
  }

  setBoss(info: { name: string; title: string; fraction: number } | null): void {
    this.boss.hidden = !info;
    if (!info) return;
    this.bossName.textContent = info.name;
    this.bossTitle.textContent = info.title;
    this.bossFill.style.width = `${Math.max(0, Math.min(1, info.fraction)) * 100}%`;
  }

  whiteFlash(fadeIn: number, hold: number, fadeOut: number): void {
    this.flash = { t: 0, fadeIn, hold, fadeOut };
  }

  hit(): void {
    this.hurtT = 0.35;
  }

  update(dt: number): void {
    for (let i = this.barks.length - 1; i >= 0; i--) {
      const b = this.barks[i]!;
      b.left -= dt;
      if (b.chars < b.text.length) {
        b.chars = Math.min(b.text.length, b.chars + dt * TYPE_SPEED);
        const n = Math.floor(b.chars);
        b.typed.textContent = b.text.slice(0, n);
        b.rest.textContent = b.text.slice(n);
      }
      if (b.left < 0.6) b.el.classList.add("out");
      if (b.left <= 0) {
        b.el.remove();
        this.barks.splice(i, 1);
      }
    }
    let w = 0;
    const f = this.flash;
    if (f) {
      f.t += dt;
      if (f.t < f.fadeIn) w = f.t / f.fadeIn;
      else if (f.t < f.fadeIn + f.hold) w = 1;
      else w = Math.max(0, 1 - (f.t - f.fadeIn - f.hold) / f.fadeOut);
      if (f.t > f.fadeIn + f.hold + f.fadeOut) this.flash = null;
    }
    this.white.style.opacity = String(w);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.hurt.style.opacity = String(this.hurtT / 0.35);
  }
}
