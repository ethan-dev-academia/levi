import type { EnemyAttack, EnemyDef } from "@levi/shared";
import { h } from "../dom.js";
import { field, numInput, selectInput, textInput } from "./fields.js";

const SHAPES: ReadonlyArray<[EnemyAttack["shape"], string]> = [["circle", "Circle"], ["line", "Line"], ["cone", "Cone"]];

/**
 * Enemy editor: look, level, stats, behaviour and attacks. Every attack is
 * a red telegraph on the ground that strikes after its windup.
 */
export function enemyForm(e: EnemyDef, isNew: boolean, modelIds: string[], changed: () => void): HTMLElement {
  const root = h("div", { className: "qe-form" });
  const num = (label: string, value: number, set: (v: number) => void, step = "1", min = 0): HTMLElement =>
    field(label, numInput(value, (v) => set(Math.max(min, v ?? min)), step), "im-field small");
  const idInput = textInput(e.id, (v) => (e.id = v.trim()));
  idInput.disabled = !isNew;

  const dummy = h("input", { type: "checkbox", checked: e.dummy });
  dummy.addEventListener("change", () => { e.dummy = dummy.checked; changed(); });

  root.append(
    h("div", { className: "im-grid" },
      field("Name", textInput(e.name, (v) => (e.name = v))),
      field("Id (file name)", idInput),
      num("Level", e.level, (v) => (e.level = Math.round(v)), "1", 1),
      field("Model", selectInput(e.model, modelIds.map((m): [string, string] => [m, m]), (v) => { e.model = v; changed(); })),
      num("Size", e.scale, (v) => (e.scale = v), "0.05", 0.2),
      num("XP for the kill", e.xp, (v) => (e.xp = Math.round(v))),
      num("Respawn (s)", e.respawn, (v) => (e.respawn = v), "1", 1),
    ),
    h("label", { className: "qe-check" }, dummy, "Training dummy (never moves, attacks or dies; small XP per hit)"),
    h("h3", {}, "Stats"),
    h("div", { className: "im-grid" },
      num("Max health", e.stats.maxHp, (v) => (e.stats.maxHp = v), "1", 1),
      num("Armour", e.stats.armour, (v) => (e.stats.armour = v)),
      num("Move speed", e.stats.moveSpeed, (v) => (e.stats.moveSpeed = v), "0.1"),
    ),
    h("h3", {}, "Behaviour"),
    h("div", { className: "im-grid" },
      num("Notices you within", e.aggroRange, (v) => (e.aggroRange = v), "0.5"),
      num("Gives up beyond", e.leashRange, (v) => (e.leashRange = v), "0.5", 1),
    ),
    h("div", { className: "dev-empty" }, "Where it roams is set per placement (F1 → Build → Enemy)."),
    h("h3", {}, "Attacks"),
    h("div", { className: "dev-empty" }, "Never a direct hit: each marks the ground in red, waits its windup, then strikes whoever is still inside. Circles land on the player (target) or around the enemy (self); lines and cones point at the player."),
  );

  e.attacks.forEach((a, i) => {
    const card = h("div", { className: "qe-step" },
      h("div", { className: "qe-step-head" },
        textInput(a.name, (v) => (a.name = v)),
        textInput(a.id, (v) => (a.id = v.trim()), "id"),
        h("button", { className: "qe-x", title: "Remove attack", onclick: () => { e.attacks.splice(i, 1); changed(); } }, "×")),
      h("div", { className: "im-grid" },
        field("Shape", selectInput(a.shape, SHAPES, (v) => { a.shape = v as EnemyAttack["shape"]; changed(); }), "im-field small"),
        ...(a.shape === "circle" ? [field("Centred on", selectInput(a.anchor, [["target", "the player (wide area)"], ["self", "itself (close area)"]], (v) => { a.anchor = v as EnemyAttack["anchor"]; }), "im-field small")] : []),
        num("Starts when player within", a.range, (v) => (a.range = v), "0.5", 0.5),
        ...(a.shape === "circle" ? [num("Radius", a.radius, (v) => (a.radius = v), "0.1", 0.3)] : [num("Length", a.length, (v) => (a.length = v), "0.1", 0.5)]),
        ...(a.shape === "line" ? [num("Width", a.width, (v) => (a.width = v), "0.1", 0.2)] : []),
        ...(a.shape === "cone" ? [num("Half-angle (°)", a.angle, (v) => (a.angle = v), "1", 5)] : []),
        num("Windup (s)", a.windup, (v) => (a.windup = v), "0.1", 0.2),
        num("Damage", a.damage, (v) => (a.damage = v)),
        num("Cooldown (s)", a.cooldown, (v) => (a.cooldown = v), "0.1"),
        field("While winding up", selectInput(a.tracking, [["auto", "commits (locked in place)"], ["follow", "follows the enemy"]], (v) => { a.tracking = v as EnemyAttack["tracking"]; }), "im-field small"),
      ),
    );
    root.append(card);
  });
  root.append(h("button", { className: "dev-btn", onclick: () => {
    let n = e.attacks.length + 1;
    while (e.attacks.some((a) => a.id === `attack-${n}`)) n++;
    e.attacks.push({ id: `attack-${n}`, name: "New attack", shape: "circle", anchor: "self", range: 2, radius: 1.5, length: 4, width: 1.2, angle: 40, windup: 1, damage: 5, cooldown: 3, tracking: "auto" });
    changed();
  } }, "+ Attack"));
  return root;
}
