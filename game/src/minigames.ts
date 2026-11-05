// Миниигры на экране карманной ретро-консоли: «Штифты» (замок) и «Поток» (взлом).
// Обе пошаговые, без реакции. Любую можно пропустить и решить броском характеристики.

import { h, overlay, wait } from "./ui";

export interface MiniResult { win: boolean; skipped: boolean }

type Rng = () => number;

// --- «Штифты» -----------------------------------------------------------------------------

export interface Pins {
  n: number;
  order: number[];        // в каком порядке поднимать штифты
  set: boolean[];
  notNext: boolean[];     // проверено: этот штифт сейчас не следующий
  known: (number | null)[];  // место штифта в порядке, если прощупан
  picks: number;
  probes: number;
  done: null | "win" | "lose";
}

export function newPins(n: number, picks: number, probes: number, rng: Rng = Math.random): Pins {
  const order = [...Array(n).keys()].sort(() => rng() - 0.5);
  return { n, order, set: Array(n).fill(false), notNext: Array(n).fill(false), known: Array(n).fill(null), picks, probes, done: null };
}

const nextPin = (s: Pins) => s.order.find((i) => !s.set[i]);

/** Поднять штифт. Неверный ломает отмычку и сбрасывает соседей. */
export function liftPin(s: Pins, i: number): "up" | "wrong" | "noop" {
  if (s.done || s.set[i]) return "noop";
  if (nextPin(s) === i) {
    s.set[i] = true;
    s.notNext.fill(false);
    if (s.set.every(Boolean)) s.done = "win";
    return "up";
  }
  s.picks--;
  s.notNext[i] = true;
  for (const j of [i - 1, i + 1]) if (j >= 0 && j < s.n && s.set[j]) s.set[j] = false;
  if (s.picks <= 0) s.done = "lose";
  return "wrong";
}

export function probePin(s: Pins, i: number) {
  if (s.probes <= 0 || s.known[i] !== null) return;
  s.probes--;
  s.known[i] = s.order.indexOf(i) + 1;
}

// --- «Поток» ------------------------------------------------------------------------------

const N = 1, E = 2, S = 4, W = 8;
export const rot = (m: number) => ((m << 1) | (m >> 3)) & 15;

export interface Flow {
  w: number; h: number; rin: number; rout: number;
  tiles: number[];      // маска соединений
  moves: number;
  min: number;
  done: null | "win" | "lose";
}

export function newFlow(w: number, hgt: number, slack: number, rng: Rng = Math.random): Flow {
  const rin = Math.floor(rng() * hgt), rout = Math.floor(rng() * hgt);
  // случайный путь от входа слева до выхода справа
  const idx = (x: number, y: number) => y * w + x;
  let path: [number, number][] = [];
  const seen = new Set<number>();
  const dfs = (x: number, y: number): boolean => {
    path.push([x, y]); seen.add(idx(x, y));
    if (x === w - 1 && y === rout) return true;
    // случайный порядок, но вправо чаще: путь петляет, а не уходит в сторону навсегда
    const dirs = ([[1, 0], [0, 1], [0, -1], [-1, 0]] as [number, number][])
      .map((d) => ({ d, k: rng() + (d[0] === 1 ? 0.35 : 0) - (d[0] === -1 ? 0.3 : 0) }))
      .sort((a, b) => b.k - a.k).map((o) => o.d);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= hgt || seen.has(idx(nx, ny))) continue;
      if (dfs(nx, ny)) return true;
    }
    path.pop();
    return false;
  };
  dfs(0, rin);
  const sol = Array(w * hgt).fill(0);
  path.forEach(([x, y], k) => {
    let m = 0;
    const link = (px: number, py: number) => {
      if (px === x + 1) m |= E; else if (px === x - 1) m |= W; else if (py === y + 1) m |= S; else if (py === y - 1) m |= N;
    };
    if (k === 0) m |= W; else link(path[k - 1][0], path[k - 1][1]);
    if (k === path.length - 1) m |= E; else link(path[k + 1][0], path[k + 1][1]);
    sol[idx(x, y)] = m;
  });
  const shapes = [N | S, N | E, N | E | S];
  const tiles = sol.map((m) => {
    let t = m || shapes[Math.floor(rng() * shapes.length)];
    const r = Math.floor(rng() * 4);
    for (let i = 0; i < r; i++) t = rot(t);
    return t;
  });
  let min = 0;
  for (const [x, y] of path) {
    let t = tiles[idx(x, y)], r = 0;
    while (t !== sol[idx(x, y)] && r < 4) { t = rot(t); r++; }
    min += r;
  }
  path = [];
  return { w, h: hgt, rin, rout, tiles, moves: min + slack, min, done: null };
}

/** Какие плитки сейчас под потоком (от входа). */
export function flowing(f: Flow): Set<number> {
  const on = new Set<number>();
  const q: [number, number, number][] = [[0, f.rin, W]];
  while (q.length) {
    const [x, y, from] = q.shift()!;
    const i = y * f.w + x;
    if (on.has(i) || !(f.tiles[i] & from)) continue;
    on.add(i);
    const m = f.tiles[i];
    if (m & N && y > 0) q.push([x, y - 1, S]);
    if (m & S && y < f.h - 1) q.push([x, y + 1, N]);
    if (m & E && x < f.w - 1) q.push([x + 1, y, W]);
    if (m & W && x > 0) q.push([x - 1, y, E]);
  }
  return on;
}

export function flowWon(f: Flow): boolean {
  const i = f.rout * f.w + f.w - 1;
  return flowing(f).has(i) && !!(f.tiles[i] & E);
}

export function turnTile(f: Flow, i: number) {
  if (f.done) return;
  f.tiles[i] = rot(f.tiles[i]);
  f.moves--;
  if (flowWon(f)) f.done = "win";
  else if (f.moves <= 0) f.done = "lose";
}

// --- консоль -------------------------------------------------------------------------------

function handheld(title: string, rules: string) {
  const ov = overlay("console");
  const screen = h("div", { class: "lcd-screen" });
  const status = h("div", { class: "lcd-status", "aria-live": "polite" });
  const keys = h("div", { class: "hh-keys" });
  ov.box.append(
    h("div", { class: "hh" },
      h("div", { class: "hh-brand" }, "КАРМАНИЯ ", h("i", {}, "color")),
      h("div", { class: "lcd" }, h("div", { class: "lcd-title" }, title), screen, status),
      h("p", { class: "hh-rules" }, rules),
      h("div", { class: "hh-pad" },
        h("div", { class: "dpad", "aria-hidden": "true" }, h("span"), h("span"), h("span"), h("span")),
        keys,
        h("div", { class: "ab", "aria-hidden": "true" }, h("span", {}, "B"), h("span", {}, "A"))),
      h("div", { class: "hh-grill", "aria-hidden": "true" })));
  return { ov, screen, status, keys };
}

export function playPins(o: { pins: number; picks: number; probes: number; skipChance: number; skipStat: string }): Promise<MiniResult> {
  return new Promise((ok) => {
    const s = newPins(o.pins, o.picks, o.probes);
    const { ov, screen, status, keys } = handheld("ШТИФТЫ",
      "Подними штифты по порядку. Неверный штифт ломает отмычку и роняет соседей. Щуп показывает, каким по счёту идёт штифт.");
    let probing = false;
    const probe = h("button", { class: "hh-btn" }, "");
    const skip = h("button", { class: "hh-btn" }, `Решить броском: ${o.skipStat}, ${o.skipChance}%`);
    keys.append(probe, skip);
    const finish = async (win: boolean, skipped = false) => {
      render();
      status.textContent = win ? "ЩЁЛК! ОТКРЫТО" : "ХРУСТЬ… НЕ ВЫШЛО";
      await wait(900);
      ov.close();
      ok({ win, skipped });
    };
    function render() {
      const had = [...screen.querySelectorAll(".pin")].indexOf(document.activeElement as Element);
      screen.replaceChildren(h("div", { class: "pins" }, ...s.set.map((up, i) =>
        h("button", {
          class: `pin ${up ? "up" : ""} ${s.notNext[i] ? "no" : ""}`,
          "aria-label": `Штифт ${i + 1}${up ? ", поднят" : ""}${s.known[i] ? `, ${s.known[i]}-й по счёту` : ""}`,
          onclick: () => {
            if (s.done) return;
            if (probing) { probePin(s, i); probing = false; render(); return; }
            const r = liftPin(s, i);
            render();
            if (r === "wrong") status.textContent = "ДЗЫНЬ! Отмычка сломалась";
            if (s.done) void finish(s.done === "win");
          },
        }, h("span", { class: "spring" }), h("span", { class: "pinhead" }), h("small", {}, s.known[i] ? `${s.known[i]}` : `${i + 1}`)))));
      if (had >= 0) (screen.querySelectorAll(".pin")[had] as HTMLElement | undefined)?.focus();
      if (!s.done && !status.textContent?.startsWith("ДЗЫНЬ")) status.textContent = "";
      status.prepend(`Отмычки: ${"●".repeat(Math.max(0, s.picks))}${"○".repeat(Math.max(0, o.picks - s.picks))}  `);
      probe.textContent = probing ? "Выбери штифт для щупа" : `Щуп (${s.probes})`;
      probe.toggleAttribute("disabled", s.probes <= 0 || !!s.done);
    }
    probe.addEventListener("click", () => { probing = !probing; render(); });
    skip.addEventListener("click", () => {
      const win = Math.random() * 100 < o.skipChance;
      void finish(win, true);
    });
    render();
  });
}

export function playFlow(o: { w: number; h: number; slack: number; skipChance: number; skipStat: string }): Promise<MiniResult> {
  return new Promise((ok) => {
    // слишком лёгкое поле (или уже собранное) пересобираем
    let f = newFlow(o.w, o.h, o.slack);
    for (let k = 0; k < 30 && (f.min < 4 || flowWon(f)); k++) f = newFlow(o.w, o.h, o.slack);
    const { ov, screen, status, keys } = handheld("ПОТОК",
      "Поворачивай плитки, чтобы ток дошёл от входа слева до выхода справа. Каждый поворот тратит ход.");
    const skip = h("button", { class: "hh-btn" }, `Решить броском: ${o.skipStat}, ${o.skipChance}%`);
    keys.append(skip);
    const cv = h("canvas", { class: "flow", width: String(o.w * 64 + 32), height: String(o.h * 64), role: "img", "aria-label": "Поле с плитками" });
    screen.append(cv);
    const ctx = cv.getContext("2d")!;
    const finish = async (win: boolean, skipped = false) => {
      draw();
      status.textContent = win ? "ПИП! ДОСТУП ЕСТЬ" : "ВИИ-ИУ! ТРЕВОГА";
      await wait(900);
      ov.close();
      ok({ win, skipped });
    };
    const DARK = "#0f380f", MID = "#306230", LIGHT = "#8bac0f", BG = "#9bbc0f";
    function draw() {
      const on = flowing(f);
      ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height);
      // вход и выход
      ctx.fillStyle = DARK;
      ctx.fillRect(0, f.rin * 64 + 26, 16, 12);
      ctx.fillRect(cv.width - 16, f.rout * 64 + 26, 16, 12);
      f.tiles.forEach((m, i) => {
        const x = 16 + (i % f.w) * 64, y = Math.floor(i / f.w) * 64;
        ctx.fillStyle = LIGHT; ctx.fillRect(x + 2, y + 2, 60, 60);
        ctx.strokeStyle = MID; ctx.lineWidth = 2; ctx.strokeRect(x + 2, y + 2, 60, 60);
        ctx.strokeStyle = on.has(i) ? DARK : MID;
        ctx.lineWidth = on.has(i) ? 12 : 8; ctx.lineCap = "round";
        const cx = x + 32, cy = y + 32;
        ctx.beginPath();
        if (m & N) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y + 2); }
        if (m & S) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y + 62); }
        if (m & E) { ctx.moveTo(cx, cy); ctx.lineTo(x + 62, cy); }
        if (m & W) { ctx.moveTo(cx, cy); ctx.lineTo(x + 2, cy); }
        ctx.stroke();
      });
      status.textContent = f.done ? status.textContent : `Ходов осталось: ${f.moves}`;
    }
    cv.addEventListener("click", (e) => {
      if (f.done) return;
      const r = cv.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * cv.width - 16, y = ((e.clientY - r.top) / r.height) * cv.height;
      const tx = Math.floor(x / 64), ty = Math.floor(y / 64);
      if (tx < 0 || ty < 0 || tx >= f.w || ty >= f.h) return;
      turnTile(f, ty * f.w + tx);
      draw();
      if (f.done) void finish(f.done === "win");
    });
    skip.addEventListener("click", () => void finish(Math.random() * 100 < o.skipChance, true));
    draw();
  });
}
