// Демо-пролог выпуска «Город». Это проверка движка, а не сюжет игры: настоящие сцены
// появятся после утверждения концепта. Текст с {он|она} подставляется по полу героя.

import type { Look } from "./doll";
import type { Panel } from "./page";

export interface Effect { wear?: Record<string, string>; give?: string[] }

export interface Choice {
  label: string;
  hint?: string;
  panel: Panel;      // этот кадр игрок видит эскизом, пока выбирает
  effect?: Effect;
  next: string;
}

export interface Scene { panels: Panel[]; choices?: Choice[]; next?: string; end?: boolean }

export interface Backstory { text: string; outfit: Record<string, string> }

export const BACKSTORIES: Backstory[] = [
  { text: "{Курьер, которого|Курьерша, которую} вчера уволили",
    outfit: { head: "baseball_cap", top: "hoodie", bottom: "jeans", shoes: "sneakers" } },
  { text: "{Частный сыщик|Частная сыщица} без лицензии",
    outfit: { head: "fedora", top: "trench_coat", bottom: "black_trousers", shoes: "dress_shoes" } },
  { text: "{Охранник|Охранница} ночного магазина",
    outfit: { top: "hoodie", bottom: "black_trousers", shoes: "dress_shoes" } },
];

export const HERO_SET = { head: "hero_mask", top: "hero_suit_top", bottom: "hero_suit_legs", shoes: "hero_boots" };

export const NPCS: Record<string, Look & { name: string }> = {
  old_cop: { name: "Старый коп", gender: "male", skin: "medium", face: "npc_old_cop",
    outfit: { head: "fedora", top: "trench_coat", bottom: "black_trousers", shoes: "dress_shoes" } },
};

export const PLACES: Record<string, string> = {
  apartment: "квартира", street: "улица", alley: "переулок", diner: "закусочная", subway: "метро",
  office: "офис", rooftop: "крыша", pawn_shop: "ломбард", warehouse: "склад", parking: "парковка",
  server_room: "серверная", lab: "лаборатория", penthouse: "пентхаус", highway: "шоссе", closeup: "крупный план",
};

export const ITEMS: Record<string, string> = {
  "props/flash_drive": "Флешка", "weapons/crowbar": "Монтировка", "props/prototype": "Чертёж прототипа",
};

export const START = "start";

export const SCENES: Record<string, Scene> = {
  start: {
    panels: [
      { bg: "apartment/day_wide", title: "ВЫПУСК №1. ГОРОД", caption: "{backstory}. Утро понедельника.",
        actors: [{ who: "hero", pose: "idle", x: 0.5, y: 0.98, h: 0.66 }] },
      { bg: "apartment/day_close", caption: "Звонок с незнакомого номера.",
        actors: [{ who: "hero", pose: "talk", x: 0.42, y: 1.55, h: 1.35 }],
        bubbles: [{ text: "Алло? Кто это?", to: 0 }] },
      { bg: "apartment/day_close", caption: "«Отнеси флешку в закусочную. Никому ни слова». Гудки.",
        actors: [{ who: "hero", pose: "think", x: 0.3, y: 1.5, h: 1.3, face: "surprise" }],
        props: [{ id: "props/flash_drive", x: 0.74, y: 0.66, s: 0.3, rot: -12 }],
        bubbles: [{ text: "Какую ещё флешку?..", to: 0, kind: "think" }] },
    ],
    choices: [
      { label: "Надеть костюм героя", hint: "Старый костюм с косплея. Вдруг пригодится?",
        effect: { wear: HERO_SET, give: ["props/flash_drive"] }, next: "street",
        panel: { bg: "apartment/sunset_low", caption: "Костюм из шкафа сидит как влитой.",
          actors: [{ who: "hero", pose: "victory", x: 0.5, y: 0.98, h: 0.82, face: "smirk" }],
          bubbles: [{ text: "Город, держись!", to: 0 }] } },
      { label: "Пойти как есть", hint: "Флешку в карман, дверь на ключ.",
        effect: { give: ["props/flash_drive"] }, next: "street",
        panel: { bg: "apartment/day_wide", caption: "Флешку в карман, дверь на ключ.",
          actors: [{ who: "hero", pose: "walk", x: 0.62, y: 0.98, h: 0.72 }] } },
    ],
  },

  street: {
    panels: [
      { bg: "street/day_wide", caption: "Город шумит. До закусочной три квартала.",
        actors: [{ who: "hero", pose: "walk", x: 0.42, y: 0.97, h: 0.58 }] },
    ],
    choices: [
      { label: "Поймать такси", hint: "За рулём кто-то знакомый.", next: "diner",
        panel: { bg: "street/day_close",
          actors: [{ who: "hero", pose: "talk", x: 0.28, y: 1.5, h: 1.3 },
                   { who: "npc:old_cop", pose: "talk", x: 0.74, y: 1.5, h: 1.3, flip: true }],
          bubbles: [{ text: "Садись. Я тоже ищу эту флешку.", to: 1 }] } },
      { label: "Срезать через переулок", hint: "Быстрее, но там кто-то рычит.", next: "alley",
        panel: { bg: "alley/day_wide", caption: "В переулке кто-то рычит.",
          actors: [{ who: "hero", pose: "walk", x: 0.33, y: 0.97, h: 0.6 },
                   { who: "enemy:guard_dog", pose: "stand", x: 0.76, y: 0.96, h: 0.34 }] } },
    ],
  },

  alley: {
    panels: [
      { bg: "alley/day_close", sfx: "РРРЫ!",
        actors: [{ who: "hero", pose: "shock", x: 0.26, y: 1.02, h: 0.86, face: "surprise" },
                 { who: "enemy:guard_dog", pose: "attack", x: 0.66, y: 0.97, h: 0.5 }],
        bubbles: [{ text: "Хороший пёсик…", to: 0 }] },
    ],
    choices: [
      { label: "Схватить монтировку", hint: "Здесь будет бой на фишках.", effect: { give: ["weapons/crowbar"] }, next: "diner",
        panel: { bg: "alley/day_close", sfx: "БАМ!", caption: "Пёс скулит и убегает.",
          actors: [{ who: "hero", pose: "fight", x: 0.32, y: 1.0, h: 0.86, face: "anger" },
                   { who: "enemy:guard_dog", pose: "hit", x: 0.72, y: 0.97, h: 0.44 }],
          props: [{ id: "weapons/crowbar", x: 0.47, y: 0.42, s: 0.28, rot: 30 }] } },
      { label: "Бежать", hint: "До метро двести метров.", next: "subway",
        panel: { bg: "alley/day_wide", caption: "Бегом к метро!",
          actors: [{ who: "enemy:guard_dog", pose: "attack", x: 0.2, y: 0.96, h: 0.3 },
                   { who: "hero", pose: "run", x: 0.64, y: 0.97, h: 0.62, face: "surprise" }] } },
    ],
  },

  subway: {
    panels: [
      { bg: "subway/day_wide", caption: "Пёс отстал. Закусочная через одну станцию.",
        actors: [{ who: "hero", pose: "think", x: 0.5, y: 0.98, h: 0.66, face: "tired" }],
        bubbles: [{ text: "Кому-то очень нужна эта флешка.", to: 0, kind: "think" }] },
    ],
    next: "diner",
  },

  diner: {
    panels: [
      { bg: "diner/day_wide", caption: "Закусочная «24 часа». Вместо отправителя тебя ждут.",
        actors: [{ who: "hero", pose: "idle", x: 0.3, y: 0.97, h: 0.62 },
                 { who: "enemy:gang_boss", pose: "stand", x: 0.72, y: 0.97, h: 0.66 }],
        bubbles: [{ text: "Флешку. Быстро.", to: 1, kind: "shout" }] },
      { bg: "diner/day_close", caption: "На флешке чертёж прототипа. Это Сердце города, и за ним охотится злодей выпуска.",
        props: [{ id: "props/prototype", x: 0.5, y: 0.6, s: 0.55 }] },
    ],
    end: true,
  },
};
