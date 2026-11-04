// Экран боя на фишках.

import { type Battle, type Chip, type Power, autoPower, flipChances, intentIndex, intentText, newBattle, strike, visible } from "./chips";
import { C, chipLabel } from "./content";
import type { GameManifest } from "./assets";
import { image } from "./assets";
import { composeDoll } from "./doll";
import { enemyStub } from "./page";
import { type Run, heroChips, look } from "./run";
import { type Card, h, overlay, pickCard, wait } from "./ui";

export interface BattleResult {
  win: boolean;
  battle: Battle;
  redrawn: boolean;
  kept?: string;
}

const ICON: Record<string, string> = {
  hit: "👊", block: "🛡", dodge: "💨", heal: "✚", double: "×2", stun: "💫", ink: "✒", coin: "¤",
  shield: "🛡", rage: "🔥", knock: "🎩", trap: "⚠",
};

async function enemyImg(gm: GameManifest, id: string, pose: string): Promise<HTMLCanvasElement | HTMLImageElement> {
  const e = gm.enemies[id];
  const img = await image(e?.poses[pose] || e?.poses.stand);
  return img || enemyStub(id, pose);
}

export function fight(gm: GameManifest, run: Run, enemyId: string, rng = Math.random): Promise<BattleResult> {
  const def = C.enemies[enemyId];
  const slammer = C.slammers[run.hand] || C.slammers.fist;
  let b = newBattle({
    enemyId, def, heroChips: heroChips(run), hp: run.hp, max: run.max,
    slammer, stickers: run.stickers, rng, alarmed: run.flags.includes("alarmed") && C.bosses.includes(enemyId),
  });
  let prev: Battle | null = null;
  let redrawn = false, busy = false, auto = false, preview: Power | null = null;

  const ov = overlay("battle");
  const enemyPic = h("div", { class: "b-pic" });
  const heroPic = h("div", { class: "b-pic hero" });
  const eHp = h("div", { class: "bar" }), hHp = h("div", { class: "bar hero" });
  const eInfo = h("div", { class: "b-status" }), hInfo = h("div", { class: "b-status" });
  const intent = h("div", { class: "b-intent", "aria-live": "polite" });
  const stack = h("div", { class: "stack", "aria-label": "Стопка фишек, сверху слева" });
  const feed = h("div", { class: "feed", "aria-live": "polite" });
  const boom = h("div", { class: "boom" });
  const light = h("button", { class: "act" }, h("b", {}, "Лёгкий удар"), h("span", {}, ""));
  const strong = h("button", { class: "act" }, h("b", {}, "Сильный удар"), h("span", {}, ""));
  const redraw = h("button", { class: "ghost" }, "Перерисовать удар (−1 чернило)");
  const autoBtn = h("button", { class: "ghost", "aria-pressed": "false" }, "Авто");
  const captured = h("div", { class: "captured" });

  ov.box.append(
    h("div", { class: "b-top" },
      h("div", { class: "b-side" }, enemyPic, h("div", {}, h("h2", {}, def.title), eHp, eInfo, intent)),
      boom),
    h("div", { class: "b-stack" }, h("div", { class: "label" }, "Стопка · сверху ←"), stack, captured),
    feed,
    h("div", { class: "b-bottom" },
      h("div", { class: "b-side" }, heroPic, h("div", {}, h("h2", {}, "Ты"), hHp, hInfo)),
      h("div", { class: "b-acts" }, light, strong, h("div", { class: "row" }, redraw, autoBtn))),
  );

  const [la, lz] = slammer.light, [sa, sz] = slammer.strong;
  const flame = run.stickers.bat.includes("flame") ? 1 : 0;
  (light.lastChild as HTMLElement).textContent = `переворачивает ${la === lz ? la : `${la}–${lz}`}, бьёшь первым`;
  (strong.lastChild as HTMLElement).textContent = `переворачивает ${sa + flame}–${sz + flame}${slammer.bottom ? " и нижнюю" : ""}, враг бьёт первым`;

  void enemyImg(gm, enemyId, "stand").then((im) => enemyPic.replaceChildren(im));
  void composeDoll(gm, look(run), "fight").then((d) => d && heroPic.replaceChildren(d));

  const pogHtml = (c: Chip, i: number, chances: number[] | null) => {
    const shown = visible(b, i);
    const isIntent = i === intentIndex(b);
    const cls = ["pog", c.owner, shown ? "" : "hidden", isIntent ? "intent" : "", c.act === "trap" && shown ? "trap" : ""].join(" ");
    const pct = chances ? Math.round(chances[i] * 100) : -1;
    const label = shown ? chipLabel(c) : "?";
    return h("div", { class: cls, "data-id": String(c.id), title: shown ? `${c.name}: ${chipLabel(c)}` : "Вражья фишка рубашкой вверх" },
      h("i", {}, shown ? ICON[c.act] || "" : "?"),
      h("b", {}, label),
      h("small", {}, shown ? (c.owner === "enemy" ? c.name : c.name) : ""),
      isIntent ? h("em", {}, "план") : null,
      pct > 0 ? h("u", { class: pct >= 100 ? "sure" : "" }, `${pct}%`) : null);
  };

  const bar = (el: HTMLElement, hp: number, max: number) => {
    el.replaceChildren(h("span", { style: { width: `${Math.max(0, (hp / max) * 100)}%` } }), h("b", {}, `${hp} / ${max}`));
  };

  function render() {
    const chances = preview ? flipChances(b, preview) : null;
    stack.replaceChildren(...b.stack.map((c, i) => pogHtml(c, i, chances)));
    bar(eHp, b.enemy.hp, b.enemy.max);
    bar(hHp, b.hero.hp, b.hero.max);
    const st: string[] = [];
    if (b.enemy.shield) st.push(`щит ${b.enemy.shield}`);
    if (b.enemy.rage) st.push(`ярость +${b.enemy.rage}`);
    if (b.enemy.phase === 2) st.push("вторая фаза");
    const traps = b.stack.filter((c) => c.owner === "enemy" && c.act === "trap").length;
    if (traps) st.push(`ловушек в стопке: ${traps}`);
    eInfo.textContent = st.join(" · ");
    intent.textContent = `План: ${intentText(b)}`;
    hInfo.textContent = `${slammer.title}${slammer.note ? `: ${slammer.note.toLowerCase()}` : ""} · чернила ${run.ink}` +
      (b.knocked.length ? ` · слетело: ${b.knocked.map((k) => C.items[k]?.title || k).join(", ")}` : "");
    captured.textContent = b.captured.length ? `Забрано: ${b.captured.map((c) => c.name).join(", ")}` : "";
    const can = !b.over && !busy;
    light.disabled = strong.disabled = !can || auto;
    redraw.disabled = busy || redrawn || !prev || run.ink < 1 || b.over === "win";
    autoBtn.disabled = !!b.over;
  }

  async function play(p: Power) {
    if (busy || b.over) return;
    busy = true; preview = null;
    const before = b;
    const next = strike(b, p, rng);
    const log = next.log[next.log.length - 1];
    render();
    for (const id of log.ids) stack.querySelector(`[data-id="${id}"]`)?.classList.add("flip");
    if (log.ids.length) await wait(420);
    feed.replaceChildren();
    for (const e of log.events) {
      const line = h("div", { class: `ev ${e.kind}` }, e.text);
      feed.append(line);
      if (e.sfx) {
        boom.replaceChildren(h("span", { class: `sfx ${e.kind === "enemy" || e.kind === "trap" ? "bad" : ""}` }, e.sfx));
      }
      if (e.kind === "enemy" || e.kind === "trap") {
        void enemyImg(gm, enemyId, "attack").then((im) => enemyPic.replaceChildren(im));
      } else if (e.kind === "chip" && e.dmg) {
        void enemyImg(gm, enemyId, "hit").then((im) => enemyPic.replaceChildren(im));
      }
      await wait(auto ? 260 : 380);
    }
    prev = before;
    b = next;
    void enemyImg(gm, enemyId, b.over === "win" ? "defeated" : "stand").then((im) => enemyPic.replaceChildren(im));
    busy = false;
    render();
    if (b.over) await end();
    else if (auto) { await wait(500); if (auto) void play(autoPower(b)); }
  }

  let resolve!: (r: BattleResult) => void;
  const result = new Promise<BattleResult>((ok) => (resolve = ok));

  async function end() {
    auto = false;
    await wait(500);
    let kept: string | undefined;
    if (b.over === "win" && b.captured.length) {
      const uniq = b.captured.filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i);
      const cards: Card[] = uniq.map((c) => {
        const k = C.keep[c.act as keyof typeof C.keep] || { act: "hit" };
        const n = c.act === "hit" ? c.n * (c.times || 1) : c.n || 2;
        return { title: c.name, body: `Станет твоей фишкой: ${chipLabel({ act: k.act, n })}`, tag: "трофей" };
      });
      ov.close();
      const i = await pickCard("Победа! Игра «на интерес»", "Одну захваченную фишку можно оставить себе до конца забега.", cards, "Ничего не брать");
      if (i >= 0) {
        const c = uniq[i];
        const k = C.keep[c.act as keyof typeof C.keep] || { act: "hit" };
        const n = c.act === "hit" ? Math.min(6, c.n * (c.times || 1)) : c.n || 2;
        run.kept.push({ act: k.act, n, name: `${c.name} (${def.title})` });
        kept = c.name;
      }
    } else {
      ov.close();
    }
    resolve({ win: b.over === "win", battle: b, redrawn, kept });
  }

  light.addEventListener("click", () => void play("light"));
  strong.addEventListener("click", () => void play("strong"));
  for (const [btn, p] of [[light, "light"], [strong, "strong"]] as const) {
    btn.addEventListener("mouseenter", () => { preview = p; render(); });
    btn.addEventListener("focus", () => { preview = p; render(); });
    btn.addEventListener("mouseleave", () => { preview = null; render(); });
    btn.addEventListener("blur", () => { preview = null; render(); });
  }
  redraw.addEventListener("click", () => {
    if (!prev || redrawn || run.ink < 1) return;
    run.ink -= 1; run.stats.inkSpent += 1;
    b = prev; prev = null; redrawn = true;
    feed.replaceChildren(h("div", { class: "ev info" }, "Удар перерисован. Попробуй ещё раз."));
    boom.replaceChildren(h("span", { class: "sfx" }, "ВЖИК!"));
    render();
  });
  autoBtn.addEventListener("click", () => {
    auto = !auto;
    autoBtn.setAttribute("aria-pressed", String(auto));
    render();
    if (auto && !busy) void play(autoPower(b));
  });
  feed.append(h("div", { class: "ev info" }, "Наведи на удар, чтобы увидеть, какие фишки перевернутся. Твои срабатывают, вражьи ты забираешь, ловушка обрывает каскад."));
  render();
  light.focus();
  return result;
}
