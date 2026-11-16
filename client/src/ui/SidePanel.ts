const SVG_NS = "http://www.w3.org/2000/svg";

/** 24×24 stroke icons (path `d` strings). */
export const ICONS = {
  combat: "M14 4h6v6l-9 9-6-6zM4 20l4-4M7 13l4 4",
  skills: "M5 20v-6M10 20V9M15 20v-8M20 20V4",
  quests: "M7 4h10a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V5M6 5a1 1 0 0 0-2 0v3h2M10 9h6M10 13h6M10 17h4",
  inventory: "M6 9h12l-1 11H7zM9 9V7a3 3 0 0 1 6 0v2",
  equipment: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  spells: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  friends: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
} as const;

export interface TabDef {
  id: string;
  title: string;
  icon: string;
  render(container: HTMLElement): void;
}

function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

/** Icon tab strip + single content pane. */
export class SidePanel {
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(
    tabBar: HTMLElement,
    private readonly content: HTMLElement,
    private readonly tabs: readonly TabDef[],
    initial: string,
  ) {
    for (const tab of tabs) {
      const b = document.createElement("button");
      b.className = "tab";
      b.title = tab.title;
      b.setAttribute("aria-label", tab.title);
      b.appendChild(icon(tab.icon));
      b.addEventListener("click", () => this.open(tab.id));
      tabBar.appendChild(b);
      this.buttons.set(tab.id, b);
    }
    this.open(initial);
  }

  open(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    for (const [tid, b] of this.buttons) b.classList.toggle("active", tid === id);
    this.content.replaceChildren();
    const h = document.createElement("h3");
    h.textContent = tab.title;
    this.content.appendChild(h);
    tab.render(this.content);
  }
}

/** Static placeholder tab: plain lines, or "key: value" pairs rendered as rows. */
export function textTab(id: string, title: string, iconPath: string, lines: string[]): TabDef {
  return {
    id,
    title,
    icon: iconPath,
    render(el) {
      for (const line of lines) {
        const row = document.createElement("div");
        const sep = line.indexOf(": ");
        if (sep > 0) {
          row.className = "kv";
          const v = document.createElement("b");
          v.textContent = line.slice(0, sep);
          const k = document.createElement("span");
          k.textContent = line.slice(sep + 2);
          row.append(v, k);
        } else {
          row.textContent = line;
        }
        el.appendChild(row);
      }
    },
  };
}
