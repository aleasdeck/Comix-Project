// Ход забега: старт с картами предыстории, пролог, главы из развилок, сцены с проверками, бои,
// миниигры, награды 1 из 3, наклейки и обложка. Всё, что игрок выбрал, монтируется в кадры.

import type { GameManifest } from "./assets";
import { fight, preloadTable } from "./battle";
import { Comic, type Sketch } from "./comic";
import {
  type Beat, type Encounter, type OptionDef, type Outcome, type Shot,
  C, KIND_NAMES, STATS, STAT_NAMES, chipLabel, thingTitle,
} from "./content";
import { STICKER_ICON, coverInfo, drawCover } from "./cover";
import { type Look, composeDoll, mannequin, skinHexOf } from "./doll";
import { playFlow, playPins } from "./minigames";
import { type Scene, battlePanels, lootPanel, shotPanel } from "./montage";
import { type Cast, type Panel, PAGE_H, PAGE_W } from "./page";
import {
  type Run, applyCost, applyGain, chance, heroChips, look, lootChoices, locked, newRun, stat,
  stick, stickerPack, stickerTargets, wear,
} from "./run";
import { type Card, h, overlay, pickCard, stamp, wait } from "./ui";

export const PLACES: Record<string, string> = {
  apartment: "квартира", street: "улица", alley: "переулок", diner: "закусочная", subway: "метро",
  office: "офис", rooftop: "крыша", pawn_shop: "ломбард", warehouse: "склад", parking: "парковка",
  server_room: "серверная", lab: "лаборатория", penthouse: "пентхаус", highway: "шоссе", closeup: "крупный план",
};

const SLOT_NAMES: Record<string, string> = { head: "Голова", top: "Верх", bottom: "Низ", shoes: "Обувь", hand: "Битка" };
const SLOT_ICON: Record<string, string> = { head: "🧢", top: "🧥", bottom: "👖", shoes: "👟", hand: "🏏" };
const WHERE_NAMES = { bat: "на битку", item: "на вещь", cover: "на обложку" };
const MINI_NAMES = { pins: "«Штифты»", flow: "«Поток»" };

const STOP = Symbol("stop");

function sample<T>(a: T[], n: number): T[] {
  const c = [...a], out: T[] = [];
  while (out.length < n && c.length) out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]);
  return out;
}

export interface UI { pages: HTMLElement; hero: HTMLElement; choose: HTMLElement; title: HTMLElement; box: HTMLElement }

export class Game {
  run?: Run;
  comic: Comic;
  over = false;
  private scene: Scene = { bg: "street/day_wide" };
  private gen = 0;
  private boss?: string;
  private cover: HTMLCanvasElement | null = null;

  constructor(private gm: GameManifest, private ui: UI) {
    this.comic = new Comic(ui.pages, (l) => this.cast(l));
  }

  // --- текст и облик ------------------------------------------------------------------------

  /** Подстановки из карт предыстории и рода героя: {origin.day}, {motive.hook}, {нашёл|нашла}. */
  say = (t: string): string => {
    const r = this.run;
    if (!r || !t) return t;
    const or = C.origins[r.origin] as unknown as Record<string, string>, mo = C.motives[r.motive] as unknown as Record<string, string>;
    const s = t.replace(/\{(origin|motive)\.(\w+)\}/g, (_, a, k) => String((a === "origin" ? or : mo)?.[k] ?? ""));
    const f = r.gender === "female";
    return s.replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, m, w) => (f ? w : m));
  };

  private cast(l: Look): Cast {
    return { gm: this.gm, hero: l, npcs: C.world.npcs, places: PLACES, say: this.say };
  }

  private fillShot(s: Shot): Shot {
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "string" ? this.say(v) : v])) as Shot;
  }

  /** Облик героя сейчас: одежда, битка в руке, наклейки на вещах. */
  heroLook(face?: string): Look {
    const r = this.run!;
    const l = look(r, face);
    const sl = C.slammers[r.hand];
    if (sl?.sprite && r.hand !== "fist") l.hand = sl.sprite;
    const decals: Record<string, string> = {};
    for (const [item, st] of Object.entries(r.stickers.items)) {
      const slot = C.items[item]?.slot;
      if (slot && r.outfit[slot] === item) decals[slot] = `stickers/${st}`;
    }
    if (Object.keys(decals).length) l.decals = decals;
    return l;
  }

  private panel(s: Shot): Panel { return shotPanel(this.fillShot(s), this.scene); }

  private live(g: number) { if (g !== this.gen) throw STOP; }

  private async put(p: Panel, g: number, id?: string) {
    await this.comic.place(p, this.heroLook(), id);
    this.live(g);
    await wait(160);
  }

  // --- забег --------------------------------------------------------------------------------

  async start() {
    const g = ++this.gen;
    document.querySelectorAll(".ov").forEach((o) => o.remove());
    document.body.classList.remove("has-ov");
    this.comic.reset();
    this.cover = null; this.over = false; this.boss = undefined;
    this.ui.box.replaceChildren();
    this.ui.title.textContent = "Новый выпуск";
    this.ui.choose.classList.remove("open");
    try {
      const o = await this.startScreen();
      this.live(g);
      this.run = newRun(o);
      try { localStorage.setItem("comix.gender", o.gender); } catch { /* приватный режим */ }
      await this.side();
      preloadTable();
      await this.play(g);
    } catch (e) {
      if (e !== STOP) throw e;
    }
  }

  private async play(g: number) {
    const r = this.run!, w = C.world;
    this.comic.freshPage();
    this.ui.title.textContent = "Пролог";
    for (const s of w.prologue) {
      this.scene = { bg: s.bg || this.scene.bg };
      await this.put(this.panel(s), g);
    }
    for (const ch of w.chapters) {
      this.comic.freshPage();
      for (const [i, beat] of ch.beats.entries()) {
        if (beat.beat === "guardian" && r.hp < Math.ceil(r.max * 0.7)) {
          r.hp = Math.ceil(r.max * 0.7);
          await this.side();
          await stamp(`Перед стражем ты переводишь дух: здоровье ${r.hp}/${r.max}`, true, 1300);
          this.live(g);
        }
        const id = await this.fork(beat, i === 0 ? ch.title : undefined, g);
        const ok = await this.encounter(C.world.encounters[id], g);
        if (!ok || r.hp <= 0) return this.finish(false, g);
      }
    }
    await this.finish(true, g);
  }

  /** Развилка: эскизы встреч из пула бита, игрок выбирает следующий кадр. */
  private async fork(beat: Beat, title: string | undefined, g: number): Promise<string> {
    const r = this.run!;
    const ids = sample(beat.pool, beat.pick);
    const cheat = r.stickers.cover.includes("cheat_sheet");
    const peek = cheat || (r.peek > 0 && ids.length > 1);
    if (peek && !cheat) r.peek--;
    const sketches: Sketch[] = ids.map((id) => {
      const e = C.world.encounters[id];
      const p = shotPanel(this.fillShot(e.sketch), { bg: e.sketch.bg || this.scene.bg, ally: r.ally });
      if (title) p.title = title;
      const foe = e.options.map((o) => o.fight).find(Boolean);
      return {
        panel: p, look: this.heroLook(), label: e.label, tag: KIND_NAMES[e.kind],
        hint: foe ? `${C.enemies[foe].title}, ${C.enemies[foe].hp} здоровья` : undefined,
        more: peek ? this.peekText(e) : undefined,
      };
    });
    this.ui.choose.classList.add("open");
    const pick = this.comic.fork(sketches, this.ui.box, this.ui.title, `${beat.title}: что дальше?`);
    if (peek) this.ui.box.prepend(h("p", { class: "tip" }, cheat ? "Шпаргалка показывает, что ждёт за каждым наброском." : "Подсказка: видно, что ждёт за каждым наброском."));
    const i = await pick;
    this.live(g);
    this.ui.choose.classList.remove("open");
    return ids[i];
  }

  private peekText(e: Encounter) {
    const bits = new Set<string>();
    const outs = (o: OptionDef) => [o.do, o.win, o.lose].filter(Boolean) as Outcome[];
    for (const o of e.options) {
      if (o.fight) bits.add(`бой: ${C.enemies[o.fight].title}`);
      if (o.mini) bits.add(`миниигра ${MINI_NAMES[o.mini.game]}`);
      for (const out of outs(o)) {
        if (out.fight) bits.add(`бой: ${C.enemies[out.fight].title}`);
        if (out.gain?.loot) bits.add("вещь на выбор");
        if (out.gain?.ally) bits.add("союзник");
        if (out.gain?.hp) bits.add("отдых");
        if (out.gain?.sticker) bits.add("наклейки");
        if (out.gain?.props?.length) bits.add("находка в карман");
        if (out.then === "shop") bits.add("лавка");
        if ([out.gain?.flag].flat().includes("hook")) bits.add("личная зацепка");
      }
    }
    if (e.shop) bits.add("лавка");
    return bits.size ? `Внутри: ${[...bits].join(", ")}` : "Внутри: разговор";
  }

  /** Сцена: текст и варианты в боковой панели, эскиз попытки при наведении. */
  private async encounter(e: Encounter, g: number): Promise<boolean> {
    const r = this.run!;
    this.scene = { bg: e.sketch.bg || this.scene.bg, ally: r.ally };
    if (e.kind === "boss") this.boss = e.options.map((o) => o.fight).find(Boolean);
    const { o, id } = await this.options(e, g);
    return this.resolve(e, o, id, g);
  }

  private optionNote(o: OptionDef): string {
    const r = this.run!;
    if (o.fight) return `Бой: ${C.enemies[o.fight].title}`;
    if (o.mini) return `Миниигра ${MINI_NAMES[o.mini.game]} · бросок вместо неё: ${STAT_NAMES[o.mini.stat]} ${chance(r, o)}%`;
    if (o.check) {
      const flaw = Object.keys(o.harder || {}).includes(r.flaw) ? ` · мешает: ${C.flaws[r.flaw].title.toLowerCase()}` : "";
      const help = Object.keys(o.easier || {}).some((k) => r.ally === k) ? " · союзник помогает" : "";
      return `${STAT_NAMES[o.check.stat]} ${stat(r, o.check.stat)} · шанс ${chance(r, o)}%${flaw}${help}`;
    }
    return "";
  }

  private previewShot(o: OptionDef): Shot | undefined {
    if (o.try) return o.try;
    const f = o.fight;
    if (f) return { shot: "fight", with: `enemy:${f}`, with_pose: "attack", hero: "fight", face: "anger" };
    return o.do?.panels?.[0] || o.win?.panels?.[0];
  }

  private options(e: Encounter, g: number): Promise<{ o: OptionDef; id: string }> {
    const r = this.run!;
    const sid = `s${Math.random().toString(36).slice(2, 8)}`;
    this.ui.title.textContent = e.label;
    this.ui.box.replaceChildren();
    this.ui.choose.classList.add("open");
    this.comic.setHint("Что делать?");
    return new Promise((ok) => {
      const list = h("div", { class: "sopts" });
      e.options.forEach((o, i) => {
        const why = locked(r, o.needs);
        const note = this.optionNote(o);
        const id = `${sid}-${i}`;
        const shot = this.previewShot(o);
        const b = h("button", { class: "sopt", disabled: !!why },
          h("b", {}, this.say(o.label)),
          note ? h("span", {}, note) : null,
          why ? h("em", {}, `Закрыто: ${why}`) : null);
        if (shot && !why) {
          const on = () => this.comic.setPreview(this.panel(shot), this.heroLook(), id);
          const off = () => this.comic.setPreview(null);
          b.addEventListener("mouseenter", on); b.addEventListener("focus", on);
          b.addEventListener("mouseleave", off); b.addEventListener("blur", off);
        }
        b.addEventListener("click", () => {
          if (g !== this.gen) return;
          this.comic.setPreview(null); this.comic.setHint("");
          this.ui.box.replaceChildren();
          this.ui.title.textContent = "…";
          this.ui.choose.classList.remove("open");
          ok({ o, id: o.try ? id : `${sid}-x${i}` });
        });
        list.append(b);
      });
      this.ui.box.append(h("p", { class: "scene-text" }, this.say(e.text)), list);
      (list.querySelector("button:not([disabled])") as HTMLButtonElement | null)?.focus({ preventScroll: true });
    });
  }

  private async resolve(e: Encounter, o: OptionDef, tryId: string, g: number): Promise<boolean> {
    const r = this.run!;
    if (o.fight) {
      if (!(await this.battle(o.fight, g))) return false;
      return this.outcome(o.win, e, g);
    }
    if (o.mini) return this.outcome((await this.mini(o, g)) ? o.win : o.lose, e, g);
    if (o.check) {
      if (o.try) await this.put(this.panel(o.try), g, tryId);
      const p = chance(r, o);
      const name = STAT_NAMES[o.check.stat];
      let win = Math.random() * 100 < p;
      await stamp(`${name}: ${p}%… ${win ? "Успех!" : "Не вышло"}`, win);
      this.live(g);
      let crossed = false;
      if (!win && r.ink > 0) {
        const i = await pickCard("Не вышло", "Можно перерисовать этот кадр чернилами и бросить ещё раз. Звезда обложки «без перерисовок» тогда пропадёт.", [
          { title: "Перерисовать", tag: `${p}%`, body: `−1 чернило, останется ${r.ink - 1}` },
          { title: "Оставить как есть", body: "Комикс пойдёт дальше с этой неудачей" },
        ]);
        this.live(g);
        if (i === 0) {
          r.ink--; r.stats.inkSpent++; crossed = true;
          win = Math.random() * 100 < p;
          await this.side();
          await stamp(`Ещё раз: ${p}%… ${win ? "Успех!" : "Снова мимо"}`, win);
          this.live(g);
        }
      }
      return this.outcome(win ? o.win : o.lose, e, g, crossed);
    }
    return this.outcome(o.do, e, g);
  }

  private snap() {
    const r = this.run!;
    return { hp: r.hp, coins: r.coins, ink: r.ink, ally: r.ally, props: [...r.props], peek: r.peek };
  }

  private async report(b: ReturnType<Game["snap"]>) {
    const r = this.run!, out: string[] = [];
    const d = (n: number, word: string) => { if (n) out.push(`${word} ${n > 0 ? "+" : "−"}${Math.abs(n)}`); };
    d(r.hp - b.hp, "здоровье"); d(r.coins - b.coins, "монеты"); d(r.ink - b.ink, "чернила");
    if (r.ally && r.ally !== b.ally) out.push(`союзник: ${C.world.npcs[r.ally]?.name}`);
    for (const p of r.props) if (!b.props.includes(p)) out.push(`в карман: ${thingTitle(p).toLowerCase()}`);
    if (r.peek > b.peek) out.push("подсказка на развилке");
    await this.side();
    if (out.length) await stamp(out.join(" · "), r.hp >= b.hp && r.coins >= b.coins, 1000);
  }

  /** Итог варианта: кадры, потери и находки, лут, наклейки, бой, следующий итог. */
  private async outcome(out: Outcome | undefined, e: Encounter, g: number, crossed = false): Promise<boolean> {
    if (!out) return true;
    const r = this.run!;
    const before = this.snap();
    applyCost(r, out.cost);
    const panels = (out.panels || []).map((s) => this.panel(s));
    if (crossed && panels[0]) panels[0].crossed = true;
    for (const p of panels) await this.put(p, g);
    applyGain(r, out.gain);
    this.scene.ally = r.ally;
    await this.report(before);
    this.live(g);
    if (r.hp <= 0) return false;
    for (let i = 0; i < (out.gain?.loot || 0); i++) await this.loot(g);
    if (out.gain?.sticker) await this.stickers(out.gain.sticker, g);
    if (out.fight && !(await this.battle(out.fight, g))) return false;
    if (out.then === "shop") await this.shop(e, g);
    else if (out.then) return this.outcome(C.world.outcomes[out.then], e, g);
    return r.hp > 0;
  }

  private async battle(enemyId: string, g: number): Promise<boolean> {
    const r = this.run!;
    this.ui.title.textContent = "Бой!";
    const res = await fight(this.gm, r, enemyId);
    this.live(g);
    const b = res.battle;
    r.stats.fights++;
    const taken = b.log.reduce((s, l) => s + l.taken, 0);
    r.stats.taken += taken;
    r.hp = Math.max(0, b.hero.hp);
    r.ink += b.gain.ink; r.coins += b.gain.coins;
    await this.side();
    for (const p of battlePanels(res, this.scene)) await this.put(p, g);
    if (!res.win) return false;
    // после победы герой отдышался: возвращается половина полученного в бою урона
    const before = this.snap();
    r.hp = Math.min(r.max, r.hp + Math.max(3, Math.ceil(taken / 2)));
    await this.report(before);
    return true;
  }

  private async mini(o: OptionDef, g: number): Promise<boolean> {
    const r = this.run!, m = o.mini!;
    const p = chance(r, o), name = STAT_NAMES[m.stat];
    const res = m.game === "pins"
      ? await playPins({
        pins: 2 + m.diff,
        picks: 4 + Math.floor(stat(r, "agi") / 2) + (r.props.includes("lockpicks") ? 2 : 0),
        probes: 1 + (stat(r, "wit") >= 3 ? 1 : 0),
        skipChance: p, skipStat: name,
      })
      : await playFlow({ w: 5, h: 4, slack: 4 + (stat(r, "wit") >= 3 ? 2 : 0), skipChance: p, skipStat: name });
    this.live(g);
    if (res.skipped) r.stats.skipped++; else r.stats.played++;
    return res.win;
  }

  // --- вещи и наклейки ----------------------------------------------------------------------

  private itemCard(id: string): Card {
    const r = this.run!;
    const it = C.items[id], sl = C.slammers[id];
    if (sl) {
      const now = C.slammers[r.hand]?.title || "Кулак";
      return {
        title: sl.title, tag: "Битка", icon: document.createTextNode(SLOT_ICON.hand),
        body: `Лёгкий ${sl.light.join("–")}, сильный ${sl.strong.join("–")}. ${sl.note || ""} Вместо: ${now}.`,
      };
    }
    const chips = it.chips.map((c) => chipLabel(c)).join(", ");
    const st = Object.entries(it.stats || {}).map(([k, v]) => `${STAT_NAMES[k as keyof typeof STAT_NAMES]} ${v! > 0 ? "+" : ""}${v}`).join(", ");
    const now = r.outfit[it.slot] ? C.items[r.outfit[it.slot]]?.title : "ничего";
    return {
      title: it.title,
      tag: [SLOT_NAMES[it.slot], it.set, it.rarity === "rare" ? "редкая" : ""].filter(Boolean).join(" · "),
      icon: document.createTextNode(SLOT_ICON[it.slot] || "🎁"),
      body: `Фишки: ${chips}${st ? `. ${st}` : ""}. Вместо: ${now}.`,
    };
  }

  private async loot(g: number) {
    const r = this.run!;
    const ids = lootChoices(r, 3);
    if (!ids.length) return;
    const i = await pickCard("Находка: возьми одну вещь", "Вещь сразу надевается и кладёт свои фишки в стопку боя. Старая уходит в рюкзак.", ids.map((id) => this.itemCard(id)), "Ничего не брать");
    this.live(g);
    if (i < 0) return;
    wear(r, ids[i]);
    await this.side();
    await this.put(lootPanel(ids[i], this.scene), g);
  }

  private async shop(e: Encounter, g: number) {
    const r = this.run!, cfg = e.shop || { count: 3, price: [4, 9] as [number, number] };
    const ids = lootChoices(r, cfg.count);
    const half = r.flags.includes("discount");
    const prices = ids.map(() => {
      const p = cfg.price[0] + Math.floor(Math.random() * (cfg.price[1] - cfg.price[0] + 1));
      return half ? Math.ceil(p / 2) : p;
    });
    while (ids.length) {
      const cards = ids.map((id, k) => ({ ...this.itemCard(id), tag: `${prices[k]} ¤`, disabled: r.coins < prices[k] ? `нужно ${prices[k]} монет` : undefined }));
      const i = await pickCard(e.label, `У тебя ${r.coins} монет${half ? ", скидка вдвое" : ""}.`, cards, "Уйти");
      this.live(g);
      if (i < 0) break;
      r.coins -= prices[i];
      wear(r, ids[i]);
      await this.side();
      await this.put(lootPanel(ids[i], this.scene), g);
      ids.splice(i, 1); prices.splice(i, 1);
    }
  }

  private stickerIcon(id: string): Node {
    const src = this.gm.sprites.stickers?.[id]?.src;
    if (src) return h("img", { src: `${import.meta.env.BASE_URL}assets/${src}`, alt: "" });
    return h("span", { class: "stk-ico" }, STICKER_ICON[id] || "★");
  }

  /** Пачка наклеек: берёшь одну и решаешь, куда её наклеить. */
  private async stickers(n: number, g: number) {
    const r = this.run!;
    const pack = stickerPack(r, n);
    if (!pack.length) return;
    const i = await pickCard(`Пачка наклеек: одна из ${pack.length}`, "Наклейка действует до конца забега. Место решает, что она делает.",
      pack.map((id) => ({ title: C.stickers[id].title, tag: WHERE_NAMES[C.stickers[id].where], body: C.stickers[id].text, icon: this.stickerIcon(id) })),
      "Не брать");
    this.live(g);
    if (i < 0) return;
    const id = pack[i], st = C.stickers[id];
    const targets = stickerTargets(r, id);
    if (!targets.length) { if (!r.album.includes(id)) r.album.push(id); return; }
    let where = targets[0].key;
    if (targets.length > 1 || targets[0].now) {
      const j = await pickCard(`Куда наклеить «${st.title}»?`, st.text,
        targets.map((t) => ({ title: t.label, body: t.now ? `Заменит «${C.stickers[t.now].title}»` : "Место свободно" })),
        "Оставить в альбоме");
      this.live(g);
      if (j < 0) { if (!r.album.includes(id)) r.album.push(id); return; }
      where = targets[j].key;
    }
    stick(r, id, where);
    await this.side();
    await stamp(`Наклейка «${st.title}» ${WHERE_NAMES[st.where]}`, true, 900);
  }

  // --- конец выпуска и обложка --------------------------------------------------------------

  private async finish(win: boolean, g: number) {
    const r = this.run!;
    this.comic.setHint("");
    this.comic.closing();
    await this.put({ end: true, caption: win ? C.world.ending.win : C.world.ending.lose }, g);
    this.comic.fit(this.comic.last());
    this.over = true;
    const info = coverInfo(r, win);
    const cover = await drawCover(this.cast(this.heroLook()), r, info, { bg: this.scene.bg, boss: this.boss, win });
    this.live(g);
    this.cover = cover;
    cover.className = "page";
    cover.setAttribute("role", "img");
    cover.setAttribute("aria-label", `Обложка выпуска: ${info.paper.toLowerCase()}, звёзд ${info.count} из 5`);
    const wrap = h("div", { class: "cover-wrap", "data-tier": String(info.tier) }, cover, h("div", { class: "holo", "aria-hidden": "true" }));
    holo(wrap);
    this.ui.pages.prepend(wrap);
    this.ui.title.textContent = win ? "Выпуск готов" : "Выпуск окончен";
    this.ui.box.replaceChildren(
      h("p", { class: "scene-text" }, `Обложка: ${info.paper.toLowerCase()}. Сохранность ${info.grade}/10: за выпуск получено ${r.stats.taken} урона.`),
      h("ul", { class: "stars" }, ...info.stars.map((s) => h("li", { class: s.ok ? "ok" : "" }, `${s.ok ? "★" : "☆"} ${s.text}`))),
      h("div", { class: "row" },
        h("button", { onclick: () => void this.saveComic() }, "Скачать выпуск"),
        h("button", { class: "ghost", onclick: () => wrap.scrollIntoView({ behavior: "smooth", block: "start" }) }, "К обложке"),
        h("button", { class: "ghost", onclick: () => void this.start() }, "Новый выпуск")),
    );
    this.ui.choose.classList.add("open");
    setTimeout(() => wrap.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
  }

  savePage() {
    const p = this.comic.last();
    if (p) download(this.comic.exportPage(p), `comix-page-${this.comic.pages.length}.png`);
  }

  async saveComic() {
    await this.comic.settle();
    const list = [...(this.cover ? [this.cover] : []), ...this.comic.pages.filter((p) => p.panels.length).map((p) => this.comic.exportPage(p))];
    if (!list.length) return;
    const gap = 40;
    const cv = h("canvas", { width: String(PAGE_W + gap * 2), height: String(list.length * PAGE_H + (list.length + 1) * gap) });
    const x = cv.getContext("2d")!;
    x.fillStyle = "#23232b"; x.fillRect(0, 0, cv.width, cv.height);
    list.forEach((c, i) => x.drawImage(c, gap, gap + i * (PAGE_H + gap)));
    download(cv, "comix-vypusk.png");
  }

  // --- боковая карточка героя ---------------------------------------------------------------

  async side() {
    const r = this.run;
    if (!r) return;
    const l = this.heroLook();
    const doll = (await composeDoll(this.gm, l, "idle")) || mannequin(this.gm, "idle", skinHexOf(this.gm, r.skin), "#d65a4a");
    const cv = h("canvas", { width: String(doll.width), height: String(doll.height), role: "img", "aria-label": "Герой" });
    cv.getContext("2d")!.drawImage(doll, 0, 0);
    const chips = heroChips(r);
    const sl = C.slammers[r.hand] || C.slammers.fist;
    const stk = [
      ...r.stickers.bat.map((id) => `${STICKER_ICON[id]} ${C.stickers[id].title} (битка)`),
      ...Object.entries(r.stickers.items).map(([it, id]) => `${STICKER_ICON[id]} ${C.stickers[id].title} (${C.items[it]?.title.toLowerCase()})`),
      ...r.stickers.cover.map((id) => `${STICKER_ICON[id]} ${C.stickers[id].title} (обложка)`),
    ];
    this.ui.hero.replaceChildren(
      cv,
      h("div", { class: "hero-info" },
        h("b", { class: "hero-name" }, this.say(C.origins[r.origin].title)),
        h("div", { class: "muted" }, `${C.motives[r.motive].title} · ${C.flaws[r.flaw].title.toLowerCase()}`),
        h("div", { class: "meters" },
          h("span", { class: "m hp", title: "Здоровье" }, `❤ ${r.hp}/${r.max}`),
          h("span", { class: "m", title: "Чернила: перерисовать неудачу" }, `✒ ${r.ink}`),
          h("span", { class: "m", title: "Монеты" }, `¤ ${r.coins}`)),
        h("div", { class: "stats" }, ...STATS.map((s) => h("span", {}, `${STAT_NAMES[s]} `, h("b", {}, String(stat(r, s)))))),
        h("div", { class: "label" }, "Битка"),
        h("div", {}, `${sl.title}: лёгкий ${sl.light.join("–")}, сильный ${sl.strong.join("–")}`),
        h("div", { class: "label" }, `Фишки в бою (${chips.length})`),
        h("div", { class: "pogs" }, ...chips.map((c) => h("span", { class: "mini-pog", title: c.name }, chipLabel(c)))),
        r.ally ? h("div", { class: "label" }, "Союзник") : null,
        r.ally ? h("div", {}, C.world.npcs[r.ally]?.name || r.ally) : null,
        r.props.length ? h("div", { class: "label" }, "Карманы") : null,
        r.props.length ? h("div", {}, r.props.map(thingTitle).join(", ")) : null,
        stk.length ? h("div", { class: "label" }, "Наклейки") : null,
        stk.length ? h("div", { class: "stk" }, ...stk.map((t) => h("span", {}, t))) : null,
      ),
    );
  }

  // --- стартовый экран ----------------------------------------------------------------------

  private startScreen(): Promise<{ gender: string; skin: string; origin: string; motive: string; flaw: string }> {
    return new Promise((ok) => {
      const ov = overlay("start");
      const origins = sample(Object.keys(C.origins), 3);
      const motives = sample(Object.keys(C.motives), 3);
      const flaws = sample(Object.keys(C.flaws), 2);
      const skins = Object.keys(this.gm.doll?.skins || { pale: "", light: "", medium: "", tan: "", dark: "", deep: "" });
      let gender = "male";
      try { gender = localStorage.getItem("comix.gender") || "male"; } catch { /* ок */ }
      const sel = { gender, skin: skins[Math.floor(Math.random() * skins.length)], origin: origins[0], motive: motives[0], flaw: flaws[0] };
      const pv = h("div", { class: "st-doll" });
      const body = h("div", { class: "st-body" });
      const fake = () => ({ ...newRun(sel) });
      const say = (t: string) => {
        const f = sel.gender === "female";
        return t.replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, m, w) => (f ? w : m));
      };
      const originBody = (id: string) => {
        const o = C.origins[id];
        const bits = Object.entries(o.stats || {}).map(([k, v]) => `${STAT_NAMES[k as keyof typeof STAT_NAMES]} +${v}`);
        if (o.hp) bits.push(`здоровье +${o.hp}`);
        if (o.ink) bits.push(`чернила +${o.ink}`);
        if (o.coins) bits.push(`монеты +${o.coins}`);
        if (o.hand) bits.push(`битка: ${C.slammers[o.hand]?.title.toLowerCase()}`);
        for (const p of o.props || []) bits.push(`с собой: ${thingTitle(p).toLowerCase()}`);
        return bits.join(" · ");
      };
      const group = (label: string, ids: string[], key: "origin" | "motive" | "flaw", title: (id: string) => string, text: (id: string) => string) =>
        h("fieldset", { class: "st-group" }, h("legend", {}, label),
          h("div", { class: "st-cards" }, ...ids.map((id) => h("button", {
            class: "st-card", "aria-pressed": String(sel[key] === id),
            onclick: () => { sel[key] = id; render(); },
          }, h("b", {}, say(title(id))), h("span", {}, say(text(id)))))));
      async function doll(gm: GameManifest) {
        const o = C.origins[sel.origin];
        const l: Look = { gender: sel.gender, skin: sel.skin, outfit: { ...o.outfit } };
        const d = (await composeDoll(gm, l, "idle")) || mannequin(gm, "idle", skinHexOf(gm, sel.skin), "#d65a4a");
        const cv = h("canvas", { width: String(d.width), height: String(d.height), role: "img", "aria-label": "Твой герой" });
        cv.getContext("2d")!.drawImage(d, 0, 0);
        pv.replaceChildren(cv);
      }
      const render = () => {
        const run = fake();
        body.replaceChildren(
          h("div", { class: "st-row" },
            h("div", { class: "seg", role: "group", "aria-label": "Герой" },
              ...[["male", "Он"], ["female", "Она"]].map(([g, t]) => h("button", { "aria-pressed": String(sel.gender === g), onclick: () => { sel.gender = g; render(); } }, t))),
            h("div", { class: "swatches", role: "group", "aria-label": "Тон кожи" },
              ...skins.map((s) => h("button", {
                class: "sw", "aria-pressed": String(sel.skin === s), "aria-label": s, title: s,
                style: { background: skinHexOf(this.gm, s) }, onclick: () => { sel.skin = s; render(); },
              })))),
          group("Кем ты был" + (sel.gender === "female" ? "а" : ""), origins, "origin", (id) => C.origins[id].title, originBody),
          group("Что тебя ведёт", motives, "motive", (id) => C.motives[id].title, (id) => C.motives[id].taken),
          group("Твоя слабость", flaws, "flaw", (id) => C.flaws[id].title, (id) => `${C.flaws[id].text}. Зато +1 чернило.`),
          h("p", { class: "tip" }, `Старт: здоровье ${run.max}, чернила ${run.ink}, монеты ${run.coins}. Чернила перерисовывают неудачный бросок или удар.`),
          h("div", { class: "row" },
            h("button", { class: "go", onclick: () => { ov.close(); ok(sel); } }, "Начать выпуск"),
            h("button", {
              class: "ghost", onclick: () => {
                sel.origin = origins[Math.floor(Math.random() * 3)];
                sel.motive = motives[Math.floor(Math.random() * 3)];
                sel.flaw = flaws[Math.floor(Math.random() * 2)];
                ov.close(); ok(sel);
              },
            }, "Удиви меня")),
        );
        void doll(this.gm);
        try { localStorage.setItem("comix.gender", sel.gender); } catch { /* ок */ }
      };
      ov.box.append(h("h2", {}, "Новый выпуск: кто ты?"), h("div", { class: "st-grid" }, pv, body));
      render();
      (ov.box.querySelector(".go") as HTMLButtonElement | null)?.focus();
    });
  }
}

/** Блик голограммы ходит за мышью или наклоном телефона. */
function holo(wrap: HTMLElement) {
  const set = (x: number, y: number) => {
    wrap.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    wrap.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
  };
  wrap.addEventListener("pointermove", (e) => {
    const r = wrap.getBoundingClientRect();
    set((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  wrap.addEventListener("pointerleave", () => set(0.5, 0.5));
  window.addEventListener("deviceorientation", (e) => {
    if (!wrap.isConnected || e.gamma === null || e.beta === null) return;
    set(Math.min(1, Math.max(0, 0.5 + e.gamma / 60)), Math.min(1, Math.max(0, 0.5 + (e.beta - 40) / 60)));
  });
  set(0.5, 0.5);
}

function download(cv: HTMLCanvasElement, name: string) {
  cv.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
}

