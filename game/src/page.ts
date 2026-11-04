// Страница комикса: раскладки кадров (как comix/compose.py), отрисовка кадра, пузыри и подписи.

import { type GameManifest, alphaBox, image, noteMissing } from "./assets";
import { type Look, composeDoll, mannequin, skinHexOf } from "./doll";
import { sketchAndInk } from "./sketch";

export interface Actor {
  who: string;        // "hero", "npc:<id>" или "enemy:<id>"
  pose?: string;      // поза куклы или врага
  x: number;          // центр фигуры по ширине кадра, 0..1
  y?: number;         // где ступни, 0..1 (больше 1: ноги за кадром, крупный план)
  h?: number;         // рост фигуры в долях высоты кадра
  flip?: boolean;
  face?: string;      // эмоция героя
}

export interface Bubble {
  text: string;
  to?: number;                 // индекс актёра, на которого показывает хвост
  x?: number; y?: number;      // центр пузыря, 0..1 (по умолчанию над головой)
  kind?: "say" | "think" | "shout";
}

export interface Prop { id: string; x: number; y: number; s?: number; rot?: number }  // id: "группа/вещь"

export interface Panel {
  bg?: string;         // "локация/вариация"
  closeup?: string;    // крупный план вместо фона
  actors?: Actor[];
  props?: Prop[];
  caption?: string;
  title?: string;      // большой заголовок выпуска
  bubbles?: Bubble[];
  sfx?: string;
  end?: boolean;       // «Продолжение следует…»
}

export interface Cast {
  gm: GameManifest;
  hero: Look;
  npcs: Record<string, Look & { name: string }>;
  places: Record<string, string>;   // локация -> название для заглушки
  say: (text: string) => string;    // подстановка рода героя: {нашёл|нашла}
}

// --- раскладки ------------------------------------------------------------------------------

type R = [number, number, number, number];
export const LAYOUTS: Record<string, R[]> = {
  "1a": [[0, 0, 1, 1]],
  "2a": [[0, 0, 1, 0.5], [0, 0.5, 1, 1]],
  "3a": [[0, 0, 1, 0.4], [0, 0.4, 0.5, 1], [0.5, 0.4, 1, 1]],
  "3b": [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 2 / 3], [0, 2 / 3, 1, 1]],
  "3c": [[0, 0, 0.55, 0.5], [0.55, 0, 1, 0.5], [0, 0.5, 1, 1]],
  "4a": [[0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1]],
  "4b": [[0, 0, 1, 0.3], [0, 0.3, 0.5, 0.65], [0.5, 0.3, 1, 0.65], [0, 0.65, 1, 1]],
  "4c": [[0, 0, 0.6, 0.5], [0.6, 0, 1, 0.5], [0, 0.5, 0.4, 1], [0.4, 0.5, 1, 1]],
  "5a": [[0, 0, 0.5, 0.33], [0.5, 0, 1, 0.33], [0, 0.33, 1, 0.66], [0, 0.66, 0.5, 1], [0.5, 0.66, 1, 1]],
  "5b": [[0, 0, 1, 0.28], [0, 0.28, 0.4, 0.64], [0.4, 0.28, 1, 0.64], [0, 0.64, 0.6, 1], [0.6, 0.64, 1, 1]],
};
export const PAGE_SEQ = ["4b", "5a", "4c", "5b", "3a", "4a", "3c"];
export const BY_COUNT: Record<number, string> = { 1: "1a", 2: "2a", 3: "3a", 4: "4b", 5: "5a" };

export const PAGE_W = 1200, PAGE_H = 1697;
const MARGIN = 34, GUTTER = 18;

export interface Rect { x: number; y: number; w: number; h: number }

export function panelRects(layout: string, W = PAGE_W, H = PAGE_H): Rect[] {
  const x0 = MARGIN - GUTTER / 2, y0 = MARGIN - GUTTER / 2;
  const cw = W - 2 * x0, ch = H - 2 * y0 - 26;  // снизу место под номер страницы
  return LAYOUTS[layout].map(([a, b, c, d]) => {
    const x = Math.round(x0 + a * cw + GUTTER / 2), y = Math.round(y0 + b * ch + GUTTER / 2);
    return { x, y, w: Math.round(x0 + c * cw - GUTTER / 2) - x, h: Math.round(y0 + d * ch - GUTTER / 2) - y };
  });
}

// --- кадр ------------------------------------------------------------------------------------

export interface Art { color: HTMLCanvasElement; sketch: HTMLCanvasElement; ink: HTMLCanvasElement; heads: [number, number][] }

function cover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function halftone(ctx: CanvasRenderingContext2D, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  const st = Math.max(8, w / 46);
  for (let y = 0; y < h; y += st)
    for (let x = (y / st) % 2 ? st / 2 : 0; x < w; x += st) {
      const r = st * 0.18 * (0.4 + (y / h) * 0.9);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
}

function placeholderBg(ctx: CanvasRenderingContext2D, cast: Cast, ref: string, w: number, h: number) {
  const [loc, v = ""] = ref.split("/");
  const base = cast.gm.backgrounds[loc]?.color || "#8d9db6";
  const night = v.startsWith("night");
  const k = night ? 0.45 : 1;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, shade(base, 1.25 * k));
  g.addColorStop(0.62, shade(base, 0.95 * k));
  g.addColorStop(0.63, shade(base, 0.7 * k));
  g.addColorStop(1, shade(base, 0.55 * k));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  halftone(ctx, w, h, night ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.07)");
  // силуэты домов, чтобы кадр не был пустым
  ctx.fillStyle = shade(base, 0.6 * k);
  let x = 0, i = 0;
  while (x < w) {
    const bw = w * (0.08 + ((i * 37) % 11) / 90), bh = h * (0.18 + ((i * 53) % 13) / 60);
    ctx.fillRect(x, h * 0.62 - bh, bw - 3, bh);
    x += bw; i++;
  }
  ctx.font = `500 ${Math.max(11, w / 40)}px Rubik, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.textAlign = "right"; ctx.textBaseline = "bottom";
  ctx.fillText(`фон: ${cast.places[loc] || loc}${night ? ", ночь" : ""}`, w - 8, h - 6);
  ctx.textAlign = "left";
}

async function actorImage(cast: Cast, a: Actor): Promise<CanvasImageSource & { width: number; height: number }> {
  const pose = a.pose || "idle";
  if (a.who === "hero" || a.who.startsWith("npc:")) {
    const look: Look = a.who === "hero" ? { ...cast.hero, face: a.face } : cast.npcs[a.who.slice(4)] || cast.hero;
    const doll = await composeDoll(cast.gm, look, pose);
    if (doll) return doll;
    noteMissing("hero", "кукла");
    return mannequin(cast.gm, pose, skinHexOf(cast.gm, look.skin), a.who === "hero" ? "#d65a4a" : "#5a7fb0");
  }
  const id = a.who.replace(/^enemy:/, "");
  const e = cast.gm.enemies[id];
  const src = e?.poses[pose] || e?.poses.stand || (e && Object.values(e.poses)[0]);
  const img = await image(src);
  if (img) return img;
  noteMissing("enemy", id);
  return enemyStub(id, pose);
}

function enemyStub(id: string, pose: string) {
  const c = document.createElement("canvas");
  c.width = 400; c.height = 400;
  const x = c.getContext("2d")!;
  x.translate(200, 230);
  if (pose === "defeated") x.rotate(Math.PI / 2.2);
  x.fillStyle = "#2b2b33"; x.strokeStyle = "#0d0d10"; x.lineWidth = 8;
  x.beginPath(); x.ellipse(0, 0, 150, 120, 0, 0, Math.PI * 2); x.fill(); x.stroke();
  x.fillStyle = pose === "hit" ? "#fff" : "#ffd23f";
  for (const s of [-1, 1]) { x.beginPath(); x.ellipse(s * 55, -30, 22, 14, s * 0.3, 0, Math.PI * 2); x.fill(); }
  x.fillStyle = "#fff"; x.font = "600 30px Rubik, sans-serif"; x.textAlign = "center";
  x.fillText(id, 0, 70);
  return c;
}

async function propImage(cast: Cast, id: string) {
  const [g, k] = id.split("/");
  const s = cast.gm.sprites[g]?.[k];
  const img = await image(s?.src);
  if (img) return img;
  noteMissing("sprite", k);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff6d8"; x.strokeStyle = "#16161c"; x.lineWidth = 8;
  x.beginPath(); x.roundRect(28, 28, 200, 200, 36); x.fill(); x.stroke();
  x.fillStyle = "#16161c"; x.font = "600 26px Rubik, sans-serif"; x.textAlign = "center";
  x.fillText(k, 128, 136);
  return c;
}

export async function renderArt(cast: Cast, p: Panel, w: number, h: number): Promise<Art> {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  const heads: [number, number][] = [];
  if (p.end) {
    ctx.fillStyle = "#14141a"; ctx.fillRect(0, 0, w, h);
    halftone(ctx, w, h, "rgba(255,210,63,.12)");
  } else if (p.closeup) {
    const img = await image(cast.gm.closeups[p.closeup]);
    if (img) cover(ctx, img, w, h);
    else { noteMissing("closeup", p.closeup); placeholderBg(ctx, cast, "closeup/" + p.closeup, w, h); }
  } else if (p.bg) {
    const [loc, v] = p.bg.split("/");
    const vars = cast.gm.backgrounds[loc]?.variations || {};
    const img = await image(vars[v] || Object.values(vars)[0]);
    if (img) cover(ctx, img, w, h);
    else { noteMissing("bg", p.bg); placeholderBg(ctx, cast, p.bg, w, h); }
  } else {
    ctx.fillStyle = "#f4efe2"; ctx.fillRect(0, 0, w, h);
  }
  for (const pr of p.props || []) {
    const img = await propImage(cast, pr.id);
    const box = alphaBox(img as HTMLCanvasElement);
    const size = (pr.s ?? 0.3) * Math.min(w, h);
    const sc = size / Math.max(box.w, box.h);
    ctx.save();
    ctx.translate(pr.x * w, pr.y * h);
    ctx.rotate(((pr.rot ?? 0) * Math.PI) / 180);
    ctx.drawImage(img, -(box.x + box.w / 2) * sc, -(box.y + box.h / 2) * sc, img.width * sc, img.height * sc);
    ctx.restore();
  }
  for (const a of p.actors || []) {
    const img = await actorImage(cast, a);
    const box = alphaBox(img as HTMLCanvasElement);
    const sc = ((a.h ?? 0.8) * h) / box.h;
    const cx = a.x * w, feet = (a.y ?? 0.96) * h;
    const top = feet - box.h * sc;
    ctx.save();
    ctx.translate(cx, 0);
    if (a.flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -(box.x + box.w / 2) * sc, top - box.y * sc, img.width * sc, img.height * sc);
    ctx.restore();
    heads.push([cx, Math.max(top + box.h * sc * 0.08, 4)]);
  }
  const { sketch, ink } = sketchAndInk(cv);
  return { color: cv, sketch, ink, heads };
}

// --- текст поверх кадра ----------------------------------------------------------------------

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const t = line ? line + " " + word : word;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = word; }
      else line = t;
    }
    lines.push(line);
  }
  return lines;
}

function shoutPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) {
  const n = 18;
  ctx.beginPath();
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? 1.18 : 0.92;
    const x = cx + Math.cos(a) * rx * r, y = cy + Math.sin(a) * ry * r;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/** Пузыри, подписи и звуки. sketch: бледный карандашный вид для эскиза кадра. */
export function drawText(ctx: CanvasRenderingContext2D, cast: Cast, p: Panel, r: Rect, heads: [number, number][], sketch: boolean, alpha = 1) {
  if (alpha <= 0) return;
  const s = r.w / 560 > 1.25 ? 1.25 : Math.max(0.55, r.w / 560);
  const ink = sketch ? "rgba(66,68,80,.75)" : "#111";
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.translate(r.x, r.y);
  ctx.lineJoin = "round";
  let capBottom = 0;

  if (p.title) {
    const fs = Math.round(56 * s);
    ctx.font = `${fs}px "Russo One", Rubik, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.lineWidth = 9 * s; ctx.strokeStyle = sketch ? "rgba(66,68,80,.5)" : "#111";
    ctx.fillStyle = sketch ? "rgba(244,239,226,.9)" : "#ffd23f";
    ctx.strokeText(cast.say(p.title), r.w / 2, 14 * s);
    ctx.fillText(cast.say(p.title), r.w / 2, 14 * s);
    capBottom = 14 * s + fs * 1.1;
    ctx.textAlign = "left";
  }

  if (p.end) {
    const fs = Math.round(44 * s);
    ctx.font = `${fs}px "Russo One", Rubik, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = sketch ? "rgba(244,239,226,.8)" : "#ffd23f";
    const lines = wrap(ctx, cast.say(p.caption || "Продолжение следует…"), r.w * 0.85);
    lines.forEach((l, i) => ctx.fillText(l, r.w / 2, r.h / 2 + (i - (lines.length - 1) / 2) * fs * 1.2));
    ctx.restore();
    return;
  }

  if (p.caption) {
    const fs = Math.round(21 * s), pad = 9 * s;
    ctx.font = `500 ${fs}px Rubik, sans-serif`;
    ctx.textBaseline = "top";
    const lines = wrap(ctx, cast.say(p.caption), Math.min(r.w * 0.62, 420 * s) );
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bx = 0, by = capBottom, bw = tw + pad * 2, bh = lines.length * fs * 1.22 + pad * 2;
    ctx.fillStyle = sketch ? "rgba(244,239,226,.85)" : "#ffe58a";
    ctx.strokeStyle = ink; ctx.lineWidth = 3 * s;
    ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = ink;
    lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * fs * 1.22));
    capBottom = by + bh;
  }

  for (const b of p.bubbles || []) {
    const fs = Math.round((b.kind === "shout" ? 27 : 25) * s), pad = 12 * s;
    ctx.font = `${b.kind === "shout" ? "700 " : ""}${fs}px Neucha, "Comic Sans MS", sans-serif`;
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    const lines = wrap(ctx, cast.say(b.text), Math.min(r.w * 0.5, 300 * s));
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const th = lines.length * fs * 1.12;
    const rx = (tw / 2 + pad) * 1.16, ry = (th / 2 + pad) * 1.22;
    const head = b.to !== undefined ? heads[b.to] : undefined;
    let cx = b.x !== undefined ? b.x * r.w : head ? head[0] + (head[0] < r.w / 2 ? rx * 0.55 : -rx * 0.55) : r.w / 2;
    let cy = b.y !== undefined ? b.y * r.h : head ? head[1] - ry - 34 * s : ry + 10;
    cx = Math.min(r.w - rx - 6, Math.max(rx + 6, cx));
    cy = Math.min(r.h - ry - 6, Math.max(capBottom + ry + 8 * s, cy));
    ctx.fillStyle = sketch ? "rgba(250,248,240,.85)" : "#fff";
    ctx.strokeStyle = ink; ctx.lineWidth = 3 * s;
    // хвост
    if (head && b.kind !== "think") {
      const dx = head[0] - cx, dy = head[1] - cy, len = Math.hypot(dx, dy) || 1;
      const tx = cx + dx * Math.min(0.85, (len - 14 * s) / len), ty = cy + dy * Math.min(0.85, (len - 14 * s) / len);
      const nx = -dy / len, ny = dx / len, bw2 = Math.min(rx, ry) * 0.32;
      const ex = cx + dx * (ry / len) * 0.9, ey = cy + dy * (ry / len) * 0.9;
      ctx.beginPath();
      ctx.moveTo(ex + nx * bw2, ey + ny * bw2); ctx.lineTo(tx, ty); ctx.lineTo(ex - nx * bw2, ey - ny * bw2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    if (b.kind === "shout") shoutPath(ctx, cx, cy, rx, ry);
    else { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); }
    ctx.fill(); ctx.stroke();
    if (head && b.kind !== "think") {  // закрыть стык хвоста с пузырём
      ctx.beginPath(); ctx.ellipse(cx, cy, rx - 2.5 * s, ry - 2.5 * s, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (head && b.kind === "think") {
      for (const [k, rr] of [[0.55, 9], [0.78, 6]] as const) {
        ctx.beginPath();
        ctx.arc(cx + (head[0] - cx) * k, cy + ry * 0.6 + (head[1] - cy - ry * 0.6) * k, rr * s, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.fillStyle = ink;
    lines.forEach((l, i) => ctx.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * fs * 1.12));
    ctx.textAlign = "left";
  }

  if (p.sfx) {
    const fs = Math.round(64 * s);
    ctx.save();
    ctx.translate(r.w * 0.72, r.h * 0.3);
    ctx.rotate(-0.16);
    ctx.font = `${fs}px "Russo One", Rubik, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 10 * s; ctx.strokeStyle = ink;
    ctx.fillStyle = sketch ? "rgba(244,239,226,.9)" : "#ff4f3a";
    ctx.strokeText(p.sfx, 0, 0); ctx.fillText(p.sfx, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Кадр в процессе прорисовки: t=0 эскиз, 0..0.5 проходит тушь, 0.5..1 появляется цвет. */
export function drawArt(ctx: CanvasRenderingContext2D, art: Art, r: Rect, t: number) {
  if (t <= 0) { ctx.drawImage(art.sketch, r.x, r.y); return; }
  if (t >= 1) { ctx.drawImage(art.color, r.x, r.y); return; }
  if (t < 0.5) {
    ctx.drawImage(art.sketch, r.x, r.y);
    const k = t / 0.5, edge = r.w * 1.3 * k;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + edge, r.y); ctx.lineTo(r.x + edge - r.w * 0.3, r.y + r.h); ctx.lineTo(r.x, r.y + r.h);
    ctx.closePath(); ctx.clip();
    ctx.drawImage(art.ink, r.x, r.y);
    ctx.restore();
    return;
  }
  ctx.drawImage(art.ink, r.x, r.y);
  ctx.save();
  ctx.globalAlpha = (t - 0.5) / 0.5;
  ctx.drawImage(art.color, r.x, r.y);
  ctx.restore();
}
