// Ассеты игры: public/assets/manifest.json пишет `comix export-game`.
// Если файла или картинки нет, игра рисует заглушки, поэтому работает и без ночной генерации.

export type Pt = [number, number];

export interface FaceEntry { layer: string; skin?: string; erase?: string }

export interface DollPose {
  base: Record<string, string>;
  layers: Record<string, Record<string, string>>;
  faces?: Record<string, FaceEntry>;
  skin_mask?: string;
  skin_ref?: [number, number, number];
  shorts_mask?: string;
}

export interface DollManifest {
  layer_order: string[];
  skins: Record<string, string>;
  items: Record<string, Record<string, string>>;
  sets: Record<string, Record<string, string>>;
  genders: Record<string, Record<string, DollPose>>;
}

export interface GameManifest {
  doll?: DollManifest;
  backgrounds: Record<string, { color?: string; variations: Record<string, string> }>;
  enemies: Record<string, { title?: string; poses: Record<string, string> }>;
  sprites: Record<string, Record<string, { title?: string; src: string }>>;
  closeups: Record<string, string>;
  poses: Record<string, { title: string; points?: Record<string, Pt> }>;
}

const BASE = import.meta.env.BASE_URL + "assets/";

export const empty: GameManifest = { backgrounds: {}, enemies: {}, sprites: {}, closeups: {}, poses: {} };

export async function loadManifest(): Promise<GameManifest> {
  try {
    const r = await fetch(BASE + "manifest.json", { cache: "no-cache" });
    if (!r.ok) return empty;
    return { ...empty, ...(await r.json()) };
  } catch {
    return empty;
  }
}

const cache = new Map<string, Promise<HTMLImageElement | null>>();

/** Картинка по пути из manifest (относительно assets/). null, если не загрузилась. */
export function image(rel: string | undefined): Promise<HTMLImageElement | null> {
  if (!rel) return Promise.resolve(null);
  let p = cache.get(rel);
  if (!p) {
    p = new Promise((ok) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => ok(img);
      img.onerror = () => ok(null);
      img.src = BASE + rel;
    });
    cache.set(rel, p);
  }
  return p;
}

// Учёт заглушек, чтобы честно показать, каких картинок пока нет
const missing = new Map<string, Set<string>>();
let onMissing: () => void = () => {};

export function noteMissing(kind: string, what: string) {
  let s = missing.get(kind);
  if (!s) missing.set(kind, (s = new Set()));
  if (!s.has(what)) {
    s.add(what);
    onMissing();
  }
}

export function watchMissing(fn: () => void) { onMissing = fn; }

export function missingSummary(): string {
  const names: Record<string, string> = {
    bg: "фоны", hero: "позы героя", item: "одежда", face: "лица", enemy: "враги", sprite: "вещи", closeup: "крупные планы",
  };
  const parts: string[] = [];
  for (const [k, s] of missing) parts.push(`${names[k] || k}: ${[...s].join(", ")}`);
  return parts.join(" · ");
}

/** Прямоугольник непрозрачных пикселей: по нему ставим фигуру в кадр. */
const boxes = new WeakMap<CanvasImageSource, { x: number; y: number; w: number; h: number }>();

export function alphaBox(src: HTMLImageElement | HTMLCanvasElement) {
  const hit = boxes.get(src);
  if (hit) return hit;
  const w = src.width, h = src.height;
  const s = Math.min(1, 256 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, cw, ch);
  const d = x.getImageData(0, 0, cw, ch).data;
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let y = 0; y < ch; y++)
    for (let i = 0; i < cw; i++)
      if (d[(y * cw + i) * 4 + 3] > 24) {
        if (i < x0) x0 = i; if (i > x1) x1 = i;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  const box = x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0 / s, y: y0 / s, w: (x1 - x0 + 1) / s, h: (y1 - y0 + 1) / s };
  boxes.set(src, box);
  return box;
}
