// Бой на фишках: общая стопка твоих и вражьих фишек. За ход выбираешь силу удара битки.
// Перевёрнутые твои фишки срабатывают каскадом, перевёрнутые вражьи ты забираешь.
// Верхняя вражья фишка с приёмом это план врага на этот ход, он виден заранее.
// Логика без DOM, чтобы её можно было проверять отдельно.

import type { EnemyChipDef, EnemyDef, SlammerDef } from "./content";

export interface Chip {
  id: number;
  owner: "hero" | "enemy";
  act: string;
  n: number;
  times?: number;
  name: string;
  item?: string;   // из какой вещи фишка героя
  set?: string;
}

export interface Stickers { bat: string[]; items: Record<string, string>; cover: string[] }

export type Power = "light" | "strong";

export interface Ev {
  kind: "chip" | "capture" | "trap" | "enemy" | "miss" | "phase" | "stun" | "knock" | "info";
  text: string;
  sfx?: string;
  chip?: Chip;
  dmg?: number;    // урон врагу (chip) или герою (enemy, trap)
}

export interface Strike {
  round: number;
  power: Power;
  flipped: number;
  ids: number[];
  events: Ev[];
  dealt: number;
  taken: number;
}

export interface Battle {
  enemyId: string;
  def: EnemyDef;
  slammer: SlammerDef;
  stickers: Stickers;
  stack: Chip[];                // сверху вниз
  hero: { hp: number; max: number; block: number; dodge: number };
  enemy: { hp: number; max: number; shield: number; rage: number; stunned: boolean; phase: number };
  captured: Chip[];
  knocked: string[];
  round: number;
  log: Strike[];
  over: null | "win" | "lose";
  luckyUsed: boolean;
  gain: { ink: number; coins: number };
  nextId: number;
}

export type Rng = () => number;

export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: Rng, a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

function enemyChip(d: EnemyChipDef, id: number): Chip {
  return { id, owner: "enemy", act: d.act, n: d.n ?? 0, times: d.times, name: d.name };
}

export function newBattle(o: {
  enemyId: string; def: EnemyDef; heroChips: Omit<Chip, "id" | "owner">[]; hp: number; max: number;
  slammer: SlammerDef; stickers: Stickers; rng: Rng; alarmed?: boolean;
}): Battle {
  let id = 1;
  const hero: Chip[] = o.heroChips.map((c) => ({ ...c, id: id++, owner: "hero" as const }));
  const foes = o.def.chips.map((d) => enemyChip(d, id++));
  // вражьи фишки в случайном порядке, ловушки поглубже
  foes.sort(() => o.rng() - 0.5).sort((a, b) => Number(a.act === "trap") - Number(b.act === "trap"));
  const stack: Chip[] = [];
  const H = hero.length, E = foes.length, total = H + E;
  // вражьи фишки равномерно между твоими, сверху всегда твоя
  const at = new Set(foes.map((_, k) => Math.min(total - 1, Math.round(((k + 1) * total) / (E + 1)))));
  let hi = 0, ei = 0;
  for (let i = 0; i < total; i++) {
    if ((at.has(i) && ei < E) || hi >= H) stack.push(foes[ei++]);
    else stack.push(hero[hi++]);
  }
  const hp = o.def.hp + (o.alarmed ? 3 : 0);
  return {
    enemyId: o.enemyId, def: o.def, slammer: o.slammer, stickers: o.stickers, stack,
    hero: { hp: o.hp, max: o.max, block: 0, dodge: 0 },
    enemy: { hp, max: hp, shield: 0, rage: 0, stunned: false, phase: 1 },
    captured: [], knocked: [], round: 1, log: [], over: null, luckyUsed: false,
    gain: { ink: 0, coins: 0 }, nextId: id,
  };
}

/** План врага: верхняя вражья фишка с приёмом (не ловушка). */
export function intentIndex(b: Battle): number {
  return b.stack.findIndex((c) => c.owner === "enemy" && c.act !== "trap");
}

export function intentText(b: Battle): string {
  if (b.enemy.stunned) return "Оглушён, пропустит ход";
  const i = intentIndex(b);
  if (i < 0) return `Удар ${2 + b.enemy.rage} как попало`;
  const c = b.stack[i];
  const rage = c.act === "hit" && b.enemy.rage ? ` (+${b.enemy.rage})` : "";
  return `${c.name}: ${moveText(c)}${rage}`;
}

function moveText(c: Chip) {
  switch (c.act) {
    case "hit": return `удар ${c.n}${c.times && c.times > 1 ? ` ×${c.times}` : ""}`;
    case "shield": return `щит ${c.n}`;
    case "heal": return `лечится на ${c.n}`;
    case "rage": return `удары +${c.n}`;
    case "knock": return "выбьет вещь";
    default: return c.act;
  }
}

function range(b: Battle, p: Power): [number, number] {
  const [a, z] = p === "light" ? b.slammer.light : b.slammer.strong;
  const flame = p === "strong" && b.stickers.bat.includes("flame") ? 1 : 0;
  return [a + flame, z + flame];
}

/** Шанс перевернуть каждую фишку стопки (по позиции) при таком ударе. */
export function flipChances(b: Battle, p: Power): number[] {
  const [a, z] = range(b, p);
  const n = z - a + 1;
  const out = b.stack.map((_, i) => {
    let k = 0;
    for (let v = a; v <= z; v++) if (v > i) k++;
    return k / n;
  });
  if (p === "strong" && b.slammer.bottom && out.length) out[out.length - 1] = 1;
  return out;
}

/** Видна ли фишка игроку: свои всегда, верхние две, план врага, и все с «Глазом». */
export function visible(b: Battle, i: number): boolean {
  const c = b.stack[i];
  return c.owner === "hero" || i < 2 || i === intentIndex(b) || b.stickers.cover.includes("eye");
}

function heroWorth(b: Battle, c: Chip) {
  switch (c.act) {
    case "hit": return c.n + (b.slammer.hit_bonus || 0);
    case "heal": return Math.min(c.n, b.hero.max - b.hero.hp) * 0.8;
    case "stun": return 3;
    default: return 2;
  }
}

/** Ожидаемая польза удара: ловушка обрывает каскад, поэтому глубокий удар рискованнее. */
export function expected(b: Battle, p: Power): number {
  const [a, z] = range(b, p);
  const intent = intentIndex(b);
  const hidden = b.stack.filter((c, i) => c.owner === "enemy" && !visible(b, i));
  const pTrap = hidden.length ? hidden.filter((c) => c.act === "trap").length / hidden.length : 0;
  const trapN = 3;
  let total = 0;
  for (let k = a; k <= z; k++) {
    const idx = [...Array(Math.min(k, b.stack.length)).keys()];
    if (p === "strong" && b.slammer.bottom && b.stack.length > k) idx.push(b.stack.length - 1);
    let alive = 1, v = 0;
    for (const i of idx) {
      const c = b.stack[i];
      if (c.owner === "hero") { v += alive * heroWorth(b, c); continue; }
      if (visible(b, i)) {
        if (c.act === "trap") { v -= alive * (c.n + 2); alive = 0; break; }
        v += alive * (3 + (i === intent ? 3 : 0));
      } else {
        v += alive * ((1 - pTrap) * 3 - pTrap * (trapN + 2));
        alive *= 1 - pTrap;
      }
    }
    total += v;
  }
  let ev = total / (z - a + 1);
  // план врага: лёгкий удар успевает его отменить, сильный пропускает удар первым
  const incoming = intentDamage(b);
  if (p === "light") {
    const ch = flipChances(b, "light");
    ev -= incoming * (1 - (intent >= 0 ? ch[intent] : 0));
  } else ev -= incoming * 1.15;
  return ev;
}

/** Сколько урона принесёт план врага, если его не отменить. */
export function intentDamage(b: Battle): number {
  if (b.enemy.stunned) return 0;
  const i = intentIndex(b);
  if (i < 0) return 2 + b.enemy.rage;
  const c = b.stack[i];
  if (c.act === "hit") return (c.n + b.enemy.rage) * (c.times || 1);
  if (c.act === "knock") return 4;
  return 1.5;
}

/** Что выбрал бы игрок «на автомате»: прикидка по нескольким броскам каждого удара. */
export function autoPower(b: Battle): Power {
  const score = (p: Power) => {
    const rng = seeded(b.round * 977 + b.stack.length * 31 + b.hero.hp);
    let s = 0;
    for (let t = 0; t < 24; t++) {
      const r = strike(b, p, rng);
      s += r.enemy.max - r.enemy.hp - (b.enemy.max - b.enemy.hp)
        - 1.2 * (b.hero.hp - r.hero.hp) + 2 * (r.captured.length - b.captured.length)
        + (r.over === "win" ? 20 : 0) - (r.over === "lose" ? 40 : 0);
    }
    return s;
  };
  return score("strong") > score("light") ? "strong" : "light";
}

const HIT_SFX = ["БАХ!", "БУМ!", "ХРЯСЬ!", "ТРАХ!", "БАМ!"];

/** Удар героя и ответ врага. Возвращает новое состояние, старое не меняется. */
export function strike(prev: Battle, p: Power, rng: Rng): Battle {
  const b: Battle = structuredClone(prev);
  if (b.over) return b;
  const log: Strike = { round: b.round, power: p, flipped: 0, ids: [], events: [], dealt: 0, taken: 0 };
  const ev = (e: Ev) => log.events.push(e);
  // сильный замах долгий: враг успевает ударить первым
  if (p === "strong") {
    ev({ kind: "info", text: "Сильный замах: враг бьёт первым" });
    enemyTurn(b, log, rng);
    if (b.hero.hp <= 0) return finish(b, log);
  }
  const [a, z] = range(b, p);
  const k = Math.min(b.stack.length, randInt(rng, a, z));
  const idx = new Set<number>();
  for (let i = 0; i < k; i++) idx.add(i);
  if (p === "strong" && b.slammer.bottom && b.stack.length) idx.add(b.stack.length - 1);
  const flipped = b.stack.filter((_, i) => idx.has(i));
  b.stack = b.stack.filter((_, i) => !idx.has(i));
  log.flipped = flipped.length;
  log.ids = flipped.map((c) => c.id);

  // каскад: фишки вещей с «Молнией» первыми
  const fast = (c: Chip) => c.owner === "hero" && !!c.item && b.stickers.items[c.item] === "lightning";
  const cascade = [...flipped.filter(fast), ...flipped.filter((c) => !fast(c))];
  let double = false, prevSet: string | undefined;
  const recycled: Chip[] = [];

  const hurtEnemy = (dmg: number) => {
    const blocked = Math.min(b.enemy.shield, dmg);
    b.enemy.shield -= blocked;
    const d = dmg - blocked;
    b.enemy.hp = Math.max(0, b.enemy.hp - d);
    log.dealt += d;
    return [d, blocked];
  };

  let broken = false;
  for (const c of cascade) {
    if (broken) { recycled.push(c); continue; }
    if (c.owner === "enemy") {
      if (c.act === "trap") {
        const dmg = Math.max(0, c.n - b.hero.block);
        b.hero.block = Math.max(0, b.hero.block - c.n);
        b.hero.hp -= dmg;
        log.taken += dmg;
        recycled.push(c);
        broken = cascade.indexOf(c) < cascade.length - 1;
        ev({ kind: "trap", chip: c, dmg, text: `Ловушка «${c.name}»: −${dmg}${broken ? ", каскад оборван" : ""}`, sfx: "ОЙ!" });
      } else {
        b.captured.push(c);
        ev({ kind: "capture", chip: c, text: `Забираешь «${c.name}»`, sfx: "ЦАП!" });
        if (b.slammer.stun_capture) { b.enemy.stunned = true; ev({ kind: "stun", text: "Шокер: враг оглушён", sfx: "ВЗЗ!" }); }
        if (b.stickers.cover.includes("piggy_bank")) b.gain.coins += 1;
      }
      prevSet = undefined;
      continue;
    }
    const times = !b.luckyUsed && b.stickers.bat.includes("lucky_star") ? 2 : 1;
    b.luckyUsed = true;
    const setBonus = c.set && c.set === prevSet ? 1 : 0;
    prevSet = c.set;
    const sticker = c.item ? b.stickers.items[c.item] : undefined;
    for (let t = 0; t < times; t++) {
      let v = c.n + setBonus;
      const tag = (setBonus ? " (сет +1)" : "") + (times > 1 ? " (звезда)" : "");
      switch (c.act) {
        case "hit": {
          v += b.slammer.hit_bonus || 0;
          if (sticker === "skull") { v += 3; b.hero.hp -= 1; log.taken += 1; }
          let mult = "";
          if (double) { v *= 2; double = false; mult = "×2 "; }
          const [d, blocked] = hurtEnemy(v);
          const big = v >= 8 ? "БА-БАХ!!" : HIT_SFX[(c.id + t) % HIT_SFX.length];
          ev({ kind: "chip", chip: c, dmg: d, text: `${mult}Удар ${v}${blocked ? `, щит снял ${blocked}` : ""}${tag}`, sfx: mult ? `×2 ${big}` : big });
          break;
        }
        case "block": b.hero.block += v; ev({ kind: "chip", chip: c, text: `Блок ${v}${tag}`, sfx: "ДЗЫНЬ!" }); break;
        case "dodge": b.hero.dodge += 1; ev({ kind: "chip", chip: c, text: `Уворот${tag}`, sfx: "ВЖУХ!" }); break;
        case "heal": b.hero.hp = Math.min(b.hero.max, b.hero.hp + v); ev({ kind: "chip", chip: c, text: `Лечение ${v}${tag}`, sfx: "ФУХ!" }); break;
        case "double": double = true; ev({ kind: "chip", chip: c, text: `×2 к следующему удару${tag}`, sfx: "ОП!" }); break;
        case "stun": b.enemy.stunned = true; ev({ kind: "chip", chip: c, text: `Оглушение${tag}`, sfx: "БДЫЩ!" }); break;
        case "ink": b.gain.ink += 1; ev({ kind: "chip", chip: c, text: "+1 чернило", sfx: "КАП!" }); break;
        case "coin": b.gain.coins += v; ev({ kind: "chip", chip: c, text: `+${v} монет`, sfx: "ДЗИНЬ!" }); break;
      }
      if (sticker === "bandage") b.hero.hp = Math.min(b.hero.max, b.hero.hp + 1);
    }
    recycled.push(c);
  }
  // сработавшие фишки уходят под низ стопки; «Жвачка» возвращает лучшую наверх
  const gum = b.stickers.bat.includes("gum") ? pickBest(recycled.filter((c) => c.owner === "hero")) : undefined;
  b.stack.push(...recycled.filter((c) => c !== gum));
  if (gum) { b.stack.unshift(gum); ev({ kind: "info", text: `Жвачка: «${chipName(gum)}» снова наверху` }); }
  if (p === "light" && b.slammer.light_block) b.hero.block += b.slammer.light_block;
  b.enemy.shield = 0;

  if (b.enemy.hp <= 0) {
    b.over = "win";
  } else {
    // вторая фаза стража
    const ph = b.def.phase2;
    if (ph && b.enemy.phase === 1 && b.enemy.hp <= ph.at) {
      b.enemy.phase = 2;
      ph.add.forEach((d, i) => b.stack.splice(Math.min(b.stack.length, 1 + i * 2), 0, enemyChip(d, b.nextId++)));
      ev({ kind: "phase", text: ph.say || "Вторая фаза!", sfx: "ГРР!" });
    }
    if (p === "light") enemyTurn(b, log, rng);
  }
  return finish(b, log);
}

function finish(b: Battle, log: Strike): Battle {
  b.hero.block = 0;
  b.hero.dodge = 0;
  b.enemy.shield = Math.min(b.enemy.shield, 99);
  if (b.hero.hp <= 0 && !b.over) { b.hero.hp = 0; b.over = "lose"; }
  else if (b.hero.hp <= 0) b.hero.hp = 1;  // победный удар не убивает героя
  b.log.push(log);
  b.round++;
  return b;
}

function pickBest(cs: Chip[]) {
  return cs.sort((x, y) => (y.act === "hit" ? y.n : 1) - (x.act === "hit" ? x.n : 1))[0];
}

export function chipName(c: Chip) {
  return c.owner === "enemy" ? c.name : c.name || c.act;
}

function enemyTurn(b: Battle, log: Strike, _rng: Rng) {
  const ev = (e: Ev) => log.events.push(e);
  const sfx = b.def.sfx || ["БАХ!"];
  if (b.enemy.stunned) {
    b.enemy.stunned = false;
    ev({ kind: "stun", text: `${b.def.title} оглушён и пропускает ход`, sfx: "ЗВЁЗДОЧКИ" });
    return;
  }
  const i = intentIndex(b);
  const c: Chip = i >= 0 ? b.stack[i] : { id: 0, owner: "enemy", act: "hit", n: 2, name: "Как попало" };
  if (i >= 0) { b.stack.splice(i, 1); b.stack.push(c); }
  switch (c.act) {
    case "hit": {
      const times = c.times || 1;
      for (let t = 0; t < times; t++) {
        const raw = c.n + b.enemy.rage;
        if (b.hero.dodge > 0) { b.hero.dodge--; ev({ kind: "miss", text: `«${c.name}» мимо: уворот`, sfx: "ВЖУХ!" }); continue; }
        const dmg = Math.max(0, raw - b.hero.block);
        const blocked = raw - dmg;
        b.hero.block = Math.max(0, b.hero.block - raw);
        b.hero.hp -= dmg;
        log.taken += dmg;
        ev({ kind: "enemy", chip: c, dmg, text: `${c.name}: −${dmg}${blocked ? ` (блок ${blocked})` : ""}`, sfx: sfx[t % sfx.length] });
      }
      break;
    }
    case "shield": b.enemy.shield += c.n; ev({ kind: "enemy", chip: c, text: `${c.name}: щит ${c.n} на твой следующий удар`, sfx: "КЛАНГ!" }); break;
    case "heal": b.enemy.hp = Math.min(b.enemy.max, b.enemy.hp + c.n); ev({ kind: "enemy", chip: c, text: `${c.name}: +${c.n} здоровья`, sfx: "ХРУМ!" }); break;
    case "rage": b.enemy.rage += c.n; ev({ kind: "enemy", chip: c, text: `${c.name}: удары врага +${c.n}`, sfx: "ГРРР!" }); break;
    case "knock": {
      const counts = new Map<string, number>();
      for (const s of b.stack) if (s.owner === "hero" && s.item) counts.set(s.item, (counts.get(s.item) || 0) + 1);
      const target = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
      if (target) {
        b.stack = b.stack.filter((s) => s.item !== target);
        b.knocked.push(target);
        ev({ kind: "knock", chip: c, text: `${c.name}: вещь слетела, её фишки ушли из стопки`, sfx: "ШМЯК!" });
      } else ev({ kind: "enemy", chip: c, text: `${c.name}: выбивать уже нечего`, sfx: "ХА!" });
      break;
    }
  }
}
