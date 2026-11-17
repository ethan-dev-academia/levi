import { ART_CHARS, type ITEM_ICONS, type ItemArt, type ItemDef } from "@levi/shared";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 24×24 glyphs for item kinds: [filled shape, detail stroke]. Filled in the
 * item's tint with a dark outline, so every item reads at slot size without
 * any hand-drawn art. New glyphs: add a key to ITEM_ICONS and a path here.
 */
const GLYPHS: Record<(typeof ITEM_ICONS)[number], [string, string]> = {
  sword: ["M17.5 3.5l3 0 0 3-10 10-3-3z", "M5 14l5 5M4 20l3-3"],
  dagger: ["M16 4l4 0 0 4-7 7-4-4z", "M6.5 12.5l5 5M5 19l2.5-2.5"],
  bow: ["M6 3c7 1 14 8 15 15l-2 0C18 12 12 6 6 5z", "M6 4l14 14M4 6l3 0M18 20l0-3"],
  gun: ["M3 9h15l2-2h1v5h-6l-2 2v5H9v-5H3z", "M13 12v2"],
  staff: ["M14 6l4-4 3 3-4 4z", "M15 9L4 20M17.5 4.5l1 1"],
  wand: ["M16 3l2 2-11 14-2-2z", "M18 2l1 -1M20 5l2-1M21 2l1.5-1"],
  helm: ["M5 13a7 7 0 0 1 14 0v5h-4v-3H9v3H5z", "M12 6v7"],
  chest: ["M8 3h8l4 4-2 3-1-1v12H7V9l-1 1-2-3z", "M12 6v14M9 12h6"],
  legs: ["M7 3h10l1 18h-4l-2-11-2 11H6z", "M7 6h10"],
  boots: ["M7 3h6v11l7 3v4H5V17l2-1z", "M7 7h6"],
  shield: ["M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z", "M12 6v12M8 11h8"],
  orb: ["M12 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z", "M9 9a3 3 0 0 1 3-2M8 20h8"],
  talisman: ["M12 8l5 5-5 7-5-7z", "M12 8V3M9 4l3 4 3-4"],
  potion: ["M10 3h4v5l4 6a5 5 0 0 1-4 7h-4a5 5 0 0 1-4-7l4-6z", "M9 3h6M7.5 14h9"],
  bread: ["M4 13c0-4 4-7 8-7s8 3 8 7v4H4z", "M8 10l1 3M12 9v4M16 10l-1 3"],
  fish: ["M3 12c3-5 10-6 14-2l4-3v10l-4-3c-4 4-11 3-14-2z", "M7 11h.5"],
  ore: ["M5 15l3-7 7-2 5 6-2 7-9 0z", "M8 8l3 5 7-1M11 13l-2 6"],
  log: ["M4 8h13a3 4 0 0 1 0 8H4z", "M17 10a1.5 2 0 1 0 0 4M4 8a3 4 0 0 0 0 8"],
  herb: ["M12 21c0-6 0-9 6-15-1 6-3 9-6 10M12 16c-4-1-6-4-6-8 3 1 5 3 6 6", "M12 21V12"],
  tome: ["M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z", "M8 4v16M11 9h4M11 12h4"],
  arrow: ["M4 20L17 7l-1-3 4-1-1 4-3-1L4 20z", "M5 15l1 3 3 1M7 13l1 3 3 1"],
  key: ["M15 3a5 5 0 1 1-4 8L4 18v3h3v-2h2v-2h2l2-2a5 5 0 0 1 2-12z", "M16 7h.5"],
  scroll: ["M6 4h11a2 2 0 0 1 0 4h-1v10a2 2 0 0 1-2 2H5a2 2 0 0 1 0-4h1z", "M9 9h5M9 12h5M9 15h3"],
  gem: ["M7 4h10l4 6-9 11L3 10z", "M3 10h18M9 4l3 6 3-6M12 10v11"],
  envelope: ["M3 6h18v13H3z", "M3 6l9 7 9-7M3 19l7-6M21 19l-7-6M11 12.5h2"],
  feather: ["M19 3C11 4 6 10 5 18l2 1c3-2 7-5 9-9 2-3 3-5 3-7z", "M5 21l9-12M9 15h4M11 12h3"],
  bottle: ["M10 2h4v4l3 4v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10l3-4z", "M9.5 2h5M7 13h10M10 6h4"],
  map: ["M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z", "M9 4v14M15 6v14M5 10l2 1M17 12l2-1"],
};

export function itemIcon(icon: (typeof ITEM_ICONS)[number], color: string): SVGSVGElement {
  const [fill, detail] = GLYPHS[icon];
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "item-icon");
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("d", fill);
  body.setAttribute("fill", color);
  body.setAttribute("stroke", "#15120e");
  body.setAttribute("stroke-width", "1.4");
  body.setAttribute("stroke-linejoin", "round");
  const lines = document.createElementNS(SVG_NS, "path");
  lines.setAttribute("d", detail);
  lines.setAttribute("fill", "none");
  lines.setAttribute("stroke", "#15120e");
  lines.setAttribute("stroke-width", "1.3");
  lines.setAttribute("stroke-linecap", "round");
  lines.setAttribute("opacity", "0.75");
  svg.append(body, lines);
  return svg;
}

/**
 * Vector pixel art: one <path> per palette colour, horizontal runs merged
 * into single rects, crisp edges. Scales cleanly to any slot size.
 */
export function artSvg(art: ItemArt): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${art.size} ${art.size}`);
  svg.setAttribute("class", "item-icon item-art");
  svg.setAttribute("shape-rendering", "crispEdges");
  const paths = new Map<number, string[]>();
  art.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const idx = ch === "." ? -1 : ART_CHARS.indexOf(ch);
      if (idx >= 0 && idx < art.palette.length) {
        let list = paths.get(idx);
        if (!list) paths.set(idx, (list = []));
        list.push(`M${x} ${y}h${end - x}v1h${x - end}z`);
      }
      x = end;
    }
  });
  for (const [idx, d] of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d.join(""));
    p.setAttribute("fill", art.palette[idx]!);
    svg.appendChild(p);
  }
  return svg;
}

/** An item's picture: its pixel art if it has some, else its tinted glyph. */
export function itemGraphic(def: Pick<ItemDef, "icon" | "color" | "art">): SVGSVGElement {
  return def.art ? artSvg(def.art) : itemIcon(def.icon, def.color);
}
