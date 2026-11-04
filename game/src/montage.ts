// Монтаж: короткая запись кадра из YAML (shot) и события забега превращаются в кадры страницы.

import { C, type Shot } from "./content";
import type { Actor, Bubble, Panel } from "./page";
import type { BattleResult } from "./battle";

export interface Scene { bg: string; ally?: string }

function closer(bg: string, shot: string) {
  if (!["talk", "close", "item"].includes(shot)) return bg;
  const [loc, v = ""] = bg.split("/");
  return v === "day_wide" ? `${loc}/day_close` : bg;
}

function other(who: string, pose: string | undefined, shot: string, x: number, flip: boolean): Actor {
  if (who.startsWith("enemy:")) {
    const id = who.slice(6);
    const f = C.enemies[id]?.frame || { h: 0.7, y: 0.97 };
    const k = shot === "talk" ? 1.55 : 1;
    return { who, pose: pose || "stand", x, h: f.h * k, y: shot === "talk" ? f.y + 0.45 * f.h : f.y, flip };
  }
  if (shot === "talk") return { who, pose: pose || "talk", x, y: 1.5, h: 1.3, flip };
  return { who, pose: pose || "idle", x, y: 0.97, h: 0.62, flip };
}

/** Кадр из короткой записи. */
export function shotPanel(s: Shot, sc: Scene): Panel {
  const shot = s.shot || "wide";
  const bg = closer(s.bg || sc.bg, shot);
  const actors: Actor[] = [];
  const bubbles: Bubble[] = [];
  const p: Panel = { bg, caption: s.caption, sfx: s.sfx, title: s.title, actors, bubbles };
  const hero = (a: Partial<Actor>) => { actors.push({ who: "hero", pose: s.hero, face: s.face, x: 0.45, ...a, ...(s.hero ? { pose: s.hero } : {}) }); return actors.length - 1; };
  switch (shot) {
    case "wide": {
      if (sc.ally && !s.with) actors.push({ who: `npc:${sc.ally}`, pose: "idle", x: 0.22, y: 0.97, h: 0.58 });
      const hi = hero({ pose: "idle", x: s.with ? 0.32 : 0.5, y: 0.97, h: 0.62 });
      if (s.with) actors.push(other(s.with, s.with_pose, shot, 0.74, true));
      if (s.say) bubbles.push({ text: s.say, to: hi });
      if (s.think) bubbles.push({ text: s.think, to: hi, kind: "think" });
      break;
    }
    case "two": {
      if (sc.ally) actors.push({ who: `npc:${sc.ally}`, pose: "idle", x: 0.13, y: 0.97, h: 0.56 });
      hero({ pose: "idle", x: sc.ally ? 0.33 : 0.3, y: 0.97, h: 0.62 });
      if (s.with) actors.push(other(s.with, s.with_pose, shot, 0.74, true));
      break;
    }
    case "talk": {
      const hi = hero({ pose: "talk", x: 0.27, y: 1.5, h: 1.3 });
      let oi = -1;
      if (s.with) { actors.push(other(s.with, s.with_pose, shot, 0.75, true)); oi = actors.length - 1; }
      if (s.hero_says) bubbles.push({ text: s.hero_says, to: hi });
      if (s.they_say && oi >= 0) bubbles.push({ text: s.they_say, to: oi });
      break;
    }
    case "close": {
      const hi = hero({ pose: "think", x: 0.42, y: 1.55, h: 1.35 });
      if (s.say) bubbles.push({ text: s.say, to: hi });
      if (s.think) bubbles.push({ text: s.think, to: hi, kind: "think" });
      break;
    }
    case "fight": {
      hero({ pose: "fight", x: 0.3, y: 1.0, h: 0.84 });
      if (s.with) actors.push(other(s.with, s.with_pose || "hit", shot, 0.72, true));
      if (s.say) bubbles.push({ text: s.say, to: 0 });
      break;
    }
    case "item": {
      if (s.hero) { hero({ pose: s.hero, x: 0.24, y: 1.2, h: 1.0 }); p.props = [{ id: s.prop || "", x: 0.66, y: 0.58, s: 0.5, rot: -8 }]; }
      else p.props = [{ id: s.prop || "", x: 0.5, y: 0.58, s: 0.6, rot: -6 }];
      break;
    }
    case "closeup": {
      p.bg = undefined;
      p.closeup = s.closeup;
      break;
    }
  }
  return p;
}

// --- бой -----------------------------------------------------------------------------------

/** Бой на 5 раундов становится 2–3 кадрами: столкновение, лучший момент, итог. */
export function battlePanels(r: BattleResult, sc: Scene): Panel[] {
  const b = r.battle;
  const id = b.enemyId, title = b.def.title;
  const who = `enemy:${id}`;
  const firstSfx = b.def.sfx?.[0] || "БАХ!";
  const out: Panel[] = [];
  out.push({
    bg: sc.bg, sfx: firstSfx, caption: `${title}!`,
    actors: [{ who: "hero", pose: "fight", face: "anger", x: 0.3, y: 1.0, h: 0.84 }, other(who, "attack", "fight", 0.72, true)],
  });
  const best = [...b.log].sort((x, y) => y.dealt - x.dealt)[0];
  if (b.log.length >= 3 && best && best.dealt > 0) {
    const ev = best.events.filter((e) => e.kind === "chip" && e.dmg).sort((x, y) => (y.dmg || 0) - (x.dmg || 0))[0];
    const knocked = b.knocked.length ? ` ${C.items[b.knocked[0]]?.title || "Вещь"} слетает!` : "";
    out.push({
      bg: closer(sc.bg, "talk"), sfx: ev?.sfx || "БАХ!", crossed: r.redrawn,
      caption: `Каскад: ${best.dealt} урона.${knocked}`,
      actors: [{ who: "hero", pose: "fight", face: "anger", x: 0.3, y: 1.0, h: 0.9 }, other(who, "hit", "fight", 0.7, true)],
    });
  }
  if (r.win) {
    out.push({
      bg: sc.bg, caption: r.kept ? `${title} повержен. Трофей: «${r.kept}».` : `${title} повержен.`,
      actors: [
        ...(sc.ally ? [{ who: `npc:${sc.ally}`, pose: "cross", x: 0.14, y: 0.97, h: 0.56 } as Actor] : []),
        { who: "hero", pose: "victory", face: "joy", x: sc.ally ? 0.36 : 0.32, y: 0.97, h: 0.66 },
        other(who, "defeated", "two", 0.74, true),
      ],
    });
  } else {
    out.push({
      bg: sc.bg, caption: `${title} оказался сильнее.`,
      actors: [{ who: "hero", pose: "shock", face: "tired", x: 0.32, y: 1.0, h: 0.7 }, other(who, "stand", "two", 0.72, true)],
    });
  }
  return out;
}

export function lootPanel(item: string, sc: Scene): Panel {
  const title = C.items[item]?.title || C.slammers[item]?.title || item;
  const pose = C.slammers[item] ? "fight" : "victory";
  return {
    bg: closer(sc.bg, "close"), caption: `Новая вещь: ${title.toLowerCase()}.`,
    actors: [{ who: "hero", pose, face: "joy", x: 0.5, y: 1.05, h: 0.82 }],
  };
}
