// Экран боя на фишках: 3D-стол со стопкой и биткой, под ним стопка по порядку, чтобы читать фишки.
// Если WebGL недоступен, остаётся только стопка по порядку.

import { type Battle, type Chip, type Ev, type Power, autoPower, flipChances, intentIndex, intentText, newBattle, strike, visible } from "./chips";
import { C, chipLabel } from "./content";
import type { GameManifest } from "./assets";
import { image } from "./assets";
import { composeDoll } from "./doll";
import { enemyStub } from "./page";
import { pogBack, pogFace } from "./pogart";
import { type Run, heroChips, look } from "./run";
import { blip, buzz, clack, setSound, soundOn, thump } from "./sound";
import type { PogTable } from "./table3d";
import { type Card, h, overlay, pickCard, wait } from "./ui";

export interface BattleResult {
  win: boolean;
  battle: Battle;
  redrawn: boolean;
  kept?: string;
}

async function enemyImg(gm: GameManifest, id: string, pose: string): Promise<HTMLCanvasElement | HTMLImageElement> {
  const e = gm.enemies[id];
  const img = await image(e?.poses[pose] || e?.poses.stand);
  return img || enemyStub(id, pose);
}

/** Порядок стопки после хода врага, но до удара (сильный удар: враг бьёт первым). */
function beforeSlam(prev: Battle, pre: Ev[], next: Battle): Chip[] {
  let st = [...prev.stack];
  for (const e of pre) {
    if ((e.kind === "enemy" || e.kind === "knock") && e.chip) {
      const i = st.findIndex((c) => c.id === e.chip!.id);
      if (i >= 0) st.push(...st.splice(i, 1));
    }
  }
  const gone = next.knocked.filter((k) => !prev.knocked.includes(k));
  if (gone.length) st = st.filter((c) => !c.item || !gone.includes(c.item));
  return st;
}

const PRE = new Set(["enemy", "miss", "knock"]);

// 3D-стол грузится отдельным файлом, чтобы первая страница открывалась быстро
let t3: Promise<typeof import("./table3d") | null> | null = null;
const table3d = () => (t3 ||= import("./table3d").catch(() => null));
/** Начать загрузку 3D-стола заранее, пока игрок читает комикс. */
export const preloadTable = () => void table3d();

export async function fight(gm: GameManifest, run: Run, enemyId: string, rng = Math.random): Promise<BattleResult> {
  const T3 = await table3d();
  const def = C.enemies[enemyId];
  const slamId = C.slammers[run.hand] ? run.hand : "fist";
  const slammer = C.slammers[slamId];
  let b = newBattle({
    enemyId, def, heroChips: heroChips(run), hp: run.hp, max: run.max,
    slammer, stickers: run.stickers, rng, alarmed: run.flags.includes("alarmed") && C.bosses.includes(enemyId),
  });
  let prev: Battle | null = null;
  let redrawn = false, busy = false, auto = false, preview: Power | null = null;

  let table: PogTable | null = null;
  if (T3?.webglOk()) {
    try { table = new T3.PogTable(slamId, slammer.title); } catch { table = null; }
  }

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
  const soundBtn = h("button", { class: "ghost", "aria-pressed": String(soundOn()) }, soundOn() ? "Звук: вкл" : "Звук: выкл");
  const captured = h("div", { class: "captured" });

  ov.box.append(h("div", { class: "b-top" },
    h("div", { class: "b-side" }, enemyPic, h("div", {}, h("h2", {}, def.title), eHp, eInfo, intent)),
    table ? null : boom));
  if (table) ov.box.append(h("div", { class: "b-table" }, table.el, boom));
  ov.box.append(
    h("div", { class: "b-stack" }, h("div", { class: "label" }, "Стопка по порядку, сверху слева"), stack, captured),
    feed,
    h("div", { class: "b-bottom" },
      h("div", { class: "b-side" }, heroPic, h("div", {}, h("h2", {}, "Ты"), hHp, hInfo)),
      h("div", { class: "b-acts" }, light, strong, h("div", { class: "row" }, redraw, autoBtn, soundBtn))),
  );

  const [la, lz] = slammer.light, [sa, sz] = slammer.strong;
  const flame = run.stickers.bat.includes("flame") ? 1 : 0;
  (light.lastChild as HTMLElement).textContent = `переворачивает ${la === lz ? la : `${la}–${lz}`}, бьёшь первым`;
  (strong.lastChild as HTMLElement).textContent = `переворачивает ${sa + flame}–${sz + flame}${slammer.bottom ? " и нижнюю" : ""}, враг бьёт первым`;

  void enemyImg(gm, enemyId, "stand").then((im) => enemyPic.replaceChildren(im));
  void composeDoll(gm, look(run), "fight").then((d) => d && heroPic.replaceChildren(d));

  const pogEl = (c: Chip, i: number, chances: number[] | null) => {
    const shown = visible(b, i);
    const isIntent = i === intentIndex(b);
    const cv = h("canvas", { width: "128", height: "128", "aria-hidden": "true" });
    cv.getContext("2d")!.drawImage(shown ? pogFace(c) : pogBack(c.owner), 0, 0, 128, 128);
    const pct = chances ? Math.round(chances[i] * 100) : -1;
    const name = shown ? `${c.name}: ${chipLabel(c)}` : "Вражья фишка рубашкой вверх";
    return h("div", { class: `pog ${c.owner} ${isIntent ? "intent" : ""}`, "data-id": String(c.id), title: name, role: "img", "aria-label": name },
      cv,
      isIntent ? h("em", {}, "план") : null,
      pct > 0 ? h("u", { class: pct >= 100 ? "sure" : "" }, `${pct}%`) : null);
  };

  const bar = (el: HTMLElement, hp: number, max: number) => {
    el.replaceChildren(h("span", { style: { width: `${Math.max(0, (hp / max) * 100)}%` } }), h("b", {}, `${Math.max(0, hp)} / ${max}`));
  };

  function render() {
    const chances = preview ? flipChances(b, preview) : null;
    stack.replaceChildren(...b.stack.map((c, i) => pogEl(c, i, chances)));
    table?.preview(b.stack, chances);
    table?.setIntent(b.stack[intentIndex(b)]?.id ?? -1);
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
    hInfo.textContent = `Битка: ${slammer.title}${slammer.note ? `, ${slammer.note.toLowerCase()}` : ""} · чернила ${run.ink}` +
      (b.knocked.length ? ` · слетело: ${b.knocked.map((k) => C.items[k]?.title || k).join(", ")}` : "");
    captured.textContent = b.captured.length ? `Трофеи: ${b.captured.map((c) => c.name).join(", ")}` : "";
    const can = !b.over && !busy;
    light.disabled = strong.disabled = !can || auto;
    redraw.disabled = busy || redrawn || !prev || run.ink < 1 || b.over === "win";
    autoBtn.disabled = !!b.over;
  }

  const sfx = (text: string, bad = false) => boom.replaceChildren(h("span", { class: `sfx ${bad ? "bad" : ""}` }, text));

  async function play(p: Power) {
    if (busy || b.over) return;
    busy = true; preview = null;
    const before = b;
    const next = strike(b, p, rng);
    const log = next.log[next.log.length - 1];
    render();
    feed.replaceChildren();
    let eNow = before.enemy.hp, hNow = before.hero.hp, caps = before.captured.length;
    const pace = auto ? 260 : 430;

    const show = async (e: Ev) => {
      feed.append(h("div", { class: `ev ${e.kind}` }, e.text));
      if (e.sfx) sfx(e.sfx, e.kind === "enemy" || e.kind === "trap");
      const id = e.chip?.id ?? null;
      switch (e.kind) {
        case "chip":
          blip(true);
          if (e.dmg) { eNow -= e.dmg; bar(eHp, eNow, before.enemy.max); void enemyImg(gm, enemyId, "hit").then((im) => enemyPic.replaceChildren(im)); }
          if (id !== null) { void table?.pulse(id); table?.label(id, e.dmg ? `−${e.dmg}` : chipLabel(e.chip!), "good"); }
          break;
        case "capture":
          blip(false);
          if (id !== null) { table?.label(id, "ЦАП!", "good"); void table?.capture(id, caps++); }
          break;
        case "trap":
          buzz();
          if (e.dmg) { hNow -= e.dmg; bar(hHp, hNow, before.hero.max); }
          if (id !== null) { void table?.trap(id); table?.label(id, e.dmg ? `−${e.dmg}` : "ЛОВУШКА", "bad"); }
          break;
        case "enemy": case "knock":
          buzz();
          if (e.dmg) { hNow -= e.dmg; bar(hHp, hNow, before.hero.max); }
          void enemyImg(gm, enemyId, "attack").then((im) => enemyPic.replaceChildren(im));
          void table?.enemy(id ?? undefined);
          table?.label(id, e.dmg ? `−${e.dmg}` : e.kind === "knock" ? "ШМЯК!" : (e.sfx || "!"), "bad");
          break;
        case "miss": table?.label(id, "МИМО", "good"); break;
        case "phase": buzz(); table?.label(null, "ВТОРАЯ ФАЗА", "bad"); break;
      }
      await wait(pace);
    };

    // сильный удар: сначала ход врага, потом битка
    const evs = log.events;
    let k = 0;
    if (p === "strong") {
      if (evs[0]?.kind === "info") await show(evs[k++]);
      while (k < evs.length && (PRE.has(evs[k].kind) || (evs[k].kind === "stun" && !evs[k].text.startsWith("Шокер")))) await show(evs[k++]);
      if (table && log.ids.length) await table.arrange(beforeSlam(before, evs.slice(0, k), next), before.captured, 380);
    }
    if (log.ids.length) {
      for (const id of log.ids) stack.querySelector(`[data-id="${id}"]`)?.classList.add("flip");
      const onHit = () => {
        thump(p === "strong");
        sfx(p === "strong" ? "БАМ!" : "ТУК!");
        log.ids.forEach((_, i) => clack(0.55 + i * 0.06));
      };
      if (table) await table.slam(log.ids, p === "strong", onHit);
      else { onHit(); await wait(420); }
    }
    for (; k < evs.length; k++) await show(evs[k]);
    prev = before;
    b = next;
    void enemyImg(gm, enemyId, b.over === "win" ? "defeated" : "stand").then((im) => enemyPic.replaceChildren(im));
    if (table) await table.arrange(b.stack, b.captured);
    busy = false;
    render();
    if (b.over) await end();
    else if (auto) { await wait(450); if (auto) void play(autoPower(b)); }
  }

  let resolve!: (r: BattleResult) => void;
  const result = new Promise<BattleResult>((ok) => (resolve = ok));

  async function end() {
    auto = false;
    sfx(b.over === "win" ? "ПОБЕДА!" : "НОКАУТ…", b.over !== "win");
    await wait(900);
    table?.dispose();
    let kept: string | undefined;
    if (b.over === "win" && b.captured.length) {
      const uniq = b.captured.filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i);
      const cards: Card[] = uniq.map((c) => {
        const k = C.keep[c.act as keyof typeof C.keep] || { act: "hit" };
        const n = c.act === "hit" ? Math.min(6, c.n * (c.times || 1)) : c.n || 2;
        const cv = h("canvas", { width: "112", height: "112" });
        cv.getContext("2d")!.drawImage(pogFace({ owner: "hero", act: k.act, n, name: c.name }), 0, 0, 112, 112);
        return { title: c.name, body: `Станет твоей фишкой: ${chipLabel({ act: k.act, n })}`, tag: "трофей", icon: cv };
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
    const on = () => { if (!busy) { preview = p; render(); } };
    const off = () => { if (!busy) { preview = null; render(); } };
    btn.addEventListener("mouseenter", on); btn.addEventListener("focus", on);
    btn.addEventListener("mouseleave", off); btn.addEventListener("blur", off);
  }
  redraw.addEventListener("click", async () => {
    if (!prev || redrawn || run.ink < 1 || busy) return;
    run.ink -= 1; run.stats.inkSpent += 1;
    b = prev; prev = null; redrawn = true;
    feed.replaceChildren(h("div", { class: "ev info" }, "Удар перерисован. Попробуй ещё раз."));
    sfx("ВЖИК!");
    busy = true;
    if (table) await table.arrange(b.stack, b.captured);
    busy = false;
    render();
  });
  autoBtn.addEventListener("click", () => {
    auto = !auto;
    autoBtn.setAttribute("aria-pressed", String(auto));
    render();
    if (auto && !busy) void play(autoPower(b));
  });
  soundBtn.addEventListener("click", () => {
    setSound(!soundOn());
    soundBtn.setAttribute("aria-pressed", String(soundOn()));
    soundBtn.textContent = soundOn() ? "Звук: вкл" : "Звук: выкл";
  });
  feed.append(h("div", { class: "ev info" }, "Наведи на удар: подсветятся фишки, которые он перевернёт. Твои срабатывают, вражьи ты забираешь, ловушка обрывает каскад."));
  render();
  if (table) {
    busy = true;
    void table.arrange(b.stack, [], 900).then(() => { busy = false; render(); light.focus(); });
  } else light.focus();
  return result;
}
