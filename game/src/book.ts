// Книга: страницы выпуска показываются по одной, во весь экран без прокрутки, и листаются
// с анимацией: кнопками, стрелками на клавиатуре или свайпом. Листы это дети корня
// (холсты страниц и обложка), книга сама замечает, когда их добавляют.

const TURN_MS = 480;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface BookNav { prev: HTMLButtonElement; next: HTMLButtonElement; no: HTMLElement }

export class Book {
  private cur: HTMLElement | null = null;
  private queue: Promise<void> = Promise.resolve();
  private turning = 0;

  constructor(private root: HTMLElement, private frame: HTMLElement, private nav: BookNav, private ratio: number) {
    nav.prev.addEventListener("click", () => void this.step(-1));
    nav.next.addEventListener("click", () => void this.step(1));
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (document.body.classList.contains("has-ov") || document.querySelector("dialog[open]")) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); void this.step(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); void this.step(1); }
    });
    let x0 = 0, y0 = 0, down = false;
    root.addEventListener("pointerdown", (e) => { down = true; x0 = e.clientX; y0 = e.clientY; });
    root.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) void this.step(dx < 0 ? 1 : -1);
    });
    root.addEventListener("pointercancel", () => { down = false; });
    new MutationObserver(() => this.sync()).observe(root, { childList: true });
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.fit()); }).observe(frame);
    this.fit();
    this.sync();
  }

  leaves() { return [...this.root.children] as HTMLElement[]; }
  current() { return this.cur; }
  index() { return this.cur ? this.leaves().indexOf(this.cur) : -1; }

  /** Размер листа: целиком в рамке, с пропорциями страницы. Ширину книги задаёт высота рамки,
   *  чтобы панель выбора стояла вплотную к странице, а не у края экрана. */
  private fit() {
    const w = this.frame.clientWidth, hgt = this.frame.clientHeight;
    if (!hgt) return;
    this.frame.parentElement?.style.setProperty("--book-w", `${Math.floor(hgt * this.ratio)}px`);
    if (!w) return;
    const pw = Math.min(w, hgt * this.ratio);
    this.root.style.width = `${Math.floor(pw)}px`;
    this.root.style.height = `${Math.floor(pw / this.ratio)}px`;
  }

  private sync() {
    const all = this.leaves();
    if (!this.cur || !all.includes(this.cur)) this.cur = all[all.length - 1] || null;
    for (const el of all) {
      el.classList.add("leaf");
      if (!this.turning) el.classList.toggle("cur", el === this.cur);
    }
    const i = this.index();
    this.nav.no.textContent = all.length ? `${i + 1} / ${all.length}` : "";
    this.nav.prev.disabled = i <= 0;
    this.nav.next.disabled = i < 0 || i >= all.length - 1;
  }

  step(d: number) { return this.go(this.index() + d); }
  toLast() { return this.go(this.leaves().length - 1); }

  /** Перелистнуть к листу i. Перелистывания идут по очереди, без наложения. */
  go(i: number): Promise<void> {
    this.queue = this.queue.then(() => this.turn(i));
    return this.queue;
  }

  private async turn(i: number) {
    const all = this.leaves();
    const to = all[Math.max(0, Math.min(all.length - 1, i))];
    const from = this.cur;
    if (!to || to === from) return;
    if (!from || reduced()) { this.cur = to; this.sync(); return; }
    const forward = all.indexOf(to) > all.indexOf(from);
    // вперёд: текущий лист уходит влево, открывая следующий; назад: прошлый лист возвращается сверху
    const top = forward ? from : to;
    this.turning++;
    to.classList.add("cur");
    from.classList.add("cur");
    top.classList.add("turning");
    // лист поворачивается на корешке слева до ребра (90°): дальше его не видно, лишнего ожидания нет
    const flat = { transform: "perspective(3000px) rotateY(0deg)", filter: "brightness(1)" };
    const edge = { transform: "perspective(3000px) rotateY(-90deg)", filter: "brightness(.6)" };
    const anim = top.animate(forward ? [flat, edge] : [edge, flat],
      { duration: TURN_MS, easing: forward ? "cubic-bezier(.4,0,.8,.5)" : "cubic-bezier(.2,.5,.6,1)" });
    await anim.finished.catch(() => {});
    top.classList.remove("turning");
    this.turning--;
    this.cur = to;
    from.classList.remove("cur");
    this.sync();
  }
}
