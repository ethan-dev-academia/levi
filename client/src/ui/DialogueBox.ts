export interface DialogueView {
  /** Changes whenever the line changes (re-render key). */
  key: string;
  speaker: string;
  /** Shown small under the name (NPC title). */
  title: string;
  /** Player lines look a little different. */
  isPlayer: boolean;
  text: string;
  options: Array<{ index: number; text: string }>;
}

export interface DialogueHandlers {
  /** -1 = continue, otherwise the option index. */
  choose(option: number): void;
  end(): void;
}

/**
 * Conversation popup, centred like a sign's note: the speaker, their line,
 * and choices. Click / Space to continue; choices by click or number keys;
 * Esc leaves.
 */
export class DialogueBox {
  private readonly root = document.createElement("div");
  private readonly name = document.createElement("div");
  private readonly title = document.createElement("div");
  private readonly text = document.createElement("div");
  private readonly options = document.createElement("div");
  private readonly hint = document.createElement("div");
  private shown: DialogueView | null = null;
  private held = false;

  constructor(host: HTMLElement, private readonly handlers: DialogueHandlers) {
    this.root.className = "dialogue";
    this.root.hidden = true;
    this.name.className = "dl-name";
    this.title.className = "dl-title";
    this.text.className = "dl-text";
    this.options.className = "dl-options";
    this.hint.className = "dl-hint";
    this.root.append(this.name, this.title, this.text, this.options, this.hint);
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("click", (e) => {
      if (this.held || (e.target as HTMLElement).closest(".dl-opt")) return;
      if (this.shown && this.shown.options.length === 0) this.handlers.choose(-1);
    });
    host.append(this.root);

    // While talking: Space continues, 1-6 pick choices, Esc leaves (before game keys).
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.shown || (e.target instanceof HTMLInputElement) || (e.target instanceof HTMLTextAreaElement)) return;
        const s = this.shown;
        if (this.held) {
          if (e.code === "Space" || e.code === "Escape" || /^Digit[1-6]$/.test(e.code)) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
          return;
        }
        let handled = true;
        if (e.code === "Space" && s.options.length === 0) this.handlers.choose(-1);
        else if (e.code === "Escape") this.handlers.end();
        else if (/^Digit[1-6]$/.test(e.code) && s.options.length > 0) {
          const opt = s.options[Number(e.code.slice(5)) - 1];
          if (opt) this.handlers.choose(opt.index);
        } else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }

  /** Hidden and deaf for a moment (a cutscene the line can't skip); comes back as it was. */
  setHeld(on: boolean): void {
    this.held = on;
    this.root.classList.toggle("held", on);
  }

  get isOpen(): boolean {
    return this.shown !== null;
  }

  show(view: DialogueView): void {
    if (this.shown?.key !== view.key) {
      this.name.textContent = view.speaker;
      this.title.textContent = view.title;
      this.text.textContent = view.text;
      this.options.replaceChildren(
        ...view.options.map((o, i) => {
          const b = document.createElement("button");
          b.className = "dl-opt";
          b.textContent = `${i + 1}. ${o.text}`;
          b.addEventListener("click", () => this.handlers.choose(o.index));
          return b;
        }),
      );
      this.hint.textContent = view.options.length ? "" : "Click to continue ▸";
      this.root.classList.toggle("player", view.isPlayer);
    }
    this.shown = view;
    this.root.hidden = false;
  }

  hide(): void {
    this.shown = null;
    this.root.hidden = true;
  }
}
