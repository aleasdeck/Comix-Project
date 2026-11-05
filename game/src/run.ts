// Состояние забега: герой, вещи, наклейки, флаги сюжета и всё, что нужно монтажу и обложке.

import { C, type ChipDef, type Gain, type Needs, type OptionDef, type Stat, STATS } from "./content";
import type { Chip, Stickers } from "./chips";
import type { Look } from "./doll";

export const SLOTS = ["head", "top", "bottom", "shoes"] as const;

export interface Run {
  gender: string;
  skin: string;
  origin: string;
  motive: string;
  flaw: string;
  base: Record<Stat, number>;
  hp: number;
  max: number;
  ink: number;
  coins: number;
  outfit: Record<string, string>;
  hand: string;
  bag: string[];
  props: string[];
  kept: (ChipDef & { name: string })[];
  ally?: string;
  stickers: Stickers;
  album: string[];
  flags: string[];
  peek: number;
  stats: { inkSpent: number; played: number; skipped: number; taken: number; fights: number; allyLost: boolean };
}

export function newRun(o: { gender: string; skin: string; origin: string; motive: string; flaw: string }): Run {
  const or = C.origins[o.origin], mo = C.motives[o.motive], fl = C.flaws[o.flaw];
  const base = Object.fromEntries(STATS.map((s) => [s, 1 + (or.stats?.[s] || 0)])) as Record<Stat, number>;
  const max = 20 + (or.hp || 0);
  return {
    ...o, base, hp: max, max,
    ink: 2 + (or.ink || 0) + (fl.reward?.ink || 0),
    coins: Math.max(0, 5 + (or.coins || 0) + (fl.coins || 0)),
    outfit: { ...or.outfit },
    hand: or.hand || "fist",
    bag: [],
    props: [...(or.props || []), ...(mo.props || [])],
    kept: [],
    stickers: { bat: [], items: {}, cover: [] },
    album: [],
    flags: [],
    peek: 0,
    stats: { inkSpent: 0, played: 0, skipped: 0, taken: 0, fights: 0, allyLost: false },
  };
}

export function look(r: Run, face?: string): Look {
  return { gender: r.gender, skin: r.skin, outfit: { ...r.outfit }, face };
}

/** Характеристика с бонусами надетых вещей. */
export function stat(r: Run, s: Stat): number {
  let v = r.base[s];
  for (const id of Object.values(r.outfit)) v += C.items[id]?.stats?.[s] || 0;
  return Math.max(0, v);
}

export function hasFlag(r: Run, f: string) { return r.flags.includes(f); }

/** Шанс проверки в процентах: от характеристики, сложности, изъяна и союзника. */
export function chance(r: Run, o: OptionDef): number {
  const st = o.check?.stat || o.mini?.stat;
  if (!st) return 100;
  let diff = o.check?.diff ?? o.mini?.diff ?? 1;
  for (const [k, v] of Object.entries(o.harder || {})) if (r.flaw === k || hasFlag(r, k)) diff += v;
  for (const [k, v] of Object.entries(o.easier || {})) if (r.ally === k || hasFlag(r, k)) diff -= v;
  const p = 0.5 + 0.15 * (stat(r, st) - diff);
  return Math.round(Math.min(0.95, Math.max(0.08, p)) * 100);
}

/** Почему вариант закрыт (или пусто, если доступен). */
export function locked(r: Run, n?: Needs): string {
  if (!n) return "";
  if (n.coins && r.coins < n.coins) return `нужно ${n.coins} монет`;
  if (n.prop && !r.props.includes(n.prop)) return `нужна вещь «${C.props[n.prop]?.title || n.prop}»`;
  if (n.ally && r.ally !== n.ally) return "нужен союзник";
  if (n.origin && r.origin !== n.origin) return "не та предыстория";
  if (n.motive && r.motive !== n.motive) return "не тот мотив";
  return "";
}

/** Фишки героя для боя: кулаки, вещи, союзник и трофеи. */
export function heroChips(r: Run): Omit<Chip, "id" | "owner">[] {
  const out: Omit<Chip, "id" | "owner">[] = [
    { act: "hit", n: 2, name: "Кулак" },
    { act: "hit", n: 2, name: "Кулак" },
  ];
  for (const slot of SLOTS) {
    const id = r.outfit[slot];
    const it = id && C.items[id];
    if (!it) continue;
    for (const c of it.chips) out.push({ act: c.act, n: c.n ?? 0, name: it.title, item: id, set: it.set });
  }
  if (r.ally) out.push({ act: "hit", n: 3, name: C.world.npcs[r.ally]?.name || "Союзник" });
  for (const k of r.kept) out.push({ act: k.act, n: k.n ?? 0, name: k.name });
  return out;
}

/** Надеть вещь: одежду в её слот, битку в руку. Старая уходит в рюкзак. */
export function wear(r: Run, id: string) {
  const it = C.items[id];
  if (it) {
    const old = r.outfit[it.slot];
    if (old) r.bag.push(old);
    r.outfit[it.slot] = id;
    if (old && r.stickers.items[old]) delete r.stickers.items[old];
  } else if (C.slammers[id]) {
    if (r.hand && r.hand !== "fist") r.bag.push(r.hand);
    r.hand = id;
  }
  r.bag = r.bag.filter((b) => b !== id);
}

export function owned(r: Run, id: string) {
  return Object.values(r.outfit).includes(id) || r.hand === id || r.bag.includes(id);
}

/** Награда: 3 вещи на выбор из тех, что ещё не у героя. */
export function lootChoices(r: Run, n = 3, rng = Math.random): string[] {
  const pool = C.loot.filter((id) => !owned(r, id));
  const rare = (id: string) => C.items[id]?.rarity === "rare";
  // редкие выпадают реже
  const weighted = pool.flatMap((id) => (rare(id) ? [id] : [id, id, id]));
  const out: string[] = [];
  while (out.length < n && weighted.length) {
    const id = weighted[Math.floor(rng() * weighted.length)];
    if (!out.includes(id)) out.push(id);
    for (let i = weighted.length - 1; i >= 0; i--) if (weighted[i] === id) weighted.splice(i, 1);
  }
  return out;
}

export function applyGain(r: Run, g?: Gain) {
  if (!g) return;
  if (g.coins) r.coins += g.coins;
  if (g.hp) r.hp = Math.min(r.max, r.hp + g.hp);
  if (g.ink) r.ink += g.ink;
  for (const p of g.props || []) if (!r.props.includes(p)) r.props.push(p);
  if (g.ally) r.ally = g.ally;
  if (g.peek) r.peek += g.peek;
  for (const f of ([] as string[]).concat(g.flag || [])) if (!r.flags.includes(f)) r.flags.push(f);
}

export function applyCost(r: Run, c?: { hp?: number; coins?: number }) {
  if (!c) return;
  if (c.coins) r.coins = Math.max(0, r.coins - c.coins);
  if (c.hp) { r.hp = Math.max(0, r.hp - c.hp); r.stats.taken += c.hp; }
}

export function stickerSlots(r: Run) {
  return {
    bat: 2,
    items: SLOTS.map((s) => r.outfit[s]).filter(Boolean),
    cover: 3,
  };
}

/** Наклеить наклейку. Возвращает id наклейки, которую она заменила. */
export function stick(r: Run, id: string, where: "bat" | "cover" | string): string | undefined {
  const st = C.stickers[id];
  let replaced: string | undefined;
  if (where === "bat" || where === "cover") {
    const list = r.stickers[where];
    const cap = where === "bat" ? 2 : 3;
    if (list.length >= cap) replaced = list.shift();
    list.push(id);
  } else {
    replaced = r.stickers.items[where];
    r.stickers.items[where] = id;
  }
  if (id === "heart" && where === "cover") { r.max += 4; r.hp += 4; }
  if (replaced === "heart" && where === "cover") { r.max -= 4; r.hp = Math.min(r.hp, r.max); }
  if (!r.album.includes(id)) r.album.push(id);
  void st;
  return replaced;
}

/** Где можно наклеить: по типу наклейки. */
export function stickerTargets(r: Run, id: string): { key: string; label: string; now?: string }[] {
  const st = C.stickers[id];
  if (st.where === "bat") return [{ key: "bat", label: `Битка «${C.slammers[r.hand]?.title || "Кулак"}»`, now: r.stickers.bat.length >= 2 ? r.stickers.bat[0] : undefined }];
  if (st.where === "cover") return [{ key: "cover", label: "Обложка выпуска", now: r.stickers.cover.length >= 3 ? r.stickers.cover[0] : undefined }];
  return SLOTS.map((s) => r.outfit[s]).filter(Boolean).map((it) => ({ key: it, label: C.items[it]?.title || it, now: r.stickers.items[it] }));
}

export function stickerPack(r: Run, n: number, rng = Math.random): string[] {
  const pool = Object.keys(C.stickers).filter((id) => !r.album.includes(id) || rng() < 0.3);
  const out: string[] = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(rng() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}
