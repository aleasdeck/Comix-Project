// Бумажная кукла: база позы + кожа нужного цвета + лицо + одежда (как web/doll и comix/doll.py).
// Порядок: база -> перекраска кожи по маске -> стереть шорты под штанами -> стереть то, что убирает
// лицо NPC -> лицо (тоже перекрашенное) -> слои одежды снизу вверх.

import { type DollManifest, type DollPose, type GameManifest, type Pt, image, noteMissing } from "./assets";

export interface Look {
  gender: string;
  skin: string;                    // имя тона из manifest.skins или #rrggbb
  outfit: Record<string, string>;  // слот -> вещь ("none" или нет ключа: пусто)
  face?: string;                   // эмоция героя или лицо NPC
}

export function lookKey(l: Look) {
  return JSON.stringify([l.gender, l.skin, l.face || "", Object.entries(l.outfit).sort()]);
}

function posesOf(m: DollManifest | undefined, gender: string) {
  return m?.genders?.[gender];
}

/** Поза для отрисовки: нужная, а если её ещё нет, то idle (и пометка, что её не хватает). */
export function resolvePose(m: DollManifest | undefined, gender: string, pose: string): DollPose | undefined {
  const g = posesOf(m, gender);
  if (!g) return undefined;
  if (g[pose]) return g[pose];
  noteMissing("hero", `${gender === "female" ? "она" : "он"}/${pose}`);
  return g.idle || Object.values(g)[0];
}

function hexOf(m: DollManifest, skin: string) {
  if (/^#[0-9a-f]{6}$/i.test(skin)) return skin;
  return m.skins?.[skin] || "#eac3a2";
}

/** Перекраска по маске с сохранением светотени (та же формула, что recolor в comix/doll.py). */
function tint(ctx: CanvasRenderingContext2D, w: number, h: number, mask: CanvasImageSource, ref: number[], hex: string) {
  const t = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const refL = 0.299 * ref[0] + 0.587 * ref[1] + 0.114 * ref[2] || 1;
  const mc = document.createElement("canvas");
  mc.width = w; mc.height = h;
  const mx = mc.getContext("2d", { willReadFrequently: true })!;
  mx.drawImage(mask, 0, 0, w, h);
  const md = mx.getImageData(0, 0, w, h).data;
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = md[i + 3] / 255;
    if (!a) continue;
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / refL;
    for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * (1 - a) + Math.min(255, t[c] * L) * a;
  }
  ctx.putImageData(img, 0, 0);
}

function erase(ctx: CanvasRenderingContext2D, mask: CanvasImageSource, w: number, h: number) {
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(mask, 0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
}

const dolls = new Map<string, Promise<HTMLCanvasElement | null>>();

/** Собранная кукла (canvas с прозрачным фоном) или null, если куклы в ассетах нет вовсе. */
export function composeDoll(gm: GameManifest, look: Look, pose: string): Promise<HTMLCanvasElement | null> {
  const key = lookKey(look) + "|" + pose;
  let p = dolls.get(key);
  if (!p) dolls.set(key, (p = build(gm, look, pose)));
  return p;
}

async function build(gm: GameManifest, look: Look, pose: string): Promise<HTMLCanvasElement | null> {
  const m = gm.doll;
  const e = resolvePose(m, look.gender, pose);
  if (!m || !e) return null;
  const layers: string[] = [];
  for (const slot of m.layer_order) {
    const it = look.outfit[slot];
    if (!it || it === "none") continue;
    const src = e.layers[slot]?.[it];
    if (src) layers.push(src);
    else noteMissing("item", it);
  }
  const face = look.face ? e.faces?.[look.face] : undefined;
  if (look.face && !face) noteMissing("face", look.face);
  const genBase = e.base[look.skin];
  const baseSrc = genBase || e.base.light || Object.values(e.base)[0];
  const hideShorts = !!look.outfit.bottom && look.outfit.bottom !== "none" && e.shorts_mask;
  const [base, mask, shorts, fLayer, fSkin, fErase, ...imgs] = await Promise.all([
    image(baseSrc),
    !genBase ? image(e.skin_mask) : null,
    hideShorts ? image(e.shorts_mask) : null,
    image(face?.layer), image(face?.skin), image(face?.erase),
    ...layers.map(image),
  ]);
  if (!base) return null;
  const w = base.naturalWidth, h = base.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(base, 0, 0);
  const ref = e.skin_ref || [234, 195, 162];
  const hex = hexOf(m, look.skin);
  if (mask) tint(ctx, w, h, mask, ref, hex);
  if (shorts) erase(ctx, shorts, w, h);
  if (fErase) erase(ctx, fErase, w, h);
  if (fLayer) {
    const fc = document.createElement("canvas");
    fc.width = w; fc.height = h;
    const fx = fc.getContext("2d", { willReadFrequently: true })!;
    fx.drawImage(fLayer, 0, 0, w, h);
    if (fSkin) tint(fx, w, h, fSkin, ref, hex);
    ctx.drawImage(fc, 0, 0);
  }
  for (const im of imgs) if (im) ctx.drawImage(im, 0, 0, w, h);
  return cv;
}

// --- заглушка: манекен по скелету позы, пока куклы нет --------------------------------------

const BASE_POINTS: Record<string, Pt> = {
  0: [0.5, 0.145], 1: [0.5, 0.225], 2: [0.405, 0.235], 3: [0.38, 0.36], 4: [0.37, 0.48],
  5: [0.595, 0.235], 6: [0.62, 0.36], 7: [0.63, 0.48], 8: [0.445, 0.5], 9: [0.445, 0.68],
  10: [0.445, 0.865], 11: [0.555, 0.5], 12: [0.555, 0.68], 13: [0.555, 0.865],
};
const LIMBS = [[2, 3], [3, 4], [5, 6], [6, 7], [8, 9], [9, 10], [11, 12], [12, 13]];

export function mannequin(gm: GameManifest, pose: string, skinHex: string, cloth: string): HTMLCanvasElement {
  const pts = gm.poses[pose]?.points || gm.poses.idle?.points || BASE_POINTS;
  const W = 416, H = 608;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d")!;
  const P = (k: number): [number, number] => {
    const p = pts[k] || BASE_POINTS[k];
    return [p[0] * W, p[1] * H];
  };
  c.lineCap = "round"; c.lineJoin = "round";
  c.strokeStyle = "#1d1d22";
  // туловище
  c.beginPath();
  for (const [i, k] of [2, 5, 11, 8].entries()) {
    const [x, y] = P(k);
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.closePath();
  c.fillStyle = cloth; c.lineWidth = 6; c.fill(); c.stroke();
  for (const [a, b] of LIMBS) {
    const [x1, y1] = P(a), [x2, y2] = P(b);
    c.lineWidth = 34; c.strokeStyle = "#1d1d22";
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    c.lineWidth = 24; c.strokeStyle = a >= 8 ? "#4a5468" : cloth;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
  const [hx, hy] = P(0);
  c.beginPath(); c.arc(hx, hy, H * 0.06, 0, Math.PI * 2);
  c.fillStyle = skinHex; c.lineWidth = 6; c.strokeStyle = "#1d1d22"; c.fill(); c.stroke();
  return cv;
}

export function skinHexOf(gm: GameManifest, skin: string) {
  return gm.doll ? hexOf(gm.doll, skin) : /^#/.test(skin) ? skin : "#eac3a2";
}
