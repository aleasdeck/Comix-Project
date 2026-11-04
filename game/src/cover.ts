// Обложка выпуска. Звёзды за прохождение решают бумагу: газетная, глянец, фольга, голограмма,
// вариантная голограмма. Сохранность от 1 до 10 падает от полученного урона. Всё рисуется кодом
// из героя в финальном облике, злодея и фона.

import { image } from "./assets";
import { C } from "./content";
import { type Cast, type Panel, PAGE_H, PAGE_W, renderArt } from "./page";
import type { Run } from "./run";

export interface Star { text: string; ok: boolean }
export interface CoverInfo { stars: Star[]; count: number; grade: number; tier: number; paper: string }

export const PAPERS = ["Газетная", "Газетная", "Глянцевая", "Фольга", "Голограмма", "Вариантная голограмма"];

export const STICKER_ICON: Record<string, string> = {
  lucky_star: "⭐", gum: "🍬", flame: "🔥", lightning: "⚡", skull: "💀", bandage: "🩹",
  cheat_sheet: "📝", eye: "👁", piggy_bank: "🐷", heart: "❤",
};

export function coverInfo(r: Run, win: boolean): CoverInfo {
  const stars: Star[] = [
    { text: "Злодей главы побеждён или уговорён", ok: win && r.flags.includes("guardian") },
    { text: "Союзник дошёл до финала", ok: win && !!r.ally && !r.stats.allyLost },
    { text: "Ни одной перерисовки чернилами", ok: r.stats.inkSpent === 0 },
    { text: "Миниигры пройдены сами, без броска", ok: r.stats.played > 0 && r.stats.skipped === 0 },
    { text: "Открыта личная зацепка", ok: r.flags.includes("hook") },
  ];
  const count = stars.filter((s) => s.ok).length;
  const grade = Math.max(1, Math.min(10, 10 - Math.floor(r.stats.taken / 6)));
  return { stars, count, grade, tier: count, paper: PAPERS[count] };
}

function burst(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, n = 16) {
  ctx.beginPath();
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, k = i % 2 ? 0.78 : 1;
    const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function metal(ctx: CanvasRenderingContext2D, y0: number, y1: number) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, "#fff7c2"); g.addColorStop(0.35, "#f2c14b"); g.addColorStop(0.5, "#a8741c");
  g.addColorStop(0.65, "#f7d673"); g.addColorStop(1, "#fff2b0");
  return g;
}

function rainbow(ctx: CanvasRenderingContext2D, alpha: number, shift = 0) {
  const g = ctx.createLinearGradient(0, 0, PAGE_W, PAGE_H);
  const hues = [330, 20, 60, 140, 190, 250, 300];
  hues.forEach((hue, i) => g.addColorStop(Math.min(1, (i / (hues.length - 1) + shift) % 1.0001), `hsla(${hue},100%,62%,${alpha})`));
  return g;
}

/** Обложка выпуска как картинка страницы (для показа и выгрузки). */
export async function drawCover(cast: Cast, r: Run, info: CoverInfo, o: { bg: string; boss?: string; win: boolean }): Promise<HTMLCanvasElement> {
  const W = PAGE_W, H = PAGE_H;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d")!;

  const panel: Panel = { bg: o.bg, actors: [] };
  if (o.boss) panel.actors!.push({ who: `enemy:${o.boss}`, pose: "stand", x: 0.7, y: 0.86, h: 0.6, flip: true });
  panel.actors!.push({ who: "hero", pose: o.win ? "victory" : "shock", face: o.win ? "joy" : "tired", x: 0.36, y: 1.0, h: 0.72 });
  const art = await renderArt(cast, panel, W, H);
  if (info.tier <= 1) ctx.filter = "sepia(.4) saturate(.65) contrast(.95)";
  ctx.drawImage(art.color, 0, 0);
  ctx.filter = "none";

  // вариантная обложка: лучи от героя
  if (info.tier >= 5) {
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = "rgba(255,240,160,.85)";
    const cx = W * 0.36, cy = H * 0.55;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * 2000, cy + Math.sin(a) * 2000);
      ctx.lineTo(cx + Math.cos(a + 0.12) * 2000, cy + Math.sin(a + 0.12) * 2000);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // шапка
  const band = ctx.createLinearGradient(0, 0, 0, 236);
  band.addColorStop(0, "#16161c"); band.addColorStop(1, "#2a2333");
  ctx.fillStyle = band; ctx.fillRect(0, 0, W, 236);
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.font = '112px "Russo One", Rubik, sans-serif';
  ctx.lineJoin = "round"; ctx.lineWidth = 12; ctx.strokeStyle = "#000";
  ctx.strokeText("КОМИКС-РОГАЛИК", W / 2, 150);
  ctx.fillStyle = info.tier >= 3 ? metal(ctx, 60, 150) : "#ffd23f";
  ctx.fillText("КОМИКС-РОГАЛИК", W / 2, 150);
  ctx.font = "700 34px Rubik, sans-serif"; ctx.fillStyle = "#f3f1ea";
  ctx.fillText(`ВЫПУСК №1 · ${C.world.title.toUpperCase()}`, W / 2, 206);

  // звёзды
  ctx.font = '64px "Russo One", sans-serif';
  // заработанные звёзды идут первыми
  [...info.stars].sort((a, b) => Number(b.ok) - Number(a.ok)).forEach((s, i) => {
    const x = W / 2 + (i - 2) * 74, y = 312;
    ctx.lineWidth = 8; ctx.strokeStyle = "#16161c";
    ctx.strokeText("★", x, y);
    ctx.fillStyle = s.ok ? (info.tier >= 3 ? metal(ctx, 260, 312) : "#ffd23f") : "rgba(255,255,255,.35)";
    ctx.fillText("★", x, y);
  });

  // номер и цена слева, сохранность справа
  ctx.fillStyle = "#fbf8ef"; ctx.strokeStyle = "#16161c"; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.roundRect(36, 256, 150, 96, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#16161c"; ctx.font = '44px "Russo One", sans-serif'; ctx.fillText("№1", 111, 306);
  ctx.font = "600 24px Rubik, sans-serif"; ctx.fillText("цена 5 ¤", 111, 338);
  ctx.fillStyle = "#fbf8ef";
  ctx.beginPath(); ctx.roundRect(W - 226, 256, 190, 96, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#16161c"; ctx.font = "700 20px Rubik, sans-serif"; ctx.fillText("СОХРАННОСТЬ", W - 131, 284);
  ctx.font = '50px "Russo One", sans-serif';
  ctx.fillStyle = info.grade >= 8 ? "#1f7a3c" : info.grade >= 5 ? "#9a6a00" : "#b0302a";
  ctx.fillText(`${info.grade}/10`, W - 131, 338);

  // плашка-взрыв
  const origin = cast.say(C.origins[r.origin]?.title || "Герой");
  const boss = o.boss ? C.enemies[o.boss]?.title : "";
  const blurb = o.win ? (boss ? `${origin} против: ${boss}!` : `${origin} спасает квартал!`) : "Неужели это конец?!";
  ctx.save();
  ctx.translate(250, H - 430); ctx.rotate(-0.12);
  burst(ctx, 0, 0, 220, 150);
  ctx.fillStyle = "#ffe14d"; ctx.fill(); ctx.lineWidth = 8; ctx.strokeStyle = "#16161c"; ctx.stroke();
  ctx.fillStyle = "#16161c"; ctx.font = "700 34px Rubik, sans-serif"; ctx.textBaseline = "middle";
  const lines = wrapLines(ctx, blurb, 300);
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * 40));
  ctx.restore();

  // наклейки обложки
  for (const [i, id] of r.stickers.cover.entries()) {
    const x = W - 150 - i * 140, y = H - 300;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(((i % 2 ? 1 : -1) * 10 * Math.PI) / 180);
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0, 0, 62, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.stroke();
    const img = await image(cast.gm.sprites.stickers?.[id]?.src);
    if (img) ctx.drawImage(img, -52, -52, 104, 104);
    else {
      ctx.fillStyle = "#ffd23f"; ctx.beginPath(); ctx.arc(0, 0, 52, 0, Math.PI * 2); ctx.fill();
      ctx.font = "56px sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = "#16161c";
      ctx.fillText(STICKER_ICON[id] || "★", 0, 4);
    }
    ctx.restore();
  }

  // название выпуска
  ctx.fillStyle = "#c8302c"; ctx.fillRect(0, H - 170, W, 120);
  ctx.fillStyle = "#16161c"; ctx.fillRect(0, H - 50, W, 50);
  ctx.textBaseline = "middle";
  ctx.font = '76px "Russo One", sans-serif'; ctx.lineWidth = 10; ctx.strokeStyle = "#16161c";
  ctx.strokeText(C.world.issue.toUpperCase(), W / 2, H - 108);
  ctx.fillStyle = "#fff"; ctx.fillText(C.world.issue.toUpperCase(), W / 2, H - 108);
  ctx.font = "500 22px Rubik, sans-serif"; ctx.fillStyle = "#a8a7b6";
  ctx.fillText(`обложка: ${info.paper.toLowerCase()} · звёзд ${info.count} из 5`, W / 2, H - 25);

  // бумага
  if (info.tier <= 1) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(225,205,160,.35)"; ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.fillStyle = "#e9dfc6";
    for (const [x, y, dx, dy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx * 46, y); ctx.lineTo(x, y + dy * 46); ctx.closePath(); ctx.fill();
    }
  }
  if (info.tier >= 2) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0.18, "rgba(255,255,255,0)"); g.addColorStop(0.3, "rgba(255,255,255,.26)"); g.addColorStop(0.42, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  if (info.tier >= 4) {
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = rainbow(ctx, 0.35); ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (info.tier >= 5) {
    ctx.save();
    ctx.translate(0, 0); ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = "#c8302c"; ctx.fillRect(-200, 120, 400, 54);
    ctx.fillStyle = "#fff"; ctx.font = '30px "Russo One", sans-serif'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("ВАРИАНТ", 0, 148);
    ctx.restore();
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  return cv;
}
