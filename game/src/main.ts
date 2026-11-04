// Демо: страница комикса заполняется кадр за кадром. На выборе следующий пустой кадр
// показывает эскиз варианта, выбранный вариант прорисовывается тушью и цветом.

import "./style.css";
import { type GameManifest, empty, image, loadManifest, missingSummary, watchMissing } from "./assets";
import { type Look, composeDoll, lookKey, mannequin, skinHexOf } from "./doll";
import {
  type Art, type Cast, type Panel, type Rect,
  BY_COUNT, LAYOUTS, PAGE_H, PAGE_SEQ, PAGE_W, drawArt, drawText, panelRects, renderArt,
} from "./page";
import { type Backstory, type Choice, type Effect, BACKSTORIES, ITEMS, NPCS, PLACES, SCENES, START } from "./story";

interface Placed { id: string; panel: Panel; look: Look; t: number }
interface Page { layout: string; panels: Placed[]; canvas: HTMLCanvasElement }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const S = {
  gm: empty as GameManifest,
  gender: "male",
  skin: "light",
  outfit: {} as Record<string, string>,
  backstory: BACKSTORIES[0] as Backstory,
  inventory: [] as string[],
  pages: [] as Page[],
  choices: null as Choice[] | null,
  scene: START,
  hover: -1,
  done: false,
  run: 0,
};

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const last = () => S.pages[S.pages.length - 1];

function say(text: string) {
  const g = S.gender === "female" ? 1 : 0;
  const sub = (t: string) => t.replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, m, f) => (g ? f : m));
  return sub(text.replace("{backstory}", sub(S.backstory.text)));
}

function heroLook(l: Look): Look { return { ...l, gender: S.gender }; }

function cast(look: Look): Cast {
  return { gm: S.gm, hero: heroLook(look), npcs: NPCS, places: PLACES, say };
}

function currentLook(): Look { return { gender: S.gender, skin: S.skin, outfit: { ...S.outfit } }; }

function withEffect(l: Look, e?: Effect): Look {
  return e?.wear ? { ...l, outfit: { ...l.outfit, ...e.wear } } : l;
}

// --- кэш отрисованных кадров ----------------------------------------------------------------

const arts = new Map<string, Art>();
const pending = new Map<string, Promise<Art>>();
const lastArt = new Map<string, Art>();  // пока кадр перерисовывается в новом размере

function artKey(id: string, look: Look, r: Rect) { return `${id}|${r.w}x${r.h}|${lookKey(heroLook(look))}`; }

function ensureArt(id: string, panel: Panel, look: Look, r: Rect): Promise<Art> {
  const k = artKey(id, look, r);
  const hit = arts.get(k);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(k);
  if (!p) {
    p = renderArt(cast(look), panel, r.w, r.h).then((a) => {
      arts.set(k, a); lastArt.set(id, a); pending.delete(k);
      repaint(true);
      return a;
    });
    pending.set(k, p);
  }
  return p;
}

function artNow(id: string, panel: Panel, look: Look, r: Rect): Art | undefined {
  const a = arts.get(artKey(id, look, r));
  if (a) return a;
  void ensureArt(id, panel, look, r);
  return lastArt.get(id);
}

// --- страница -------------------------------------------------------------------------------

const smooth = (t: number) => t * t * (3 - 2 * t);

function paint(page: Page, target: HTMLCanvasElement = page.canvas, forExport = false) {
  const ctx = target.getContext("2d")!;
  ctx.fillStyle = "#fbf8ef";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  const rects = panelRects(page.layout);
  const isLast = page === last();
  rects.forEach((r, i) => {
    const pl = page.panels[i];
    let border = "#16161c";
    if (pl) {
      const art = artNow(pl.id, pl.panel, pl.look, r);
      if (art) {
        const t = smooth(pl.t);
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
        if (art.color.width === r.w && art.color.height === r.h) drawArt(ctx, art, r, t);
        else ctx.drawImage(art.color, r.x, r.y, r.w, r.h);
        ctx.restore();
        drawText(ctx, cast(pl.look), pl.panel, r, art.heads, t < 0.5, t < 0.5 ? 0.85 : 1);
      } else {
        ctx.fillStyle = "#f1ece0"; ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    } else if (!forExport && isLast && i === page.panels.length && S.choices) {
      const c = S.choices[S.hover];
      const art = c && artNow(previewId(S.hover), c.panel, withEffect(currentLook(), c.effect), r);
      if (c && art) {
        ctx.drawImage(art.sketch, r.x, r.y, r.w, r.h);
        drawText(ctx, cast(withEffect(currentLook(), c.effect)), c.panel, r, art.heads, true, 0.85);
        border = "#5a5f73";
      } else {
        ctx.fillStyle = "#f4efe2"; ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.save();
        ctx.setLineDash([16, 12]); ctx.strokeStyle = "#a59f90"; ctx.lineWidth = 4;
        ctx.strokeRect(r.x + 14, r.y + 14, r.w - 28, r.h - 28);
        ctx.restore();
        ctx.fillStyle = "#8b8576"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `${Math.min(110, r.h * 0.4)}px "Russo One", sans-serif`;
        ctx.fillText("?", r.x + r.w / 2, r.y + r.h / 2 - 18);
        ctx.font = "500 24px Rubik, sans-serif";
        ctx.fillText("Выбери следующий кадр", r.x + r.w / 2, r.y + r.h / 2 + Math.min(70, r.h * 0.28));
        ctx.textAlign = "left";
        border = "#a59f90";
      }
    } else {
      ctx.fillStyle = "#f1ece0"; ctx.fillRect(r.x, r.y, r.w, r.h);
      border = "#d8d1c0";
    }
    ctx.lineWidth = 5; ctx.strokeStyle = border;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  });
  ctx.fillStyle = "#6d675a"; ctx.font = "500 20px Rubik, sans-serif"; ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`— ${S.pages.indexOf(page) + 1} —`, PAGE_W / 2, PAGE_H - 14);
  ctx.textAlign = "left";
}

let queued = 0, queuedAll = false;
function repaint(all = false) {
  queuedAll ||= all;
  if (queued) return;
  queued = requestAnimationFrame(() => {
    const pages = queuedAll ? S.pages : S.pages.slice(-1);
    queued = 0; queuedAll = false;
    pages.forEach((p) => paint(p));
  });
}

function newPage(): Page {
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W; canvas.height = PAGE_H;
  canvas.className = "page";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Страница ${S.pages.length + 1}`);
  const page: Page = { layout: PAGE_SEQ[S.pages.length % PAGE_SEQ.length], panels: [], canvas };
  S.pages.push(page);
  $("pages").append(canvas);
  if (S.pages.length > 1) setTimeout(() => canvas.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  paint(page);
  return page;
}

function full(p: Page | undefined) { return !p || p.panels.length >= LAYOUTS[p.layout].length; }

function animate(pl: Placed, ms: number, run: number) {
  return new Promise<void>((ok) => {
    const t0 = performance.now();
    const step = (now: number) => {
      if (run !== S.run) return ok();
      pl.t = Math.min(1, (now - t0) / ms);
      paint(last());
      if (pl.t < 1) requestAnimationFrame(step); else ok();
    };
    requestAnimationFrame(step);
  });
}

async function place(id: string, panel: Panel, look: Look, run: number) {
  const page = full(last()) ? newPage() : last();
  const pl: Placed = { id, panel, look, t: 0 };
  page.panels.push(pl);
  await ensureArt(id, panel, look, panelRects(page.layout)[page.panels.length - 1]);
  if (run !== S.run) return;
  paint(page);
  await wait(180);
  await animate(pl, 1400, run);
}

// --- ход истории ----------------------------------------------------------------------------

async function play(sceneId: string, run: number) {
  S.scene = sceneId;
  const sc = SCENES[sceneId];
  for (const [i, p] of sc.panels.entries()) {
    if (run !== S.run) return;
    await place(`${run}-${sceneId}-${i}`, p, currentLook(), run);
    await wait(250);
  }
  if (run !== S.run) return;
  if (sc.choices) offer(sc.choices, run);
  else if (sc.next) await play(sc.next, run);
  else if (sc.end) await finish(run);
}

function previewId(i: number) { return `${S.run}-${S.scene}-choice${i}`; }

function offer(choices: Choice[], run: number) {
  if (full(last())) newPage();
  const page = last();
  const slot = panelRects(page.layout)[page.panels.length];
  S.choices = choices;
  S.hover = -1;
  $("choose").classList.add("open");
  $("chooseTitle").textContent = "Что дальше?";
  const box = $("choices");
  box.replaceChildren();
  choices.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "opt";
    const cv = document.createElement("canvas");
    cv.width = slot.w; cv.height = slot.h;
    const label = document.createElement("b");
    label.textContent = say(c.label);
    const hint = document.createElement("span");
    hint.textContent = c.hint ? say(c.hint) : "";
    b.append(cv, label, hint);
    const look = withEffect(currentLook(), c.effect);
    void ensureArt(previewId(i), c.panel, look, slot).then((art) => {
      if (run !== S.run) return;
      const x = cv.getContext("2d")!;
      x.drawImage(art.sketch, 0, 0);
      drawText(x, cast(look), c.panel, { x: 0, y: 0, w: slot.w, h: slot.h }, art.heads, true);
    });
    const on = () => { S.hover = i; repaint(); };
    const off = () => { if (S.hover === i) { S.hover = -1; repaint(); } };
    b.addEventListener("mouseenter", on);
    b.addEventListener("focus", on);
    b.addEventListener("mouseleave", off);
    b.addEventListener("blur", off);
    b.addEventListener("click", () => choose(i, run));
    box.append(b);
  });
  repaint();
}

async function choose(i: number, run: number) {
  const c = S.choices?.[i];
  if (!c || run !== S.run) return;
  const id = previewId(i);
  S.choices = null;
  S.hover = -1;
  $("choices").replaceChildren();
  $("choose").classList.remove("open");
  $("chooseTitle").textContent = "…";
  if (c.effect?.wear) Object.assign(S.outfit, c.effect.wear);
  for (const it of c.effect?.give || []) if (!S.inventory.includes(it)) S.inventory.push(it);
  void updateHero();
  await place(id, c.panel, currentLook(), run);
  await wait(250);
  if (run === S.run) await play(c.next, run);
}

async function finish(run: number) {
  const page = full(last()) ? newPage() : last();
  const n = page.panels.length + 1;
  if (LAYOUTS[page.layout].length !== n) { page.layout = BY_COUNT[n] || page.layout; repaint(true); }
  await place(`${run}-end`, { end: true, caption: "Продолжение следует…" }, currentLook(), run);
  if (run !== S.run) return;
  S.done = true;
  $("choose").classList.add("open");
  $("chooseTitle").textContent = "Выпуск окончен";
  document.querySelector<HTMLElement>(".tip.desk")!.hidden = true;
  const p = document.createElement("p");
  p.className = "tip";
  p.textContent = "Комикс этого забега можно скачать целиком. «Заново» начнёт с другой предысторией.";
  $("choices").replaceChildren(p);
}

// --- герой и карманы ------------------------------------------------------------------------

async function updateHero() {
  const look = currentLook();
  const doll = (await composeDoll(S.gm, look, "idle")) || mannequin(S.gm, "idle", skinHexOf(S.gm, S.skin), "#d65a4a");
  const cv = $<HTMLCanvasElement>("heroCv");
  cv.width = doll.width; cv.height = doll.height;
  const x = cv.getContext("2d")!;
  x.clearRect(0, 0, cv.width, cv.height);
  x.drawImage(doll, 0, 0);
  $("backstory").textContent = say(S.backstory.text);
  const box = $("pockets");
  box.replaceChildren();
  if (!S.inventory.length) box.textContent = "пусто";
  for (const it of S.inventory) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const [g, k] = it.split("/");
    const img = await image(S.gm.sprites[g]?.[k]?.src);
    if (img) { img.alt = ""; chip.append(img.cloneNode()); }
    chip.append(ITEMS[it] || k);
    box.append(chip);
  }
}

function showMissing() {
  const t = missingSummary();
  const el = $("missing");
  el.hidden = !t;
  el.textContent = t ? `Пока без картинок, вместо них заглушки. ${t}` : "";
}

// --- сохранение -----------------------------------------------------------------------------

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

function exportPage(p: Page) {
  const cv = document.createElement("canvas");
  cv.width = PAGE_W; cv.height = PAGE_H;
  paint(p, cv, true);
  return cv;
}

function saveComic() {
  const gap = 40, n = S.pages.length;
  if (!n) return;
  const cv = document.createElement("canvas");
  cv.width = PAGE_W + gap * 2; cv.height = n * PAGE_H + (n + 1) * gap;
  const x = cv.getContext("2d")!;
  x.fillStyle = "#23232b"; x.fillRect(0, 0, cv.width, cv.height);
  S.pages.forEach((p, i) => x.drawImage(exportPage(p), gap, gap + i * (PAGE_H + gap)));
  download(cv, "comix-vypusk.png");
}

// --- запуск ---------------------------------------------------------------------------------

function setGender(g: string) {
  S.gender = g;
  try { localStorage.setItem("comix.gender", g); } catch { /* приватный режим */ }
  document.querySelectorAll<HTMLButtonElement>("[data-g]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.g === g)));
  void updateHero();
  repaint(true);
  if (S.choices) offer(S.choices, S.run);
}

function restart() {
  S.run++;
  S.pages = []; S.choices = null; S.hover = -1; S.done = false;
  $("pages").replaceChildren();
  $("choices").replaceChildren();
  $("choose").classList.remove("open");
  document.querySelector<HTMLElement>(".tip.desk")!.hidden = false;
  arts.clear(); lastArt.clear(); pending.clear();
  S.backstory = pick(BACKSTORIES);
  S.outfit = { ...S.backstory.outfit };
  S.inventory = [];
  const skins = Object.keys(S.gm.doll?.skins || { light: "" });
  S.skin = pick(skins);
  void updateHero();
  newPage();
  void play(START, S.run);
}

async function fonts() {
  const list = ['25px Neucha', '56px "Russo One"', '500 21px Rubik'];
  await Promise.race([Promise.all(list.map((f) => document.fonts.load(f))), wait(2500)]).catch(() => {});
}

async function main() {
  try { S.gender = localStorage.getItem("comix.gender") || "male"; } catch { /* ок */ }
  watchMissing(() => requestAnimationFrame(showMissing));
  const [gm] = await Promise.all([loadManifest(), fonts()]);
  S.gm = gm;
  document.querySelectorAll<HTMLButtonElement>("[data-g]").forEach((b) => b.addEventListener("click", () => setGender(b.dataset.g!)));
  setGender(S.gender);
  $("restart").addEventListener("click", restart);
  $("savePage").addEventListener("click", () => { const p = last(); if (p) download(exportPage(p), `comix-page-${S.pages.length}.png`); });
  $("saveComic").addEventListener("click", saveComic);
  restart();
}

void main();
