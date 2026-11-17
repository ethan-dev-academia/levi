import type { Condition, DialogueNode, DialogueOption, Effect, NpcDef } from "../schemas/npc.js";
import type { Objective, QuestDef, QuestStep } from "../schemas/quest.js";
import type { Character, Result } from "./Character.js";
import { DISCIPLINE_NAMES, type Discipline } from "./disciplines.js";

export interface QuestData {
  quests: ReadonlyMap<string, QuestDef>;
  npcs: ReadonlyMap<string, NpcDef>;
}

/** Things that happen in the world that objectives listen for. */
export type QuestEvent =
  | { kind: "talk"; npc: string; node?: string; ended?: boolean }
  | { kind: "pickup"; item: string; qty: number }
  | { kind: "defeat"; enemy: string }
  | { kind: "reach"; region: string }
  | { kind: "use"; prop: string }
  /** Bag changed: re-check collect objectives. */
  | { kind: "inventory" };

export type QuestStatus = "notStarted" | "active" | "done";

export interface QuestNotify {
  (text: string, kind?: "quest" | "system"): void;
}

const ok = (msg?: string): Result => (msg === undefined ? { ok: true } : { ok: true, msg });
const fail = (msg: string): Result => ({ ok: false, msg });

/**
 * Quest rules over one character: requirements, steps, objectives, rewards,
 * and the conditions/effects dialogue uses. Pure and deterministic; the
 * server runs exactly this.
 */
export class QuestEngine {
  constructor(
    private readonly c: Character,
    private readonly data: QuestData,
    private readonly notify: QuestNotify,
  ) {}

  quest(id: string): QuestDef | undefined {
    return this.data.quests.get(id);
  }

  status(id: string): QuestStatus {
    const st = this.c.save.quests[id];
    return !st ? "notStarted" : st.stage === "done" ? "done" : "active";
  }

  /** Human-readable unmet requirements (empty = can start). */
  missing(q: QuestDef): string[] {
    const r = q.requirements;
    const out: string[] = [];
    for (const id of r.quests) if (this.status(id) !== "done") out.push(`Complete "${this.quest(id)?.name ?? id}"`);
    if (r.combatLevel && this.c.combatLevel < r.combatLevel) out.push(`Combat level ${r.combatLevel}`);
    if (r.adventureLevel && this.c.level("adventuring") < r.adventureLevel) out.push(`Adventuring level ${r.adventureLevel}`);
    for (const [d, lvl] of Object.entries(r.skills) as Array<[Discipline, number]>) {
      if (this.c.level(d) < lvl) out.push(`${DISCIPLINE_NAMES[d]} level ${lvl}`);
    }
    for (const f of r.flags) if (!this.c.save.worldFlags.includes(f)) out.push(`Unlock: ${f}`);
    return out;
  }

  /** Current step of an active quest. */
  step(q: QuestDef): QuestStep | null {
    const st = this.c.save.quests[q.id];
    return st && st.stage !== "done" ? q.steps[st.stage] ?? null : null;
  }

  start(id: string): Result {
    const q = this.quest(id);
    if (!q) return fail("Unknown quest.");
    if (this.status(id) !== "notStarted") return ok();
    const missing = this.missing(q);
    if (missing.length) return fail(`You can't start ${q.name} yet: ${missing.join(", ")}.`);
    this.c.save.quests[id] = { stage: 0, progress: {} };
    this.notify(`Quest started: ${q.name}`, "quest");
    this.advance(q); // a step might already be satisfied (e.g. items in hand)
    return ok();
  }

  /** Progress toward an objective: what you have / what's needed. */
  progress(q: QuestDef, o: Objective): { have: number; need: number } {
    const need = "qty" in o ? o.qty : 1;
    if (o.kind === "collect") return { have: Math.min(need, this.c.count(o.item)), need };
    const st = this.c.save.quests[q.id];
    return { have: Math.min(need, st?.progress[o.id] ?? 0), need };
  }

  objectiveDone(q: QuestDef, o: Objective): boolean {
    const p = this.progress(q, o);
    return p.have >= p.need;
  }

  private bump(q: QuestDef, o: Objective, by = 1): void {
    const st = this.c.save.quests[q.id];
    if (!st || st.stage === "done") return;
    const need = "qty" in o ? o.qty : 1;
    const before = st.progress[o.id] ?? 0;
    if (before >= need) return;
    st.progress[o.id] = Math.min(need, before + by);
    if (st.progress[o.id]! >= need) this.notify(`${q.name}: ${o.text} ✓`, "quest");
    else if (need > 1) this.notify(`${q.name}: ${o.text} (${st.progress[o.id]}/${need})`, "quest");
  }

  /** Feed a world event to every active quest's current step. */
  event(e: QuestEvent): void {
    for (const q of this.data.quests.values()) {
      const step = this.step(q);
      if (!step) continue;
      for (const o of step.objectives) {
        if (o.kind === "talk" && e.kind === "talk" && o.npc === e.npc && (o.node ? o.node === e.node : !!e.ended)) this.bump(q, o);
        else if (o.kind === "pickup" && e.kind === "pickup" && o.item === e.item) this.bump(q, o, e.qty);
        else if (o.kind === "defeat" && e.kind === "defeat" && o.enemy === e.enemy) this.bump(q, o);
        else if (o.kind === "reach" && e.kind === "reach" && o.region === e.region) this.bump(q, o);
        else if (o.kind === "use" && e.kind === "use" && o.prop === e.prop) this.bump(q, o);
      }
      this.advance(q);
    }
  }

  /** Dialogue/script trigger for one objective. */
  completeObjective(questId: string, objectiveId: string): void {
    const q = this.quest(questId);
    const step = q ? this.step(q) : null;
    const o = step?.objectives.find((x) => x.id === objectiveId);
    if (!q || !o) return;
    if (o.kind === "collect") {
      this.advance(q);
      return;
    }
    const need = "qty" in o ? o.qty : 1;
    this.bump(q, o, need);
    this.advance(q);
  }

  /** Finish steps whose objectives are all done (possibly several in a row). */
  private advance(q: QuestDef): void {
    for (let guard = 0; guard < 50; guard++) {
      const st = this.c.save.quests[q.id];
      const step = this.step(q);
      if (!st || !step || !step.objectives.every((o) => this.objectiveDone(q, o))) return;
      for (const o of step.objectives) if (o.kind === "collect" && o.consume) this.c.removeItem(o.item, o.qty);
      const next = (st.stage as number) + 1;
      if (next >= q.steps.length) {
        this.finish(q);
        return;
      }
      st.stage = next;
      st.progress = {};
      this.notify(`${q.name}: ${q.steps[next]!.journal.split(/(?<=\.)\s/)[0]}`, "quest");
    }
  }

  private finish(q: QuestDef): void {
    this.c.save.quests[q.id] = { stage: "done", progress: {} };
    const r = q.rewards;
    const parts: string[] = [];
    for (const [d, amount] of Object.entries(r.xp) as Array<[Discipline, number]>) {
      this.c.addXp(d, amount);
      parts.push(`${amount} ${DISCIPLINE_NAMES[d]} XP`);
    }
    if (r.coins) {
      this.c.addCoins(r.coins);
      parts.push(`${r.coins} coins`);
    }
    for (const it of r.items) {
      const left = this.c.addItem(it.item, it.qty);
      parts.push(`${it.qty > 1 ? `${it.qty}× ` : ""}${this.c.def(it.item)?.name ?? it.item}`);
      if (left > 0) this.notify(`Your bag is full: ${left}× ${this.c.def(it.item)?.name ?? it.item} couldn't be given.`, "system");
    }
    for (const sk of r.skills) {
      const g = this.c.grantSkill(sk.style, sk.skill);
      if (g.msg) this.notify(g.msg, "quest");
    }
    for (const f of r.unlocks) if (!this.c.save.worldFlags.includes(f)) this.c.save.worldFlags.push(f);
    this.c.save.pinned = this.c.save.pinned.filter((p) => p !== q.id);
    this.notify(`Quest complete: ${q.name}!${parts.length ? ` Rewards: ${parts.join(", ")}.` : ""}`, "quest");
  }

  // --- Dialogue conditions & effects ----------------------------------------------------------

  check(cond: Condition): boolean {
    switch (cond.kind) {
      case "questStatus": {
        const st = this.status(cond.quest);
        if (cond.status === "started") return st !== "notStarted";
        if (cond.status === "notDone") return st !== "done";
        return st === cond.status;
      }
      case "questStep": {
        const q = this.quest(cond.quest);
        return !!q && this.step(q)?.id === cond.step;
      }
      case "objectiveDone": {
        const q = this.quest(cond.quest);
        if (!q) return false;
        if (this.status(q.id) === "done") return true;
        const o = this.step(q)?.objectives.find((x) => x.id === cond.objective);
        return !!o && this.objectiveDone(q, o);
      }
      case "flag":
        return this.c.save.worldFlags.includes(cond.flag) === cond.set;
      case "hasItem":
        return this.c.count(cond.item) >= cond.qty;
      case "coins":
        return this.c.save.coins >= cond.min;
      case "level":
        return (cond.skill === "combat" ? this.c.combatLevel : this.c.level(cond.skill)) >= cond.min;
    }
  }

  checkAll(conds: readonly Condition[]): boolean {
    return conds.every((c) => this.check(c));
  }

  apply(e: Effect): void {
    switch (e.kind) {
      case "startQuest": {
        const r = this.start(e.quest);
        if (!r.ok) this.notify(r.msg, "system");
        break;
      }
      case "objective":
        this.completeObjective(e.quest, e.objective);
        break;
      case "giveItem": {
        const left = this.c.addItem(e.item, e.qty);
        if (left > 0) this.notify("Your bag is full.", "system");
        this.event({ kind: "inventory" });
        break;
      }
      case "takeItem":
        this.c.removeItem(e.item, e.qty);
        this.event({ kind: "inventory" });
        break;
      case "coins":
        this.c.addCoins(e.amount);
        break;
      case "grantSkill": {
        const g = this.c.grantSkill(e.style, e.skill);
        if (g.msg) this.notify(g.msg, "quest");
        break;
      }
      case "setFlag": {
        const flags = this.c.save.worldFlags;
        const has = flags.includes(e.flag);
        if (e.value && !has) flags.push(e.flag);
        if (!e.value && has) flags.splice(flags.indexOf(e.flag), 1);
        break;
      }
    }
  }

  // --- Dialogue navigation --------------------------------------------------------------------

  /** First entry whose conditions pass → its start node. */
  entryNode(npc: NpcDef): DialogueNode | null {
    for (const e of npc.entries) {
      if (this.checkAll(e.when)) return npc.nodes.find((n) => n.id === e.start) ?? null;
    }
    return null;
  }

  /** Choices offered at a node (with their index in node.options). */
  options(node: DialogueNode): Array<{ index: number; option: DialogueOption }> {
    return node.options.map((option, index) => ({ index, option })).filter(({ option }) => this.checkAll(option.when));
  }
}
