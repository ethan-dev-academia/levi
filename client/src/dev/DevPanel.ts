import { TERRAIN_MATERIALS, WALK_AUTO, WALK_BLOCKED, WALK_FORCED, type WalkOverride } from "@levi/shared";
import type { SculptTool, TerrainSculptor } from "./TerrainSculptor.js";

type Child = Node | string;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
}

const TOOLS: ReadonlyArray<[SculptTool, string]> = [
  ["raise", "Raise"], ["lower", "Lower"], ["smooth", "Smooth"], ["flatten", "Flatten"],
  ["set", "Set"], ["paint", "Paint"], ["walk", "Collision"],
];

const WALK_MODES: ReadonlyArray<[WalkOverride, string]> = [
  [WALK_BLOCKED, "Block"], [WALK_FORCED, "Walkable"], [WALK_AUTO, "Auto"],
];

export interface DevPanelActions {
  undo(): void;
  save(): void;
  setSpawnHere(): void;
  setWaterLevel(level: number): void;
  setShowCollision(show: boolean): void;
  toggleFreeCam(): void;
  setFlySpeed(speed: number): void;
}

/** DOM for the F1 panel. Holds no game state; reads/writes sculptor settings. */
export class DevPanel {
  readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly coords: HTMLElement;
  private readonly toolButtons = new Map<SculptTool, HTMLButtonElement>();
  private readonly contextual: HTMLElement;
  private readonly waterInput: HTMLInputElement;
  private readonly freeCamBtn: HTMLButtonElement;

  constructor(
    host: HTMLElement,
    private readonly sculptor: TerrainSculptor,
    private readonly actions: DevPanelActions,
    waterLevel: number,
    flySpeed: number,
  ) {
    this.freeCamBtn = h("button", { className: "dev-btn", onclick: () => actions.toggleFreeCam() }, "Free camera  (C)");
    const s = sculptor.settings;
    this.status = h("span", { className: "dev-status" }, "Saved");
    this.undoBtn = h("button", { className: "dev-btn", onclick: () => actions.undo() }, "Undo");
    this.coords = h("span", { className: "dev-coords" });
    this.contextual = h("div");

    const toolGrid = h("div", { className: "dev-grid" });
    for (const [tool, label] of TOOLS) {
      const b = h("button", { className: "dev-btn", onclick: () => this.selectTool(tool) }, label);
      this.toolButtons.set(tool, b);
      toolGrid.append(b);
    }

    this.waterInput = h("input", { type: "number", step: "0.25", value: String(waterLevel) });
    this.waterInput.addEventListener("change", () => {
      const v = Number(this.waterInput.value);
      if (Number.isFinite(v)) actions.setWaterLevel(v);
    });

    const collision = h("input", { type: "checkbox" });
    collision.addEventListener("change", () => actions.setShowCollision(collision.checked));

    this.root = h(
      "aside",
      { id: "dev-panel", hidden: true },
      h("header", {}, h("h2", {}, "Dev · Terrain"), this.status),
      toolGrid,
      this.slider("Radius", 1, 40, 1, s.radius, (v) => (s.radius = v)),
      this.slider("Strength", 0.2, 20, 0.1, s.strength, (v) => (s.strength = v)),
      this.contextual,
      h("label", { className: "dev-check" }, collision, "Show collision (red = blocked)"),
      h("h3", {}, "Camera"),
      h("div", { className: "dev-grid cols-2" }, this.freeCamBtn),
      this.slider("Fly speed", 5, 150, 5, flySpeed, (v) => actions.setFlySpeed(v)),
      h("h3", {}, "Map"),
      h("div", { className: "dev-field" }, "Water level", this.waterInput),
      h("div", { className: "dev-field" }, this.coords, h("button", { className: "dev-btn", onclick: () => actions.setSpawnHere() }, "Set spawn here")),
      h("h3", {}, "File"),
      h("div", { className: "dev-grid cols-2" }, this.undoBtn, h("button", { className: "dev-btn primary", onclick: () => actions.save() }, "Save")),
      this.hint(),
    );
    host.appendChild(this.root);
    this.selectTool(s.tool);
    this.refresh();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  setFreeCamActive(active: boolean): void {
    this.freeCamBtn.classList.toggle("active", active);
  }

  setCoords(x: number, z: number): void {
    this.coords.textContent = `Player ${x.toFixed(1)}, ${z.toFixed(1)}`;
  }

  /** Reflect sculptor dirty/undo state. */
  refresh(): void {
    const unsaved = this.sculptor.hasUnsaved;
    this.status.textContent = unsaved ? "Unsaved changes" : "Saved";
    this.status.classList.toggle("unsaved", unsaved);
    this.undoBtn.disabled = !this.sculptor.canUndo;
  }

  private selectTool(tool: SculptTool): void {
    this.sculptor.settings.tool = tool;
    for (const [t, b] of this.toolButtons) b.classList.toggle("active", t === tool);
    this.renderContextual();
  }

  private renderContextual(): void {
    const s = this.sculptor.settings;
    this.contextual.replaceChildren();

    if (s.tool === "set") {
      const input = h("input", { type: "number", step: "0.25", value: String(s.setHeight) });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) s.setHeight = v;
      });
      this.contextual.append(h("div", { className: "dev-field" }, "Target height", input));
    } else if (s.tool === "paint") {
      const grid = h("div", { className: "dev-swatches" });
      for (const m of TERRAIN_MATERIALS) {
        const sw = h("div", { className: "dev-swatch", title: m.name });
        sw.style.background = m.id === 0 ? "repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)" : m.color;
        sw.classList.toggle("active", s.material === m.id);
        sw.addEventListener("click", () => {
          s.material = m.id;
          this.renderContextual();
        });
        grid.append(sw);
      }
      const name = TERRAIN_MATERIALS.find((m) => m.id === s.material)?.name ?? "";
      this.contextual.append(h("h3", {}, `Material · ${name}`), grid);
    } else if (s.tool === "walk") {
      const grid = h("div", { className: "dev-grid cols-3" });
      for (const [mode, label] of WALK_MODES) {
        const b = h("button", { className: "dev-btn", onclick: () => { s.walkMode = mode; this.renderContextual(); } }, label);
        b.classList.toggle("active", s.walkMode === mode);
        grid.append(b);
      }
      this.contextual.append(h("h3", {}, "Collision brush"), grid);
    }
  }

  private slider(label: string, min: number, max: number, step: number, value: number, set: (v: number) => void): HTMLElement {
    const out = h("output", {}, String(value));
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      set(v);
      out.textContent = String(v);
    });
    return h("div", { className: "dev-row" }, label, input, out);
  }

  private hint(): HTMLElement {
    const k = (t: string): HTMLElement => h("kbd", {}, t);
    return h(
      "div",
      { className: "dev-hint" },
      k("LMB"), " sculpt · ", k("RMB"), " walk · ", k("Ctrl"), "+", k("RMB"), " teleport", h("br"),
      k("["), k("]"), " radius · ", k("Ctrl"), "+", k("Z"), " undo · ", k("Ctrl"), "+", k("S"), " save · ", k("F1"), " close", h("br"),
      "Free cam: ", k("W"), k("A"), k("S"), k("D"), " fly · ", k("Q"), k("E"), " down/up · ", k("Shift"), " fast · ", k("RMB"), " look · wheel dolly",
    );
  }
}
