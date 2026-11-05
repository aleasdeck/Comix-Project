// Контент игры из game/content/*.yaml: вещи, враги, наклейки, предыстории и сцены мира.
// YAML собирается в сборку как текст и читается при запуске.

import { load } from "js-yaml";
import itemsSrc from "../content/items.yaml?raw";
import enemiesSrc from "../content/enemies.yaml?raw";
import stickersSrc from "../content/stickers.yaml?raw";
import backstorySrc from "../content/backstory.yaml?raw";
import citySrc from "../content/city.yaml?raw";
import type { Look } from "./doll";

export type Stat = "str" | "agi" | "wit" | "cha";
export const STATS: Stat[] = ["str", "agi", "wit", "cha"];
export const STAT_NAMES: Record<Stat, string> = { str: "Сила", agi: "Ловкость", wit: "Смекалка", cha: "Обаяние" };

export type HeroAct = "hit" | "block" | "dodge" | "heal" | "double" | "stun" | "ink" | "coin";
export type EnemyAct = "hit" | "shield" | "heal" | "rage" | "knock" | "trap";

export interface ChipDef { act: HeroAct; n?: number; name?: string }
export interface EnemyChipDef { act: EnemyAct; n?: number; times?: number; name: string }

export interface ItemDef {
  slot: string; title: string; set?: string; rarity?: string;
  chips: ChipDef[]; stats?: Partial<Record<Stat, number>>;
}
export interface SlammerDef {
  title: string; sprite?: string; light: [number, number]; strong: [number, number];
  hit_bonus?: number; bottom?: boolean; stun_capture?: boolean; light_block?: number; note?: string;
}
export interface PropDef { title: string; sprite?: string; note?: string }

export interface EnemyDef {
  title: string; hp: number; chips: EnemyChipDef[]; sfx?: string[];
  frame?: { h: number; y: number };
  phase2?: { at: number; say?: string; add: EnemyChipDef[] };
}

export interface StickerDef { title: string; where: "bat" | "item" | "cover"; text: string }

export interface Origin {
  title: string; stats?: Partial<Record<Stat, number>>; hp?: number; hand?: string; ink?: number; coins?: number;
  props?: string[]; outfit: Record<string, string>; day: string;
}
export interface Motive { title: string; taken: string; face?: string; hook: string; props?: string[] }
export interface Flaw { title: string; text: string; coins?: number; reward?: { ink?: number } }

// --- кадры в сценах -------------------------------------------------------------------------

export interface Shot {
  shot?: "wide" | "two" | "talk" | "close" | "fight" | "item" | "closeup";
  bg?: string; hero?: string; face?: string; with?: string; with_pose?: string;
  caption?: string; sfx?: string; title?: string;
  hero_says?: string; they_say?: string; say?: string; think?: string;
  prop?: string; closeup?: string;
}

export interface Gain {
  coins?: number; hp?: number; ink?: number; loot?: number; props?: string[]; ally?: string;
  peek?: number; sticker?: number; flag?: string | string[];
}
export interface Outcome {
  panels?: Shot[]; gain?: Gain; cost?: { hp?: number; coins?: number };
  fight?: string; then?: string;
}
export interface Needs { coins?: number; prop?: string; ally?: string; origin?: string; motive?: string }
export interface OptionDef {
  label: string;
  do?: Outcome;
  check?: { stat: Stat; diff: number };
  fight?: string;
  mini?: { game: "pins" | "flow"; stat: Stat; diff: number };
  needs?: Needs;
  harder?: Record<string, number>;
  easier?: Record<string, number>;
  try?: Shot;
  win?: Outcome;
  lose?: Outcome;
}
export interface Encounter {
  kind: "meet" | "fight" | "obstacle" | "trader" | "rest" | "mystery" | "boss";
  label: string; sketch: Shot; text: string; options: OptionDef[];
  shop?: { count: number; price: [number, number] };
}
export interface Beat { beat: string; title: string; pick: number; pool: string[] }
export interface Chapter { id: string; title: string; beats: Beat[] }
export interface World {
  world: string; title: string; issue: string; heart: string;
  npcs: Record<string, Look & { name: string }>;
  prologue: Shot[];
  chapters: Chapter[];
  encounters: Record<string, Encounter>;
  outcomes: Record<string, Outcome>;
  ending: { win: string; lose: string };
}

const items = load(itemsSrc) as { items: Record<string, ItemDef>; slammers: Record<string, SlammerDef>; props: Record<string, PropDef>; loot: string[] };
const enemies = load(enemiesSrc) as { enemies: Record<string, EnemyDef>; bosses: Record<string, EnemyDef>; keep: Record<EnemyAct, { act: HeroAct }> };
const stickers = load(stickersSrc) as { stickers: Record<string, StickerDef> };
const backstory = load(backstorySrc) as { origins: Record<string, Origin>; motives: Record<string, Motive>; flaws: Record<string, Flaw> };
const city = load(citySrc) as World;

export const C = {
  items: items.items,
  slammers: items.slammers,
  props: items.props,
  loot: items.loot,
  enemies: { ...enemies.enemies, ...enemies.bosses } as Record<string, EnemyDef>,
  bosses: Object.keys(enemies.bosses),
  keep: enemies.keep,
  stickers: stickers.stickers,
  origins: backstory.origins,
  motives: backstory.motives,
  flaws: backstory.flaws,
  world: city,
};

export const KIND_NAMES: Record<Encounter["kind"], string> = {
  meet: "Встреча", fight: "Бой", obstacle: "Препятствие", trader: "Торговец", rest: "Отдых", mystery: "Тайна", boss: "Страж",
};

/** Название любой вещи: одежда, битка или вещь в кармане. */
export function thingTitle(id: string) {
  return C.items[id]?.title || C.slammers[id]?.title || C.props[id]?.title || id;
}

export function chipLabel(c: { act: string; n?: number; times?: number; name?: string }) {
  const n = c.n ?? 0;
  switch (c.act) {
    case "hit": return `Удар ${n}${c.times && c.times > 1 ? ` ×${c.times}` : ""}`;
    case "block": return `Блок ${n}`;
    case "dodge": return "Уворот";
    case "heal": return `Лечение ${n}`;
    case "double": return "×2";
    case "stun": return "Оглушение";
    case "ink": return "+1 чернило";
    case "coin": return `+${n} монет`;
    case "shield": return `Щит ${n}`;
    case "rage": return `Ярость +${n}`;
    case "knock": return "Выбить вещь";
    case "trap": return `Ловушка ${n}`;
  }
  return c.act;
}
