// Страницы выпуска: кадры появляются по одному, следующий пустой кадр показывает эскиз
// варианта, выбранный прорисовывается тушью и цветом.

import { type Look, lookKey } from "./doll";
import {
  type Art, type Cast, type Panel, type Rect,
  BY_COUNT, LAYOUTS, PAGE_H, PAGE_SEQ, PAGE_W, drawArt, drawText, panelRects, renderArt,
} from "./page";
import { h, wait } from "./ui";

interface Placed { id: string; panel: Panel; look: Look; t: number }
export interface Page { layout: string; panels: Placed[]; canvas: HTMLCanvasElement }

export interface Sketch { panel: Panel; look: Look; label: string; hint?: string; tag?: string; more?: string }

const smooth = (t: number) => t * t * (3 - 2 * t);

export class Comic {
  pages: Page[] = [];
  private arts = new Map<string, Art>();
  private pending = new Map<string, Promise<Art>>();
  private lastArt = new Map<string, Art>();
  private preview: { id: string; panel: Panel; look: Look } | null = null;
  private slotHint = "";
  private seq = 0;
  private gen = 0;
  private queued = 0;
  private queuedAll = false;

  constructor(private root: HTMLElement, private cast: (l: Look) => Cast) {}

  reset() {
    this.gen++;
    this.pages = [];
    this.root.replaceChildren();
    this.arts.clear(); this.pending.clear(); this.lastArt.clear();
    this.preview = null; this.slotHint = "";
  }

  /** Сбросить готовые кадры, например после смены пола героя. */
  invalidate() { this.repaint(true); }

  private key(id: string, look: Look, r: Rect) { return `${id}|${r.w}x${r.h}|${lookKey(this.cast(look).hero)}`; }

  ensure(id: string, panel: Panel, look: Look, r: Rect): Promise<Art> {
    const k = this.key(id, look, r);
    const hit = this.arts.get(k);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(k);
    if (!p) {
      const gen = this.gen;
      p = renderArt(this.cast(look), panel, r.w, r.h).then((a) => {
        if (gen === this.gen) { this.arts.set(k, a); this.lastArt.set(id, a); this.repaint(true); }
        this.pending.delete(k);
        return a;
      });
      this.pending.set(k, p);
    }
    return p;
  }

  private now(id: string, panel: Panel, look: Look, r: Rect): Art | undefined {
    const a = this.arts.get(this.key(id, look, r));
    if (a) return a;
    void this.ensure(id, panel, look, r);
    return this.lastArt.get(id);
  }

  last() { return this.pages[this.pages.length - 1]; }
  private full(p?: Page) { return !p || p.panels.length >= LAYOUTS[p.layout].length; }

  newPage(): Page {
    const canvas = h("canvas", { class: "page", width: String(PAGE_W), height: String(PAGE_H), role: "img", "aria-label": `Страница ${this.pages.length + 1}` });
    const page: Page = { layout: PAGE_SEQ[this.pages.length % PAGE_SEQ.length], panels: [], canvas };
    this.pages.push(page);
    this.root.append(canvas);
    if (this.pages.length > 1) setTimeout(() => canvas.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    this.paint(page);
    return page;
  }

  /** Новая страница, если на текущей уже что-то есть (каждая глава с новой страницы). */
  freshPage() {
    const p = this.last();
    if (!p || p.panels.length) { if (p) this.fit(p); this.newPage(); }
  }

  /** Подогнать раскладку страницы под число кадров на ней (в конце главы). */
  fit(p: Page) {
    const n = p.panels.length;
    if (n && n < LAYOUTS[p.layout].length) { p.layout = BY_COUNT[n] || p.layout; this.repaint(true); }
  }

  /** Последний кадр выпуска: страница подгоняется так, чтобы он её закрыл. */
  closing() {
    let p = this.last();
    // на полной странице кадр ещё помещается, если есть раскладка на один кадр больше
    if (!p || !BY_COUNT[p.panels.length + 1]) p = this.newPage();
    const n = p.panels.length + 1;
    if (LAYOUTS[p.layout].length !== n) { p.layout = BY_COUNT[n]; this.repaint(true); }
  }

  /** Прямоугольник следующего пустого кадра (с новой страницей, если эта полна). */
  slot(): Rect {
    if (this.full(this.last())) this.newPage();
    const p = this.last();
    return panelRects(p.layout)[p.panels.length];
  }

  private paint(page: Page, target: HTMLCanvasElement = page.canvas, forExport = false) {
    const ctx = target.getContext("2d")!;
    ctx.fillStyle = "#fbf8ef";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    const rects = panelRects(page.layout);
    const isLast = page === this.last();
    rects.forEach((r, i) => {
      const pl = page.panels[i];
      let border = "#16161c";
      if (pl) {
        const art = this.now(pl.id, pl.panel, pl.look, r);
        if (art) {
          const t = smooth(pl.t);
          ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
          if (art.color.width === r.w && art.color.height === r.h) drawArt(ctx, art, r, t);
          else ctx.drawImage(art.color, r.x, r.y, r.w, r.h);
          ctx.restore();
          drawText(ctx, this.cast(pl.look), pl.panel, r, art.heads, t < 0.5, t < 0.5 ? 0.85 : 1);
        } else {
          ctx.fillStyle = "#f1ece0"; ctx.fillRect(r.x, r.y, r.w, r.h);
        }
      } else if (!forExport && isLast && i === page.panels.length && (this.preview || this.slotHint)) {
        const pv = this.preview;
        const art = pv && this.now(pv.id, pv.panel, pv.look, r);
        if (pv && art) {
          ctx.drawImage(art.sketch, r.x, r.y, r.w, r.h);
          drawText(ctx, this.cast(pv.look), pv.panel, r, art.heads, true, 0.85);
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
          ctx.fillText(this.slotHint, r.x + r.w / 2, r.y + r.h / 2 + Math.min(70, r.h * 0.28));
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
    ctx.fillText(`— ${this.pages.indexOf(page) + 1} —`, PAGE_W / 2, PAGE_H - 14);
    ctx.textAlign = "left";
  }

  repaint(all = false) {
    this.queuedAll ||= all;
    if (this.queued) return;
    this.queued = requestAnimationFrame(() => {
      const pages = this.queuedAll ? this.pages : this.pages.slice(-1);
      this.queued = 0; this.queuedAll = false;
      pages.forEach((p) => this.paint(p));
    });
  }

  private animate(pl: Placed, ms: number) {
    const gen = this.gen;
    return new Promise<void>((ok) => {
      const t0 = performance.now();
      const step = (now: number) => {
        if (gen !== this.gen) return ok();
        pl.t = Math.min(1, (now - t0) / ms);
        this.paint(this.last());
        if (pl.t < 1) requestAnimationFrame(step); else ok();
      };
      requestAnimationFrame(step);
    });
  }

  /** Добавить кадр: эскиз, потом тушь и цвет. id можно передать, чтобы взять готовый эскиз. */
  async place(panel: Panel, look: Look, id = `p${this.seq++}`, ms = 1300) {
    const gen = this.gen;
    this.preview = null; this.slotHint = "";
    const r = this.slot();
    const page = this.last();
    const pl: Placed = { id, panel, look, t: 0 };
    page.panels.push(pl);
    await this.ensure(id, panel, look, r);
    if (gen !== this.gen) return;
    this.paint(page);
    await wait(150);
    await this.animate(pl, ms);
  }

  /** Эскиз кадра в следующем пустом месте (при наведении на вариант). */
  setPreview(panel: Panel | null, look?: Look, id?: string) {
    this.preview = panel && look ? { id: id || `pv${this.seq++}`, panel, look } : null;
    this.repaint();
  }

  setHint(text: string) { this.slotHint = text; this.repaint(); }

  /** Развилка: эскизы вариантов следующего кадра. Возвращает номер выбранного. */
  fork(sketches: Sketch[], box: HTMLElement, title: HTMLElement, heading = "Что дальше?"): Promise<number> {
    const gen = this.gen;
    const r = this.slot();
    const fid = `f${this.seq++}`;
    this.setHint("Выбери следующий кадр");
    title.textContent = heading;
    box.replaceChildren();
    return new Promise((ok) => {
      sketches.forEach((s, i) => {
        const cv = h("canvas", { width: String(r.w), height: String(r.h) });
        const b = h("button", { class: "opt" }, cv,
          s.tag ? h("span", { class: "tag" }, s.tag) : null,
          h("b", {}, s.label),
          s.hint ? h("span", {}, s.hint) : null,
          s.more ? h("span", { class: "more" }, s.more) : null);
        void this.ensure(`${fid}-${i}`, s.panel, s.look, r).then((art) => {
          if (gen !== this.gen) return;
          const x = cv.getContext("2d")!;
          x.drawImage(art.sketch, 0, 0);
          drawText(x, this.cast(s.look), s.panel, { x: 0, y: 0, w: r.w, h: r.h }, art.heads, true);
        });
        const on = () => this.setPreview(s.panel, s.look, `${fid}-${i}`);
        const off = () => { if (this.preview?.id === `${fid}-${i}`) this.setPreview(null); };
        b.addEventListener("mouseenter", on);
        b.addEventListener("focus", on);
        b.addEventListener("mouseleave", off);
        b.addEventListener("blur", off);
        b.addEventListener("click", async () => {
          if (gen !== this.gen) return;
          box.replaceChildren();
          title.textContent = "…";
          await this.place(s.panel, s.look, `${fid}-${i}`);
          ok(i);
        });
        box.append(b);
      });
      (box.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
    });
  }

  /** Страница целиком для выгрузки, без подсказок и эскизов. */
  exportPage(p: Page) {
    const cv = h("canvas", { width: String(PAGE_W), height: String(PAGE_H) });
    this.paint(p, cv, true);
    return cv;
  }

  /** Прогрузить все кадры страниц (например, перед выгрузкой после смены пола). */
  async settle() {
    const jobs: Promise<Art>[] = [];
    for (const p of this.pages) {
      const rects = panelRects(p.layout);
      p.panels.forEach((pl, i) => jobs.push(this.ensure(pl.id, pl.panel, pl.look, rects[i])));
    }
    await Promise.all(jobs);
  }
}
